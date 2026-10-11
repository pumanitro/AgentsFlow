import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Conversation, KeeperSnapshot, KillLogEntry, MemLevel } from '../../shared/types';
import type { ClaudeAgentJsonRow } from '../claude-cli';
import { PAUSED_NO_HEADROOM, __resetKeeperForTests, attributeKill, getKeeperSnapshot, isKeepable, runKeeperOnce, type KeeperDeps } from './keeper';
import { IDLE_CONFIRM_MS, KEEPER_TICK_MS, MAX_NUDGES_PER_HOUR, NUDGE_COOLDOWN_MS, hhmm } from './keeper-policy';
import type { TranscriptSignals } from './transcript-signals';

// ---------------------------------------------------------------------------
// A fake app
// ---------------------------------------------------------------------------
// Everything the Keeper does to the world goes through KeeperDeps, so the fake
// below IS the world: a store, a process list, a clock, a kill log and a
// deferred-marker directory under the OS temp dir. Nothing here can reach a
// real chat, daemon or ~/.claude.

const T0 = Date.parse('2026-10-11T09:00:00.000Z');
const SID_A = 'aaaa1111-0000-4000-8000-000000000001';
const SID_B = 'bbbb2222-0000-4000-8000-000000000002';

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'a', sessionId: SID_A, daemonShort: 'aaaa1111', sessionName: '', directoryId: 'd', directoryPath: '/Users/demo/proj',
    displayName: 'proj', title: 'Chat A', description: '', pinned: true, state: 'working', status: 'idle', intent: '',
    createdAt: new Date(T0 - 60 * 60_000).toISOString(), lastPrompt: '', contract: 'until-done', contractSource: 'chip',
    ...over,
  };
}

function liveRow(sessionId: string, over: Partial<ClaudeAgentJsonRow> = {}): ClaudeAgentJsonRow {
  return { pid: 100, cwd: '/Users/demo/proj', kind: 'bg', startedAt: T0 - 60 * 60_000, sessionId, status: 'idle', ...over };
}

function signals(over: Partial<TranscriptSignals> = {}): TranscriptSignals {
  return { lastAssistantText: 'step 1 done.', lastAssistantAt: T0 - 60_000, declaredDone: false, hasCron: false, hasLoopCommand: false, openTasks: 0, ...over };
}

interface World {
  deps: KeeperDeps;
  convs: Map<string, Conversation>;
  sig: Map<string, TranscriptSignals | null>;
  rows: ClaudeAgentJsonRow[];
  rowsAt: number;
  now: number;
  headroom: boolean;
  mem: MemLevel;
  walled: Set<string>;
  killLog: KillLogEntry[];
  killOffsets: number[];
  nudgeResult: { ok: boolean; error?: string };
  relaunchResult: { ok: boolean; daemonShort?: string; error?: string };
  updates: Array<{ id: string; patch: Partial<Conversation> }>;
  nudges: Array<{ id: string; text: string }>;
  relaunches: Array<{ id: string; prompt: string }>;
  notes: Array<{ title: string; body: string }>;
  snaps: KeeperSnapshot[];
  signalReads: string[];
  dir: string;
  /** Advance the clock; the process list is re-listed (fresh) unless told otherwise. */
  tick: (ms?: number, opts?: { relist?: boolean }) => Promise<void>;
  keeperOf: (id: string) => Conversation['keeper'];
  cleanup: () => void;
}

function world(initial: Conversation[] = [conv()]): World {
  __resetKeeperForTests();
  const w = {
    convs: new Map(initial.map((c) => [c.id, c])),
    sig: new Map<string, TranscriptSignals | null>(),
    rows: [] as ClaudeAgentJsonRow[],
    rowsAt: T0,
    now: T0,
    headroom: true,
    mem: 'ok' as MemLevel,
    walled: new Set<string>(),
    killLog: [] as KillLogEntry[],
    killOffsets: [] as number[],
    nudgeResult: { ok: true } as { ok: boolean; error?: string },
    relaunchResult: { ok: true, daemonShort: 'cafe0001' } as { ok: boolean; daemonShort?: string; error?: string },
    updates: [] as World['updates'],
    nudges: [] as World['nudges'],
    relaunches: [] as World['relaunches'],
    notes: [] as World['notes'],
    snaps: [] as KeeperSnapshot[],
    signalReads: [] as string[],
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-loop-')),
  } as World;
  w.deps = {
    getConversations: () => Array.from(w.convs.values()),
    getConversation: (id) => w.convs.get(id) ?? null,
    updateConversation: (id, patch) => {
      w.updates.push({ id, patch });
      const prev = w.convs.get(id);
      if (prev) w.convs.set(id, { ...prev, ...patch });
    },
    liveRows: () => ({ rows: w.rows, at: w.rowsAt }),
    jobQuietAt: () => 0,
    isWalled: (c) => w.walled.has(c.id),
    poolHasHeadroom: async () => w.headroom,
    memLevel: () => w.mem,
    // The kill log as a list; the "byte offset" is simply how many were read.
    readKillsSince: (offset) => {
      w.killOffsets.push(offset);
      return { entries: w.killLog.slice(offset), offset: w.killLog.length };
    },
    nudge: async (c, text) => { w.nudges.push({ id: c.id, text }); return w.nudgeResult; },
    relaunch: async (c, prompt) => { w.relaunches.push({ id: c.id, prompt }); return w.relaunchResult; },
    notify: (title, body) => { w.notes.push({ title, body }); },
    onSnapshot: (s) => { w.snaps.push(s); },
    now: () => w.now,
    readSignals: (c) => { w.signalReads.push(c.id); return w.sig.has(c.id) ? w.sig.get(c.id)! : signals(); },
    deferredDir: w.dir,
  };
  w.tick = async (ms = 0, opts = {}) => {
    w.now += ms;
    if (opts.relist !== false) w.rowsAt = w.now;
    await runKeeperOnce(w.deps);
  };
  w.keeperOf = (id) => w.convs.get(id)?.keeper;
  w.cleanup = () => { fs.rmSync(w.dir, { recursive: true, force: true }); __resetKeeperForTests(); };
  return w;
}

function putMarker(w: World, sessionId: string, at: number, what = 'spawn: probe'): string {
  const file = path.join(w.dir, `${sessionId.slice(0, 8)}-${at}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schema: 1, at: new Date(at).toISOString(), sessionId, cwd: '/Users/demo/proj', transcriptPath: '/tmp/t.jsonl',
    toolName: 'Agent', what, reason: 'memory is tight', availGB: 5, state: 'critical',
  }));
  return file;
}

function killEntry(over: Partial<KillLogEntry> = {}): KillLogEntry {
  return { at: new Date(T0 - 60_000).toISOString(), by: 'memguard-system', kind: 'process-group', name: 'vitest', dry: false, reason: 'critical', family: 'vitest', ...over };
}

// ---------------------------------------------------------------------------
// The walking skeleton: an idle Until-done chat gets "continue"
// ---------------------------------------------------------------------------

test('an idle until-done chat is nudged "continue" once it has been idle for the confirm window', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  await w.tick();
  assert.equal(w.nudges.length, 0, 'first sight of idle is not yet a stop');
  await w.tick(KEEPER_TICK_MS);
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 0, '60 s idle: still inside the confirm window');
  await w.tick(KEEPER_TICK_MS);
  assert.ok(3 * KEEPER_TICK_MS >= IDLE_CONFIRM_MS);
  assert.deepEqual(w.nudges, [{ id: 'a', text: 'continue' }]);
  const k = w.keeperOf('a');
  assert.equal(k?.lastNudgeReason, 'stopped-short');
  assert.equal(k?.lastNudgeAt, new Date(w.now).toISOString());
  assert.deepEqual(k?.nudgesAt, [w.now]);
  assert.equal(k?.keptAlive, true);
  const snap = getKeeperSnapshot();
  assert.equal(snap.enabled, true);
  assert.equal(snap.recent.length, 1);
  assert.deepEqual({ ...snap.recent[0], at: '' }, { at: '', conversationId: 'a', title: 'Chat A', cause: 'stopped-short', ok: true, detail: 'typed: continue' });
  assert.equal(snap.items[0].status, 'kept-alive');
  assert.equal(snap.items[0].nudgesLeftThisHour, MAX_NUDGES_PER_HOUR - 1);
  w.cleanup();
});

test('a busy chat is never nudged, and going busy restarts the idle clock', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  await w.tick();
  await w.tick(60_000);
  w.rows = [liveRow(SID_A, { status: 'busy' })];
  await w.tick(KEEPER_TICK_MS);
  w.rows = [liveRow(SID_A)];
  await w.tick(KEEPER_TICK_MS);          // idle again: the clock starts here
  await w.tick(60_000);
  assert.equal(w.nudges.length, 0);
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 1);
  w.cleanup();
});

test('a turn that ran between two ticks (state.json touched) restarts the idle clock', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  let quietAt = 0;
  w.deps.jobQuietAt = () => quietAt;
  await w.tick();
  quietAt = w.now + 80_000;
  await w.tick(100_000);
  assert.equal(w.nudges.length, 0, 'idle for 100 s by the row, but the job wrote 20 s ago');
  await w.tick(80_000);
  assert.equal(w.nudges.length, 1);
  w.cleanup();
});

test('after a nudge the cooldown holds, then it may nudge again', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  await w.tick();
  await w.tick(IDLE_CONFIRM_MS);
  assert.equal(w.nudges.length, 1);
  await w.tick(NUDGE_COOLDOWN_MS - KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 1, 'still idle, but inside the cooldown');
  assert.match(getKeeperSnapshot().items[0].detail, /^nudged at \d\d:\d\d — waiting 5 minutes/);
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 2);
  w.cleanup();
});

test('the hourly cap stops a chat that keeps stopping', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  await w.tick();
  for (let i = 0; i < 10; i++) await w.tick(NUDGE_COOLDOWN_MS);
  assert.equal(w.nudges.length, MAX_NUDGES_PER_HOUR);
  const item = getKeeperSnapshot().items[0];
  assert.equal(item.nudgesLeftThisHour, 0);
  assert.match(item.detail, /giving it a rest/);
  w.cleanup();
});

// ---------------------------------------------------------------------------
// One action per pass · persist only on change · snapshot only on change
// ---------------------------------------------------------------------------

test('one action per pass: two chats ready at once are nudged on consecutive passes', async () => {
  const w = world([conv(), conv({ id: 'b', sessionId: SID_B, daemonShort: 'bbbb2222', title: 'Chat B' })]);
  w.rows = [liveRow(SID_A), liveRow(SID_B, { pid: 200 })];
  await w.tick();
  await w.tick(IDLE_CONFIRM_MS);
  assert.equal(w.nudges.length, 1);
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 2);
  assert.deepEqual(w.nudges.map((n) => n.id).sort(), ['a', 'b']);
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 2, 'both are now inside their cooldown');
  w.cleanup();
});

test('a relaunch and a nudge never share a pass either', async () => {
  const w = world([conv(), conv({ id: 'b', sessionId: SID_B, daemonShort: 'bbbb2222', title: 'Chat B', state: 'done', status: '' })]);
  w.rows = [liveRow(SID_A)];
  await w.tick();
  await w.tick(IDLE_CONFIRM_MS);
  assert.equal(w.nudges.length + w.relaunches.length, 1);
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 1);
  assert.equal(w.relaunches.length, 1);
  w.cleanup();
});

test('keeper state is persisted only when it changes', async () => {
  const w = world();
  w.rows = [liveRow(SID_A, { status: 'busy' })];
  await w.tick();
  assert.equal(w.updates.length, 1, 'first pass marks it kept alive');
  assert.deepEqual(w.updates[0], { id: 'a', patch: { keeper: { nudgesAt: [], stalled: null, keptAlive: true } } });
  for (let i = 0; i < 5; i++) await w.tick(KEEPER_TICK_MS);
  assert.equal(w.updates.length, 1, 'five identical passes write nothing');
  w.cleanup();
});

test('a chat the Keeper has no business with is never written to', async () => {
  const w = world([conv({ contract: 'once' }), conv({ id: 'b', sessionId: SID_B, daemonShort: 'bbbb2222', contract: undefined, contractSource: undefined })]);
  w.rows = [liveRow(SID_A), liveRow(SID_B, { pid: 200 })];
  w.sig.set('b', signals({ lastAssistantText: 'Which one do you want?' }));
  for (let i = 0; i < 4; i++) await w.tick(60_000);
  assert.equal(w.updates.length, 0);
  assert.equal(w.notes.length, 0, 'a plain chat asking a question is not the Keeper\'s to announce');
  assert.equal(w.nudges.length, 0);
  assert.deepEqual(getKeeperSnapshot().items, []);
  w.cleanup();
});

test('the snapshot is pushed only when it changes', async () => {
  const w = world();
  w.rows = [liveRow(SID_A, { status: 'busy' })];
  await w.tick();
  assert.equal(w.snaps.length, 1);
  for (let i = 0; i < 5; i++) await w.tick(KEEPER_TICK_MS);
  assert.equal(w.snaps.length, 1, 'nothing changed, nothing pushed');
  w.rows = [liveRow(SID_A)];
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.snaps.length, 2, 'busy → idle changes the card');
  assert.equal(getKeeperSnapshot(), w.snaps[1]);
  w.cleanup();
});

// ---------------------------------------------------------------------------
// Paused
// ---------------------------------------------------------------------------

test('paused when no account has headroom: no nudges, but stalled badges still update', async () => {
  const w = world([conv(), conv({ id: 'b', sessionId: SID_B, daemonShort: 'bbbb2222', title: 'Chat B' })]);
  w.rows = [liveRow(SID_A), liveRow(SID_B, { pid: 200 })];
  w.sig.set('b', signals({ lastAssistantText: 'Should I delete the old table?', lastAssistantAt: T0 - 30_000 }));
  w.headroom = false;
  await w.tick();
  await w.tick(IDLE_CONFIRM_MS);
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 0);
  const snap = getKeeperSnapshot();
  assert.equal(snap.paused, PAUSED_NO_HEADROOM);
  assert.equal(snap.paused, 'every account is at its limit');
  assert.equal(snap.items.find((i) => i.conversationId === 'a')?.detail, 'on hold — every account is at its limit');
  assert.equal(snap.items.find((i) => i.conversationId === 'b')?.status, 'stalled');
  assert.equal(w.keeperOf('b')?.stalled, `asked you a question at ${hhmm(T0 - 30_000)}`);
  w.headroom = true;
  await w.tick(KEEPER_TICK_MS);
  assert.equal(getKeeperSnapshot().paused, null);
  assert.deepEqual(w.nudges, [{ id: 'a', text: 'continue' }]);
  w.cleanup();
});

test('a usage meter that throws does not pause the Keeper', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  w.deps.poolHasHeadroom = async () => { throw new Error('429'); };
  await w.tick();
  await w.tick(IDLE_CONFIRM_MS);
  assert.equal(getKeeperSnapshot().paused, null);
  assert.equal(w.nudges.length, 1);
  w.cleanup();
});

// ---------------------------------------------------------------------------
// Stalled
// ---------------------------------------------------------------------------

test('a chat that asked a question is badged stalled, notified once, and never nudged', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  w.sig.set('a', signals({ lastAssistantText: 'A or B — which one?', lastAssistantAt: T0 - 5_000 }));
  for (let i = 0; i < 8; i++) await w.tick(60_000);
  assert.equal(w.nudges.length, 0);
  assert.equal(w.notes.length, 1);
  assert.equal(w.notes[0].title, '“Chat A” is waiting for you');
  const stall = `asked you a question at ${hhmm(T0 - 5_000)}`;
  assert.equal(w.keeperOf('a')?.stalled, stall);
  assert.equal(w.keeperOf('a')?.keptAlive, false);
  assert.deepEqual(getKeeperSnapshot().items.map((i) => [i.status, i.detail]), [['stalled', stall]]);
  // A NEW question is a new stall: one more notification.
  w.sig.set('a', signals({ lastAssistantText: 'And then: C or D?', lastAssistantAt: w.now + 61 * 60_000 }));
  await w.tick(62 * 60_000);
  await w.tick(60_000);
  assert.equal(w.notes.length, 2);
  w.cleanup();
});

test('a stall already on the row (announced before a restart) is not announced again', async () => {
  const stall = `asked you a question at ${hhmm(T0 - 5_000)}`;
  const w = world([conv({ keeper: { nudgesAt: [], stalled: stall, keptAlive: false } })]);
  w.rows = [liveRow(SID_A)];
  w.sig.set('a', signals({ lastAssistantText: 'A or B — which one?', lastAssistantAt: T0 - 5_000 }));
  await w.tick();
  await w.tick(60_000);
  assert.equal(w.notes.length, 0);
  assert.equal(w.updates.length, 0);
  w.cleanup();
});

test('a permission prompt is a stall that names what it waits for', async () => {
  const w = world([conv({ status: 'waiting' })]);
  w.rows = [liveRow(SID_A, { status: 'waiting', waitingFor: 'permission prompt' })];
  await w.tick();
  assert.equal(w.keeperOf('a')?.stalled, 'waiting for you (permission prompt)');
  assert.equal(w.nudges.length, 0);
  w.cleanup();
});

test('the stalled badge clears when the chat moves on', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  w.sig.set('a', signals({ lastAssistantText: 'Which one?' }));
  await w.tick();
  assert.ok(w.keeperOf('a')?.stalled);
  w.rows = [liveRow(SID_A, { status: 'busy' })];
  w.sig.set('a', signals({ lastAssistantText: 'Going with B.' }));
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.keeperOf('a')?.stalled, null);
  assert.equal(w.keeperOf('a')?.keptAlive, true);
  w.cleanup();
});

test('a walled chat is left to limit-watch', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  w.walled.add('a');
  for (let i = 0; i < 4; i++) await w.tick(60_000);
  assert.equal(w.nudges.length, 0);
  assert.match(getKeeperSnapshot().items[0].detail, /usage limit/);
  w.cleanup();
});

// ---------------------------------------------------------------------------
// Completion and re-arm
// ---------------------------------------------------------------------------

test('an until-done chat that declares it is finished is completed, not nudged', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  w.sig.set('a', signals({ lastAssistantText: 'All tasks are done.', declaredDone: true }));
  for (let i = 0; i < 4; i++) await w.tick(60_000);
  assert.equal(w.nudges.length, 0);
  assert.equal(w.keeperOf('a')?.completedAt, new Date(T0 + 60_000).toISOString());
  assert.equal(w.keeperOf('a')?.keptAlive, false);
  assert.deepEqual(getKeeperSnapshot().items, [], 'a finished chat has left the Keeper\'s care');
  assert.equal(w.updates.length, 1, 'completed once, then nothing more to write');
  w.cleanup();
});

test('re-arm: a completed chat that works again is kept alive again', async () => {
  const doneAt = T0 - 10 * 60_000;
  const w = world([conv({ keeper: { nudgesAt: [], keptAlive: false, completedAt: new Date(doneAt).toISOString() } })]);
  w.rows = [liveRow(SID_A)];
  w.sig.set('a', signals({ lastAssistantText: 'All tasks are done.', declaredDone: true, lastAssistantAt: doneAt - 1_000 }));
  await w.tick();
  await w.tick(IDLE_CONFIRM_MS);
  assert.equal(w.nudges.length, 0, 'nothing new since it finished: stays finished');
  assert.equal(w.updates.length, 0);
  // The user gives it more to do; it stops short of the new finish line.
  w.sig.set('a', signals({ lastAssistantText: 'Started on the follow-up.', lastAssistantAt: w.now + 1_000 }));
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.keeperOf('a')?.completedAt, undefined);
  assert.equal(w.keeperOf('a')?.keptAlive, true);
  await w.tick(IDLE_CONFIRM_MS);
  assert.deepEqual(w.nudges, [{ id: 'a', text: 'continue' }]);
  w.cleanup();
});

test('re-arm then finished again: a new completedAt is stamped', async () => {
  const doneAt = T0 - 10 * 60_000;
  const w = world([conv({ keeper: { nudgesAt: [], completedAt: new Date(doneAt).toISOString() } })]);
  w.rows = [liveRow(SID_A)];
  w.sig.set('a', signals({ lastAssistantText: 'Follow-up finished. All tasks are done.', declaredDone: true, lastAssistantAt: T0 - 1_000 }));
  await w.tick();
  assert.equal(w.keeperOf('a')?.completedAt, new Date(T0).toISOString());
  assert.equal(w.nudges.length, 0);
  w.cleanup();
});

test('switching a completed chat to forever drops the finish line', async () => {
  const w = world([conv({ contract: 'forever', keeper: { nudgesAt: [], completedAt: new Date(T0 - 60_000).toISOString() } })]);
  w.rows = [liveRow(SID_A)];
  await w.tick();
  assert.equal(w.keeperOf('a')?.completedAt, undefined);
  await w.tick(IDLE_CONFIRM_MS);
  assert.equal(w.nudges.length, 1);
  w.cleanup();
});

// ---------------------------------------------------------------------------
// Contract inference
// ---------------------------------------------------------------------------

test('an undeclared running chat that armed a cron is written once as forever/inferred', async () => {
  const w = world([conv({ contract: undefined, contractSource: undefined })]);
  w.rows = [liveRow(SID_A)];
  w.sig.set('a', signals({ hasCron: true }));
  for (let i = 0; i < 5; i++) await w.tick(60_000);
  const writes = w.updates.filter((u) => 'contract' in u.patch);
  assert.deepEqual(writes, [{ id: 'a', patch: { contract: 'forever', contractSource: 'inferred' } }]);
  assert.equal(w.nudges.length, 0, 'forever with its own alarm clock sleeps undisturbed');
  const item = getKeeperSnapshot().items[0];
  assert.deepEqual([item.contract, item.contractSource, item.status], ['forever', 'inferred', 'idle']);
  w.cleanup();
});

test('an undeclared running chat with open tasks is inferred until-done and kept alive', async () => {
  const w = world([conv({ contract: undefined, contractSource: undefined })]);
  w.rows = [liveRow(SID_A)];
  w.sig.set('a', signals({ openTasks: 2 }));
  await w.tick();
  assert.equal(w.convs.get('a')?.contract, 'until-done');
  assert.equal(w.convs.get('a')?.contractSource, 'inferred');
  await w.tick(IDLE_CONFIRM_MS);
  assert.equal(w.nudges.length, 1);
  w.cleanup();
});

test('a contract somebody chose is never overridden by inference', async () => {
  const w = world([conv({ contract: 'once', contractSource: 'chip' })]);
  w.rows = [liveRow(SID_A)];
  w.sig.set('a', signals({ hasCron: true, openTasks: 3 }));
  for (let i = 0; i < 3; i++) await w.tick(60_000);
  assert.equal(w.convs.get('a')?.contract, 'once');
  assert.equal(w.updates.length, 0);
  assert.equal(w.signalReads.length, 0, 'a once chat with nothing pending is not even read');
  w.cleanup();
});

test('nothing is inferred for a chat that is not running', async () => {
  const w = world([conv({ contract: undefined, contractSource: undefined, state: 'done', status: '' })]);
  w.sig.set('a', signals({ hasCron: true }));
  for (let i = 0; i < 3; i++) await w.tick(60_000);
  assert.equal(w.convs.get('a')?.contract, undefined);
  assert.equal(w.relaunches.length, 0);
  w.cleanup();
});

// ---------------------------------------------------------------------------
// Dead daemons
// ---------------------------------------------------------------------------

test('dead daemon: relaunched only after two FRESH listings without it', async () => {
  const w = world([conv({ state: 'done', status: '' })]);
  await w.tick();
  assert.equal(w.relaunches.length, 0, 'one listing is not enough');
  assert.equal(getKeeperSnapshot().items[0].status, 'relaunching');
  await w.tick(KEEPER_TICK_MS, { relist: false });
  assert.equal(w.relaunches.length, 0, 'the same listing seen twice still counts once');
  await w.tick(KEEPER_TICK_MS);
  assert.deepEqual(w.relaunches, [{ id: 'a', prompt: 'continue' }]);
  const k = w.keeperOf('a');
  assert.equal(k?.lastNudgeReason, 'daemon-dead');
  assert.deepEqual(k?.nudgesAt, [w.now], 'a relaunch counts against the hourly cap like a nudge');
  assert.equal(getKeeperSnapshot().recent[0].detail, 'restarted in the background');
  w.cleanup();
});

test('dead daemon: a stale listing never relaunches, and neither does at === 0', async () => {
  const w = world([conv({ state: 'done', status: '' })]);
  w.rowsAt = 0;
  for (let i = 0; i < 4; i++) await w.tick(KEEPER_TICK_MS, { relist: false });
  assert.equal(w.relaunches.length, 0, 'no listing has ever been seen');
  w.rowsAt = w.now;
  await w.tick(KEEPER_TICK_MS, { relist: false });       // fresh: first miss
  for (let i = 0; i < 6; i++) await w.tick(60_000, { relist: false }); // the listing ages past LIVE_ROWS_FRESH_MS
  assert.equal(w.relaunches.length, 0);
  assert.match(getKeeperSnapshot().items[0].detail, /waiting for a fresh process list/);
  w.cleanup();
});

test('dead daemon: the count starts over when the chat shows up again', async () => {
  const w = world([conv({ state: 'done', status: '' })]);
  await w.tick();
  w.rows = [liveRow(SID_A, { status: 'busy' })];
  await w.tick(KEEPER_TICK_MS);
  w.rows = [];
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.relaunches.length, 0);
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.relaunches.length, 1);
  w.cleanup();
});

test('a chat that was only just spawned is not called dead', async () => {
  const w = world([conv({ createdAt: new Date(T0 - 10_000).toISOString(), state: 'starting', status: '' })]);
  await w.tick();
  await w.tick(KEEPER_TICK_MS);
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.relaunches.length, 0);
  w.cleanup();
});

test('a chat with no transcript (an unopened fork) is not relaunched', async () => {
  const w = world([conv({ state: 'idle', status: '', daemonShort: '' })]);
  w.sig.set('a', null);
  for (let i = 0; i < 4; i++) await w.tick(KEEPER_TICK_MS);
  assert.equal(w.relaunches.length, 0);
  assert.equal(getKeeperSnapshot().items[0].detail, 'not running — nothing to restart it from yet');
  w.cleanup();
});

test('a failed relaunch is recorded, counted, and retried only after the cooldown', async () => {
  const w = world([conv({ state: 'done', status: '' })]);
  w.relaunchResult = { ok: false, error: 'session is already running' };
  await w.tick();
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.relaunches.length, 1);
  const r = getKeeperSnapshot().recent[0];
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'could not restart it (session is already running)');
  await w.tick(KEEPER_TICK_MS);
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.relaunches.length, 1);
  await w.tick(NUDGE_COOLDOWN_MS);
  assert.equal(w.relaunches.length, 2);
  w.cleanup();
});

// ---------------------------------------------------------------------------
// Deferred markers
// ---------------------------------------------------------------------------

test('a deferred marker is retried once memory is ok and the chat is idle — even for a once chat', async () => {
  const w = world([conv({ contract: 'once' })]);
  w.rows = [liveRow(SID_A)];
  const at = T0 - 4 * 60_000;
  const file = putMarker(w, SID_A, at);
  await w.tick();
  assert.deepEqual(w.nudges, [{ id: 'a', text: `Memory is free again — retry the step that was deferred at ${hhmm(at)} (spawn: probe).` }]);
  assert.equal(fs.existsSync(file), false, 'the marker is consumed');
  assert.equal(w.keeperOf('a')?.lastNudgeReason, 'memory-deferred');
  assert.equal(w.keeperOf('a')?.keptAlive, false, 'a once chat is owed a retry, not a keep-alive');
  const snap = getKeeperSnapshot();
  assert.deepEqual(snap.deferred, []);
  assert.equal(snap.recent[0].cause, 'memory-deferred');
  w.cleanup();
});

test('a deferred marker waits while memory is tight, and the card says so', async () => {
  const w = world([conv({ contract: 'once' })]);
  w.rows = [liveRow(SID_A)];
  const at = T0 - 4 * 60_000;
  const file = putMarker(w, SID_A, at);
  w.mem = 'closed';
  await w.tick();
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 0);
  assert.equal(fs.existsSync(file), true);
  const snap = getKeeperSnapshot();
  assert.deepEqual(snap.deferred, [{
    file, sessionId: SID_A, conversationId: 'a', title: 'Chat A', cwd: '/Users/demo/proj', at: new Date(at).toISOString(), what: 'spawn: probe', waitingFor: 'memory',
  }]);
  assert.equal(snap.items[0].status, 'waiting-memory');
  w.mem = 'ok';
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 1);
  assert.equal(fs.existsSync(file), false);
  w.cleanup();
});

test('a deferred marker waits for a busy chat to go quiet', async () => {
  const w = world([conv({ contract: 'once' })]);
  w.rows = [liveRow(SID_A, { status: 'busy' })];
  const file = putMarker(w, SID_A, T0 - 60_000);
  await w.tick();
  assert.equal(w.nudges.length, 0);
  assert.equal(getKeeperSnapshot().deferred[0].waitingFor, 'idle-chat');
  w.rows = [liveRow(SID_A)];
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 1);
  assert.equal(fs.existsSync(file), false);
  w.cleanup();
});

test('a failed nudge keeps the marker for the next attempt and is shown as failed', async () => {
  const w = world([conv({ contract: 'once' })]);
  w.rows = [liveRow(SID_A)];
  const file = putMarker(w, SID_A, T0 - 60_000);
  w.nudgeResult = { ok: false, error: 'no terminal' };
  await w.tick();
  assert.equal(w.nudges.length, 1);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual([getKeeperSnapshot().recent[0].ok, getKeeperSnapshot().recent[0].detail], [false, 'could not reach it (no terminal)']);
  w.nudgeResult = { ok: true };
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 1, 'the failed attempt started the cooldown');
  await w.tick(NUDGE_COOLDOWN_MS);
  assert.equal(w.nudges.length, 2);
  assert.equal(fs.existsSync(file), false);
  w.cleanup();
});

test('a marker for a session no chat owns is listed, unowned', async () => {
  const w = world([conv({ contract: 'once' })]);
  putMarker(w, 'ffff9999-0000-4000-8000-00000000000f', T0 - 60_000);
  await w.tick();
  const d = getKeeperSnapshot().deferred;
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].conversationId, d[0].title], [null, null]);
  assert.equal(w.nudges.length, 0);
  w.cleanup();
});

// ---------------------------------------------------------------------------
// Killed workloads
// ---------------------------------------------------------------------------

test('a killed process group is reported to the chat it ran under, once', async () => {
  const w = world([conv({ contract: 'once' })]);
  w.rows = [liveRow(SID_A)];
  const k = killEntry({ sessionId: SID_A });
  w.killLog.push(k);
  await w.tick();
  assert.deepEqual(w.nudges, [{ id: 'a', text: `Your vitest run was stopped at ${hhmm(Date.parse(k.at))} to protect the machine's memory — rerun it.` }]);
  assert.equal(w.keeperOf('a')?.lastNudgeReason, 'killed-workload');
  for (let i = 0; i < 3; i++) await w.tick(NUDGE_COOLDOWN_MS);
  assert.equal(w.nudges.length, 1, 'consumed: never told twice');
  assert.deepEqual(w.killOffsets.slice(0, 3), [0, 1, 1], 'the log is read from where the last read ended');
  w.cleanup();
});

test('a dry-run entry stopped nothing and is never reported', async () => {
  const w = world([conv({ contract: 'once' })]);
  w.rows = [liveRow(SID_A)];
  w.killLog.push(killEntry({ sessionId: SID_A, dry: true, by: 'peersflow-guard', kind: 'container', name: 'redis' }));
  await w.tick();
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 0);
  w.cleanup();
});

test('a kill is attributed through the claude pid, then through the project directory', async () => {
  const w = world([conv({ contract: 'once' }), conv({ id: 'b', sessionId: SID_B, daemonShort: 'bbbb2222', title: 'Chat B', directoryPath: '/Users/demo/other', contract: 'once' })]);
  w.rows = [liveRow(SID_A, { pid: 111 }), liveRow(SID_B, { pid: 222, cwd: '/Users/demo/other' })];
  w.killLog.push(killEntry({ claudePid: 222 }));
  await w.tick();
  assert.deepEqual(w.nudges.map((n) => n.id), ['b']);
  w.killLog.push(killEntry({ at: new Date(w.now).toISOString(), by: 'peersflow-guard', kind: 'container', name: 'postgres-arrow', family: undefined, projectDir: '/Users/demo/proj/.cache' }));
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 2);
  assert.equal(w.nudges[1].id, 'a');
  assert.match(w.nudges[1].text, /^The container postgres-arrow was stopped at \d\d:\d\d to free memory — run `docker start postgres-arrow` and retry\.$/);
  w.cleanup();
});

test('a kill waits for a busy chat, and is dropped after six hours if nobody can be told', async () => {
  const w = world([conv({ contract: 'once' })]);
  w.rows = [liveRow(SID_A, { status: 'busy' })];
  w.killLog.push(killEntry({ sessionId: SID_A }));
  w.killLog.push(killEntry({ cwd: '/somewhere/else' }));
  await w.tick();
  assert.equal(w.nudges.length, 0);
  await w.tick(7 * 60 * 60_000);
  w.rows = [liveRow(SID_A)];
  w.convs.set('z', conv({ id: 'z', sessionId: 'zzzz0000-0000-4000-8000-00000000000z', daemonShort: 'zzzz0000', directoryPath: '/somewhere/else', contract: 'once' }));
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 0, 'both entries aged out');
  w.cleanup();
});

test('backlog after a restart: a kill older than the chat\'s last nudge is not told again', async () => {
  const told = T0 - 30 * 60_000;
  const w = world([conv({ contract: 'once', keeper: { nudgesAt: [told], lastNudgeAt: new Date(told).toISOString(), lastNudgeReason: 'killed-workload' } })]);
  w.rows = [liveRow(SID_A)];
  w.killLog.push(killEntry({ sessionId: SID_A, at: new Date(told - 60_000).toISOString() }));
  await w.tick();
  assert.equal(w.nudges.length, 0);
  // One that happened after it IS new.
  w.killLog.push(killEntry({ sessionId: SID_A, at: new Date(T0 - 60_000).toISOString(), name: 'tsc', family: 'tsc' }));
  await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 1);
  assert.match(w.nudges[0].text, /^Your tsc run/);
  w.cleanup();
});

test('attributeKill: session id, then pid, then the most recent unsettled chat in that directory', () => {
  const a = conv();
  const older = conv({ id: 'o', sessionId: 'oooo0000-x', daemonShort: 'oooo0000', createdAt: new Date(T0 - 5 * 60 * 60_000).toISOString() });
  const settled = conv({ id: 's', sessionId: 'ssss0000-x', daemonShort: 'ssss0000', state: 'done', createdAt: new Date(T0).toISOString() });
  const codex = conv({ id: 'x', sessionId: 'xxxx0000-x', daemonShort: 'xxxx0000', provider: 'codex', createdAt: new Date(T0).toISOString() });
  const remote = conv({ id: 'r', sessionId: 'rrrr0000-x', daemonShort: 'rrrr0000', host: 'me@box', createdAt: new Date(T0).toISOString() });
  const all = [older, a, settled, codex, remote];
  assert.equal(attributeKill(killEntry({ sessionId: 'oooo0000-x' }), all, [])?.id, 'o');
  assert.equal(attributeKill(killEntry({ claudePid: 7 }), all, [liveRow('ssss0000-x', { pid: 7 })])?.id, 's');
  assert.equal(attributeKill(killEntry({ projectDir: '/Users/demo/proj/sub' }), all, [])?.id, 'a');
  assert.equal(attributeKill(killEntry({ cwd: '/Users/demo/proj' }), all, [])?.id, 'a');
  assert.equal(attributeKill(killEntry({ cwd: '/Users/demo/project-two' }), all, []), null, 'a sibling directory is not inside');
  assert.equal(attributeKill(killEntry({ worktree: 1 } as Partial<KillLogEntry>), all, []), null);
  const wt = conv({ id: 'w', sessionId: 'wwww0000-x', daemonShort: 'wwww0000', worktreePath: '/Users/demo/proj-wt', createdAt: new Date(T0).toISOString() });
  assert.equal(attributeKill(killEntry({ cwd: '/Users/demo/proj-wt/pkg' }), [a, wt], [])?.id, 'w');
});

// ---------------------------------------------------------------------------
// Who is followed at all · the stop control · never throws
// ---------------------------------------------------------------------------

test('isKeepable: local Claude chats the user has not put away', () => {
  assert.equal(isKeepable(conv()), true);
  assert.equal(isKeepable(conv({ pinned: false })), true, 'unpinned but still running');
  assert.equal(isKeepable(conv({ pinned: true, state: 'done' })), true, 'pinned and settled: the user still wants it');
  assert.equal(isKeepable(conv({ pinned: false, state: 'done' })), false, 'unpinned and settled means done');
  assert.equal(isKeepable(conv({ provider: 'codex' })), false);
  assert.equal(isKeepable(conv({ host: 'me@box' })), false);
  assert.equal(isKeepable(conv({ sessionId: '' })), false);
});

test('Codex, remote and put-away chats are never read, nudged or relaunched', async () => {
  const w = world([
    conv({ id: 'x', provider: 'codex' }),
    conv({ id: 'r', sessionId: SID_B, daemonShort: 'bbbb2222', host: 'me@box' }),
    conv({ id: 'u', sessionId: 'cccc3333-x', daemonShort: 'cccc3333', pinned: false, state: 'done', status: '' }),
  ]);
  w.rows = [liveRow(SID_A)];
  for (let i = 0; i < 5; i++) await w.tick(60_000);
  assert.equal(w.signalReads.length, 0);
  assert.equal(w.nudges.length + w.relaunches.length + w.updates.length, 0);
  w.cleanup();
});

test('the stop control: a chat switched to Once while the pass was waiting is not nudged', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  await w.tick();
  // The pass reads the list, then the user picks "Once" before the Keeper types.
  const real = w.deps.getConversation;
  w.deps.getConversation = (id) => {
    const c = real(id);
    return c ? { ...c, contract: 'once' } : null;
  };
  await w.tick(IDLE_CONFIRM_MS);
  assert.equal(w.nudges.length, 0);
  assert.deepEqual(w.keeperOf('a')?.nudgesAt, []);
  w.cleanup();
});

test('picking Once lets go at the next pass: keptAlive false, no item, no nudge', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  await w.tick();
  assert.equal(getKeeperSnapshot().items.length, 1);
  // What `convs:setContract` writes for 'once'.
  const prev = w.convs.get('a')!;
  w.convs.set('a', { ...prev, contract: 'once', contractSource: 'chip', keeper: { nudgesAt: [], ...prev.keeper, keptAlive: false, stalled: null } });
  for (let i = 0; i < 12; i++) await w.tick(KEEPER_TICK_MS);
  assert.equal(w.nudges.length, 0);
  assert.equal(w.keeperOf('a')?.keptAlive, false);
  assert.deepEqual(getKeeperSnapshot().items, []);
  w.cleanup();
});

test('runKeeperOnce never throws, whatever the deps do', async () => {
  const w = world();
  w.rows = [liveRow(SID_A)];
  w.deps.readSignals = () => { throw new Error('EACCES'); };
  w.deps.isWalled = () => { throw new Error('boom'); };
  w.deps.jobQuietAt = () => { throw new Error('boom'); };
  w.deps.readKillsSince = () => { throw new Error('ENOENT'); };
  w.deps.notify = () => { throw new Error('no notifications'); };
  w.deps.onSnapshot = () => { throw new Error('window gone'); };
  w.deps.nudge = async () => { throw new Error('pty died'); };
  await assert.doesNotReject(w.tick());
  await assert.doesNotReject(w.tick(IDLE_CONFIRM_MS));
  assert.equal(getKeeperSnapshot().recent[0]?.detail, 'could not reach it (pty died)');
  w.deps.getConversations = () => { throw new Error('store gone'); };
  await assert.doesNotReject(w.tick(KEEPER_TICK_MS));
  w.cleanup();
});

test('the snapshot before any pass is empty and says the Keeper is off', () => {
  __resetKeeperForTests();
  const s = getKeeperSnapshot();
  assert.deepEqual({ ...s, at: '' }, { at: '', enabled: false, paused: null, items: [], deferred: [], recent: [] });
});

test('recent keeps the newest twenty, newest first', async () => {
  const many = Array.from({ length: 25 }, (_, i) => conv({
    id: `c${i}`, title: `Chat ${i}`, sessionId: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, daemonShort: String(i).padStart(8, '0'),
  }));
  const w = world(many);
  w.rows = many.map((c, i) => liveRow(c.sessionId, { pid: 1000 + i }));
  await w.tick();
  await w.tick(IDLE_CONFIRM_MS);
  for (let i = 0; i < 24; i++) await w.tick(1_000);
  assert.equal(w.nudges.length, 25, 'one per pass');
  const r = getKeeperSnapshot().recent;
  assert.equal(r.length, 20);
  assert.equal(r[0].conversationId, w.nudges[24].id);
  assert.equal(r[19].conversationId, w.nudges[5].id);
  w.cleanup();
});
