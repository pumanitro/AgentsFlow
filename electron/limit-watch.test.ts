import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { __resetForTests, isRescuable, parseLimitHit, runOnce, type LimitWatchDeps } from './limit-watch';
import type { Conversation, RotationPolicy } from '../shared/types';

// ---------------------------------------------------------------------------
// Reading the wall out of a transcript
// ---------------------------------------------------------------------------
// The fixtures below are the real shape, taken from a session that spent 81
// minutes walled: `type: assistant`, `isApiErrorMessage`, `error: rate_limit`,
// and the CLI's own sentence in the message content.

function rateLimited(ts: string, text = "You've hit your session limit · resets 7:50am (Europe/Warsaw)"): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiErrorStatus: 429,
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function assistantTurn(ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
  });
}

function userTurn(ts: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: 'continue' } });
}

// readTail strips the leading fragment before the parser ever sees it, so a
// tail here is whole lines only — including the very first one.
function tail(...lines: string[]): string {
  return lines.join('\n');
}

test('parseLimitHit: finds the wall when it is the newest turn', () => {
  const hit = parseLimitHit(tail(assistantTurn('2026-08-17T03:30:00.000Z'), rateLimited('2026-08-17T03:33:43.872Z')));
  assert.ok(hit);
  assert.equal(hit!.at, Date.parse('2026-08-17T03:33:43.872Z'));
  assert.match(hit!.text, /session limit/);
});

test('parseLimitHit: a real turn after the error means it already recovered', () => {
  // This is the 00:50 case: rotation switched accounts and the agent's own
  // retry went through. Nudging that chat would inject a stray "continue".
  const hit = parseLimitHit(tail(rateLimited('2026-08-17T00:50:20.112Z'), assistantTurn('2026-08-17T00:51:02.000Z')));
  assert.equal(hit, null);
});

test('parseLimitHit: a queued user message is not recovery', () => {
  // The prompt is sitting behind the wall, not past it.
  const hit = parseLimitHit(tail(rateLimited('2026-08-17T04:54:14.270Z'), userTurn('2026-08-17T04:55:00.000Z')));
  assert.ok(hit);
});

test('parseLimitHit: other API errors are left alone', () => {
  // Overloaded/network failures retry on their own; swapping accounts would not
  // help and would spend a switch.
  const overloaded = JSON.stringify({
    type: 'assistant', timestamp: '2026-08-17T04:00:00.000Z',
    isApiErrorMessage: true, error: 'overloaded', apiErrorStatus: 529,
    message: { content: [{ type: 'text', text: 'API Error: Overloaded' }] },
  });
  assert.equal(parseLimitHit(tail(overloaded)), null);
});

test('parseLimitHit: an empty or unparseable tail is not a wall', () => {
  assert.equal(parseLimitHit(''), null);
  assert.equal(parseLimitHit(tail('not json at all', '{"broken":')), null);
});

test('parseLimitHit: the very first line counts — short transcripts exist', () => {
  // A whole-file read starts at offset 0, so line 0 is a real entry. Skipping
  // it unconditionally made every short transcript read as "not walled".
  assert.ok(parseLimitHit(rateLimited('2026-08-17T04:54:14.270Z')));
});

test('parseLimitHit: repeated walls report the newest one', () => {
  const hit = parseLimitHit(tail(
    rateLimited('2026-08-17T04:44:10.498Z'),
    rateLimited('2026-08-17T04:54:14.270Z'),
  ));
  assert.equal(hit!.at, Date.parse('2026-08-17T04:54:14.270Z'));
});

// ---------------------------------------------------------------------------
// Which chats may be typed into
// ---------------------------------------------------------------------------

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1', sessionId: '70909aa7-b95b-47be-9efb-e41422145891', daemonShort: '70909aa7',
    sessionName: '', directoryId: 'd1', directoryPath: '/tmp/peer', displayName: 'peer',
    title: 'S6', description: '', pinned: true, state: 'working', status: 'busy',
    intent: '', createdAt: '2026-08-17T00:00:00.000Z', lastPrompt: '',
    ...over,
  } as Conversation;
}

test('isRescuable: a pinned chat qualifies whatever state it stalled in', () => {
  assert.equal(isRescuable(conv({ pinned: true, state: 'done' })), true);
  assert.equal(isRescuable(conv({ pinned: true, state: 'blocked' })), true);
});

test('isRescuable: an unpinned finished chat is left alone', () => {
  // Unpinned means the user considers it done — typing into it would restart
  // work they put away.
  assert.equal(isRescuable(conv({ pinned: false, state: 'done' })), false);
  assert.equal(isRescuable(conv({ pinned: false, state: 'working' })), true);
});

test('isRescuable: no session id, nothing to type into', () => {
  assert.equal(isRescuable(conv({ sessionId: '' })), false);
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

const WALLED = { at: Date.now(), text: "You've hit your session limit" };

function harness(opts: {
  policy?: Partial<RotationPolicy>;
  hit?: { at: number; text: string } | null;
  switched?: boolean;
  nudgeFails?: string;
  conversations?: Conversation[];
}) {
  const nudged: string[] = [];
  const rotations: number[] = [];
  const events: string[] = [];
  const deps: LimitWatchDeps = {
    getPolicy: () => ({ enabled: true, threshold: 95, resumeOnLimit: true, ...opts.policy }),
    getConversations: () => opts.conversations ?? [conv()],
    readHit: () => (opts.hit === undefined ? WALLED : opts.hit),
    rotate: async () => {
      rotations.push(Date.now());
      return opts.switched === false
        ? { switched: false, reason: 'no other account is below 95%' }
        : { switched: true, reason: 'switched' };
    },
    nudge: async (c, text) => {
      nudged.push(`${c.id}:${text}`);
      return opts.nudgeFails ? { ok: false, error: opts.nudgeFails } : { ok: true };
    },
    onEvent: (m) => events.push(m),
  };
  return { deps, nudged, rotations, events };
}

test('runOnce: a policy with the backstop off never types anything', async () => {
  __resetForTests();
  const { deps, nudged, rotations } = harness({ policy: { resumeOnLimit: false } });
  await runOnce(deps);
  assert.deepEqual(nudged, []);
  assert.deepEqual(rotations, []);
});

test('runOnce: rotation off means the backstop is off too', async () => {
  __resetForTests();
  const { deps, nudged } = harness({ policy: { enabled: false } });
  await runOnce(deps);
  assert.deepEqual(nudged, []);
});

test('runOnce: switches, then resumes the walled chat', async () => {
  __resetForTests();
  const { deps, nudged, rotations, events } = harness({});
  await runOnce(deps);
  assert.equal(rotations.length, 1, 'the switch comes first');
  assert.deepEqual(nudged, ['c1:continue']);
  assert.match(events[0], /switched account and resumed it/);
});

test('runOnce: a chat that is not walled is never touched', async () => {
  __resetForTests();
  const { deps, nudged, rotations } = harness({ hit: null });
  await runOnce(deps);
  assert.deepEqual(nudged, []);
  assert.deepEqual(rotations, []);
});

test('runOnce: no switch available means the chat is left parked, not nudged', async () => {
  // Typing "continue" into a chat whose account is still full just burns the
  // attempt budget re-hitting the same wall.
  __resetForTests();
  const { deps, nudged } = harness({ switched: false });
  await runOnce(deps);
  assert.deepEqual(nudged, []);
});

test('runOnce: the same wall is acted on once, not on every tick', async () => {
  __resetForTests();
  const { deps, nudged } = harness({});
  await runOnce(deps);
  await runOnce(deps);
  await runOnce(deps);
  assert.deepEqual(nudged, ['c1:continue'], 'a 30s tick must not retype every 30s');
});

test('runOnce: a wall from hours ago is history, not a stuck chat', async () => {
  __resetForTests();
  const { deps, nudged } = harness({ hit: { at: Date.now() - 7 * 60 * 60 * 1000, text: 'walled' } });
  await runOnce(deps);
  assert.deepEqual(nudged, []);
});

test('runOnce: one rescue per pass, however many chats are walled', async () => {
  // A wall is account-wide: the one switch usually unblocks the rest, and a
  // burst of switches + attach PTYs is exactly what the PTY guard exists for.
  __resetForTests();
  const { deps, nudged } = harness({
    conversations: [conv({ id: 'c1' }), conv({ id: 'c2' }), conv({ id: 'c3' })],
  });
  await runOnce(deps);
  assert.equal(nudged.length, 1);
});

test('runOnce: a failed nudge is reported, not retried in a loop', async () => {
  __resetForTests();
  const { deps, nudged, events } = harness({ nudgeFails: 'the session is no longer running (attach exited)' });
  await runOnce(deps);
  await runOnce(deps);
  assert.equal(nudged.length, 1);
  assert.match(events[0], /couldn't resume it/);
});
