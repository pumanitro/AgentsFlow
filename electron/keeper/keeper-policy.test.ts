import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { DeferredMarker, KeeperConvState, KillLogEntry } from '../../shared/types';
import type { ClaudeAgentJsonRow } from '../claude-cli';
import {
  CONTINUE_TEXT, DEAD_CONFIRM_TICKS, IDLE_CONFIRM_MS, MAX_NUDGES_PER_HOUR, NUDGE_COOLDOWN_MS,
  decide, hhmm, isIdle, isQuestion, killedText, memoryFreeText, nudgesLeft,
  type ChatFacts,
} from './keeper-policy';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
// One chat, described the way keeper.ts describes it every tick. The default
// is the walking-skeleton case: an "Until done" chat whose process is running,
// has been idle for two minutes, and last said something that is neither a
// question nor "finished" — i.e. the one the Keeper should type "continue" into.

const NOW = Date.parse('2026-10-11T09:41:00.000Z');
const SID = 'abc12345-0000-4000-8000-000000000001';

function row(over: Partial<ClaudeAgentJsonRow> = {}): ClaudeAgentJsonRow {
  return { pid: 4242, cwd: '/tmp/proj', kind: 'bg', startedAt: NOW - 600_000, sessionId: SID, status: 'idle', ...over };
}

function facts(over: Partial<ChatFacts> = {}, conv: Partial<ChatFacts['conv']> = {}): ChatFacts {
  return {
    conv: {
      id: 'c1', state: 'working', status: 'idle', pinned: true, provider: undefined, host: undefined,
      sessionId: SID, daemonShort: 'abc12345', contract: 'until-done', keeper: undefined, ...conv,
    },
    liveRow: row(),
    liveRowsFresh: true,
    deadTicks: 0,
    walled: false,
    lastAssistantText: 'step 1 done.',
    declaredDone: false,
    hasScheduledWakeup: false,
    idleSinceMs: NOW - 2 * 60_000,
    pendingDeferred: [],
    pendingKills: [],
    memLevel: 'ok',
    now: NOW,
    ...over,
  };
}

function marker(over: Partial<DeferredMarker> = {}): DeferredMarker {
  return {
    schema: 1, at: new Date(NOW - 5 * 60_000).toISOString(), sessionId: SID, cwd: '/tmp/proj', transcriptPath: '/tmp/t.jsonl',
    toolName: 'Agent', what: 'spawn: probe', reason: 'memory is tight', availGB: 5, state: 'critical', ...over,
  };
}

function kill(over: Partial<KillLogEntry> = {}): KillLogEntry {
  return {
    at: new Date(NOW - 3 * 60_000).toISOString(), by: 'memguard-system', kind: 'process-group', name: 'vitest', dry: false,
    reason: 'critical', family: 'vitest', ...over,
  };
}

function nudged(count: number, lastAgoMs: number): KeeperConvState {
  // `count` nudges inside the hour, the newest `lastAgoMs` ago.
  const nudgesAt = Array.from({ length: count }, (_, i) => NOW - lastAgoMs - i * 6 * 60_000).reverse();
  return { nudgesAt, lastNudgeAt: new Date(NOW - lastAgoMs).toISOString(), lastNudgeReason: 'stopped-short' };
}

// ---------------------------------------------------------------------------
// The decision order — one test per line
// ---------------------------------------------------------------------------

test('a Codex chat is not the Keeper\'s to touch', () => {
  assert.deepEqual(decide(facts({}, { provider: 'codex' })), { action: 'none', why: 'codex' });
});

test('a chat on a remote peer is left alone', () => {
  assert.deepEqual(decide(facts({}, { host: 'me@box' })), { action: 'none', why: 'remote' });
});

test('a chat with no session id has nothing to resume', () => {
  assert.deepEqual(decide(facts({}, { sessionId: '' })), { action: 'none', why: 'no-session' });
});

test('walled ⇒ none: limit-watch owns a rate-limited chat', () => {
  assert.deepEqual(decide(facts({ walled: true })), { action: 'none', why: 'walled' });
});

test('walled wins even over a pending question or a dead daemon', () => {
  assert.equal(decide(facts({ walled: true, lastAssistantText: 'Which one?' })).action, 'none');
  assert.equal(decide(facts({ walled: true, liveRow: null, deadTicks: 5 })).action, 'none');
});

test('busy ⇒ none: working is the contract being met', () => {
  assert.deepEqual(decide(facts({ liveRow: row({ status: 'busy' }) })), { action: 'none', why: 'busy' });
});

test('busy wins over a question left in the transcript from the previous turn', () => {
  const d = decide(facts({ liveRow: row({ status: 'busy' }), lastAssistantText: 'Should I go on?' }));
  assert.deepEqual(d, { action: 'none', why: 'busy' });
});

test('state blocked ⇒ stalled, never a nudge', () => {
  assert.deepEqual(decide(facts({}, { state: 'blocked' })), { action: 'stalled', why: 'blocked' });
  assert.deepEqual(decide(facts({ liveRow: row({ state: 'blocked' }) })), { action: 'stalled', why: 'blocked' });
});

test('status waiting (a permission prompt) ⇒ stalled', () => {
  const d = decide(facts({ liveRow: row({ status: 'waiting', waitingFor: 'permission prompt' }) }, { status: 'waiting' }));
  assert.deepEqual(d, { action: 'stalled', why: 'waiting' });
});

test('question text ⇒ stalled with zero nudges, however long it has been idle', () => {
  const d = decide(facts({ lastAssistantText: 'I can do A or B.\n\nWhich would you like?', idleSinceMs: NOW - 60 * 60_000 }));
  assert.deepEqual(d, { action: 'stalled', why: 'question' });
});

test('a stall beats a pending deferred retry and a pending kill', () => {
  const d = decide(facts({ lastAssistantText: 'Do you want me to retry?', pendingDeferred: [marker()], pendingKills: [kill()] }));
  assert.equal(d.action, 'stalled');
});

test('once + deferred ⇒ nudge even though the contract is once', () => {
  const m = marker();
  const d = decide(facts({ pendingDeferred: [m] }, { contract: 'once' }));
  assert.deepEqual(d, {
    action: 'nudge',
    cause: 'memory-deferred',
    text: `Memory is free again — retry the step that was deferred at ${hhmm(Date.parse(m.at))} (spawn: probe).`,
    consumeDeferred: [m.at],
    consumeKills: 0,
  });
});

test('several deferred markers are consumed by one nudge', () => {
  const a = marker({ at: new Date(NOW - 9 * 60_000).toISOString(), what: 'spawn: first' });
  const b = marker({ at: new Date(NOW - 4 * 60_000).toISOString(), what: 'spawn: second' });
  const d = decide(facts({ pendingDeferred: [a, b] }, { contract: undefined }));
  assert.equal(d.action, 'nudge');
  if (d.action !== 'nudge') return;
  assert.deepEqual(d.consumeDeferred, [a.at, b.at]);
  assert.match(d.text, /deferred at \d\d:\d\d \(spawn: first, and 1 more\)\.$/);
});

test('deferred while memory is still tight ⇒ no retry yet', () => {
  for (const memLevel of ['warn', 'closed', 'critical', 'unknown'] as const) {
    const d = decide(facts({ pendingDeferred: [marker()], memLevel }, { contract: 'once' }));
    assert.deepEqual(d, { action: 'none', why: 'once' }, memLevel);
  }
});

test('deferred but the chat is not idle (no process) ⇒ no retry typed', () => {
  const d = decide(facts({ pendingDeferred: [marker()], liveRow: null }, { contract: 'once' }));
  assert.deepEqual(d, { action: 'none', why: 'once' });
});

test('a killed process group ⇒ nudge killed-workload, consuming every pending kill', () => {
  const k = kill();
  const d = decide(facts({ pendingKills: [k, kill({ at: new Date(NOW - 60_000).toISOString(), name: 'tsc', family: 'tsc' })] }, { contract: 'once' }));
  assert.equal(d.action, 'nudge');
  if (d.action !== 'nudge') return;
  assert.equal(d.cause, 'killed-workload');
  assert.equal(d.consumeKills, 2);
  assert.deepEqual(d.consumeDeferred, []);
  assert.ok(d.text.startsWith(`Your vitest run was stopped at ${hhmm(Date.parse(k.at))} to protect the machine's memory — rerun it.`));
  assert.match(d.text, /Your tsc run was stopped at/);
});

test('a stopped container ⇒ the nudge says how to bring it back', () => {
  const k = kill({ by: 'peersflow-guard', kind: 'container', name: 'postgres-arrow', family: undefined });
  const d = decide(facts({ pendingKills: [k] }));
  assert.equal(d.action, 'nudge');
  if (d.action !== 'nudge') return;
  assert.equal(d.text, `The container postgres-arrow was stopped at ${hhmm(Date.parse(k.at))} to free memory — run \`docker start postgres-arrow\` and retry.`);
});

test('memory-deferred is handled before killed-workload', () => {
  const d = decide(facts({ pendingDeferred: [marker()], pendingKills: [kill()] }));
  assert.equal(d.action === 'nudge' && d.cause, 'memory-deferred');
});

test('contract once ⇒ none', () => {
  assert.deepEqual(decide(facts({}, { contract: 'once' })), { action: 'none', why: 'once' });
});

test('no contract at all reads as once', () => {
  assert.deepEqual(decide(facts({}, { contract: undefined })), { action: 'none', why: 'once' });
});

test('until-done + declared done ⇒ completed', () => {
  const d = decide(facts({ declaredDone: true, lastAssistantText: 'All tasks are done.' }));
  assert.deepEqual(d, { action: 'completed', why: 'declared-done' });
});

test('forever has no finish line: declared done is just another stop', () => {
  const d = decide(facts({ declaredDone: true, lastAssistantText: 'All tasks are done.' }, { contract: 'forever' }));
  assert.equal(d.action === 'nudge' && d.cause, 'stopped-short');
});

test('an until-done chat already past its finish line is left alone', () => {
  const d = decide(facts({}, { keeper: { nudgesAt: [], completedAt: new Date(NOW - 60_000).toISOString() } }));
  assert.deepEqual(d, { action: 'none', why: 'already-completed' });
});

test('dead + stale rows ⇒ none: an old listing proves nothing', () => {
  const d = decide(facts({ liveRow: null, liveRowsFresh: false, deadTicks: 9 }));
  assert.deepEqual(d, { action: 'none', why: 'rows-stale' });
});

test('dead + fresh rows once ⇒ none yet', () => {
  const d = decide(facts({ liveRow: null, deadTicks: DEAD_CONFIRM_TICKS - 1 }));
  assert.deepEqual(d, { action: 'none', why: 'dead-unconfirmed' });
});

test('dead + fresh rows twice ⇒ relaunch with "continue"', () => {
  for (const contract of ['until-done', 'forever'] as const) {
    const d = decide(facts({ liveRow: null, deadTicks: DEAD_CONFIRM_TICKS }, { contract, state: 'done', status: '' }));
    assert.deepEqual(d, { action: 'relaunch', cause: 'daemon-dead', prompt: CONTINUE_TEXT }, contract);
  }
});

test('a dead once chat is never relaunched', () => {
  const d = decide(facts({ liveRow: null, deadTicks: 9 }, { contract: 'once' }));
  assert.deepEqual(d, { action: 'none', why: 'once' });
});

test('a dead until-done chat that had declared done is completed, not relaunched', () => {
  const d = decide(facts({ liveRow: null, deadTicks: 9, declaredDone: true }));
  assert.equal(d.action, 'completed');
});

test('forever + hasCron idle ⇒ none: it armed its own alarm clock', () => {
  const d = decide(facts({ hasScheduledWakeup: true, idleSinceMs: NOW - 30 * 60_000 }, { contract: 'forever' }));
  assert.deepEqual(d, { action: 'none', why: 'scheduled-wakeup' });
});

test('forever + hasCron but the daemon is dead ⇒ still relaunched (a dead process fires no cron)', () => {
  const d = decide(facts({ hasScheduledWakeup: true, liveRow: null, deadTicks: 2 }, { contract: 'forever' }));
  assert.equal(d.action, 'relaunch');
});

test('a scheduled wake-up does not excuse an until-done chat', () => {
  const d = decide(facts({ hasScheduledWakeup: true }));
  assert.equal(d.action, 'nudge');
});

test('idle for less than the confirm window ⇒ none', () => {
  const d = decide(facts({ idleSinceMs: NOW - (IDLE_CONFIRM_MS - 1) }));
  assert.deepEqual(d, { action: 'none', why: 'idle-unconfirmed' });
  assert.deepEqual(decide(facts({ idleSinceMs: null })), { action: 'none', why: 'idle-unconfirmed' });
});

test('idle past the confirm window ⇒ nudge stopped-short with "continue"', () => {
  const d = decide(facts({ idleSinceMs: NOW - IDLE_CONFIRM_MS }));
  assert.deepEqual(d, { action: 'nudge', cause: 'stopped-short', text: 'continue', consumeDeferred: [], consumeKills: 0 });
});

test('a settled state with a live row counts as idle', () => {
  const f = facts({ liveRow: row({ status: undefined }) }, { state: 'done', status: '' });
  assert.equal(isIdle(f), true);
  assert.equal(decide(f).action, 'nudge');
  assert.equal(isIdle(facts({ liveRow: null }, { state: 'done' })), false);
  assert.equal(isIdle(facts({ liveRow: row({ status: undefined }) }, { state: 'working' })), false);
});

test('cap: with the hour\'s allowance spent the next nudge ⇒ none \'cap\'', () => {
  const spent = nudged(MAX_NUDGES_PER_HOUR, NUDGE_COOLDOWN_MS + 1_000);
  assert.equal(nudgesLeft(spent, NOW), 0);
  assert.deepEqual(decide(facts({}, { keeper: spent })), { action: 'none', why: 'cap' });
  // One short of the cap, and past the cooldown: still allowed.
  const almost = nudged(MAX_NUDGES_PER_HOUR - 1, NUDGE_COOLDOWN_MS + 1_000);
  assert.equal(nudgesLeft(almost, NOW), 1);
  assert.equal(decide(facts({}, { keeper: almost })).action, 'nudge');
});

test('cooldown: a nudge less than five minutes ago ⇒ none \'cap\'', () => {
  assert.deepEqual(decide(facts({}, { keeper: nudged(1, NUDGE_COOLDOWN_MS - 1_000) })), { action: 'none', why: 'cap' });
  assert.equal(decide(facts({}, { keeper: nudged(1, NUDGE_COOLDOWN_MS) })).action, 'nudge');
});

test('the cap and the cooldown hold back a relaunch too', () => {
  const dead = { liveRow: null, deadTicks: 2 };
  assert.deepEqual(decide(facts(dead, { keeper: nudged(MAX_NUDGES_PER_HOUR, NUDGE_COOLDOWN_MS + 1_000) })), { action: 'none', why: 'cap' });
  assert.deepEqual(decide(facts(dead, { keeper: nudged(1, 60_000) })), { action: 'none', why: 'cap' });
});

test('the cap and the cooldown hold back deferred and killed-workload nudges', () => {
  const recent = nudged(1, 60_000);
  assert.deepEqual(decide(facts({ pendingDeferred: [marker()] }, { keeper: recent })), { action: 'none', why: 'cap' });
  assert.deepEqual(decide(facts({ pendingKills: [kill()] }, { keeper: recent })), { action: 'none', why: 'cap' });
});

test('nudges older than an hour no longer count', () => {
  const old: KeeperConvState = { nudgesAt: Array.from({ length: 6 }, (_, i) => NOW - 61 * 60_000 - i * 1000) };
  assert.equal(nudgesLeft(old, NOW), MAX_NUDGES_PER_HOUR);
  assert.equal(nudgesLeft(undefined, NOW), MAX_NUDGES_PER_HOUR);
  assert.equal(decide(facts({}, { keeper: old })).action, 'nudge');
});

// ---------------------------------------------------------------------------
// The small pure pieces
// ---------------------------------------------------------------------------

test('isQuestion: a trailing question mark on the last non-empty line', () => {
  assert.equal(isQuestion('Done with step 1.\nShall I start step 2?'), true);
  assert.equal(isQuestion('Shall I start step 2?\n\n   \n'), true);
  assert.equal(isQuestion('**Which approach do you prefer?**'), true);
  assert.equal(isQuestion('Why did it fail? Because the port was taken.\nFixed it.'), false);
});

test('isQuestion: asking phrases near the end, without a question mark', () => {
  assert.equal(isQuestion('Two ways forward. Let me know which you prefer.'), true);
  assert.equal(isQuestion('Should I open the PR now, or wait for CI.'), true);
  assert.equal(isQuestion('Tell me which option to take and I will carry on.'), true);
  assert.equal(isQuestion('Do you want the long version.'), true);
});

test('isQuestion: an asking phrase far back in a long message does not count', () => {
  const long = 'Earlier you said: let me know when it is done. ' + 'x'.repeat(400) + '\nstep 1 done.';
  assert.equal(isQuestion(long), false);
  assert.equal(isQuestion('step 1 done.'), false);
  assert.equal(isQuestion(null), false);
  assert.equal(isQuestion(''), false);
});

test('the nudge texts are exactly the agreed sentences', () => {
  assert.equal(memoryFreeText('spawn: probe', '09:41'), 'Memory is free again — retry the step that was deferred at 09:41 (spawn: probe).');
  assert.equal(killedText(kill(), '09:41'), "Your vitest run was stopped at 09:41 to protect the machine's memory — rerun it.");
  assert.equal(
    killedText(kill({ kind: 'container', name: 'postgres-arrow' }), '09:41'),
    'The container postgres-arrow was stopped at 09:41 to free memory — run `docker start postgres-arrow` and retry.',
  );
  assert.equal(CONTINUE_TEXT, 'continue');
});

test('hhmm is local wall-clock time, zero padded', () => {
  assert.equal(hhmm(new Date(2026, 9, 11, 9, 5).getTime()), '09:05');
  assert.equal(hhmm(new Date(2026, 9, 11, 23, 41).getTime()), '23:41');
  assert.equal(hhmm(NaN), '--:--');
});
