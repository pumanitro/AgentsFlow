import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { CodexAgents, approvalResult, codexEntry, mapThreadStatus, queueCli, RESUME_RETRY } from './codex-agent';
import type { CodexThreadState, Dependencies } from './codex-agent';
import type { CodexRpc } from './codex-protocol';
import type { Conversation } from '../shared/types';

class FakeRpc extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  replies: any[] = [];
  next = 0;
  fail?: string;
  holdTurn = false;
  private held: ((e: Error) => void)[] = [];
  /**
   * Per-method canned answers, consumed in order. An Error is thrown, a
   * function is called with the params (so a test can emit while the call is
   * in flight), anything else is returned; `undefined` falls through.
   */
  queued = new Map<string, any[]>();
  /** Thread id → the `status` its resume/list answer should carry. */
  statuses = new Map<string, any>();
  /** Thread id → what `thread/turns/list` should report for its newest turn. */
  turns = new Map<string, any>();
  listed: any[] = [];
  models: any[] = [
    { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'Workhorse' },
    { id: 'secret', displayName: 'Hidden', hidden: true },
    { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: true },
    { id: 'gpt-5.5' },
  ];
  async start() {}
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (this.fail === method) throw new Error(`${method} is unavailable`);
    const pending = this.queued.get(method);
    if (pending?.length) {
      const answer = pending.shift();
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer(params);
      if (answer !== undefined) return answer;
    }
    if (method === 'thread/start' || method === 'thread/fork') return { thread: { id: `thread-${++this.next}` } };
    if (method === 'thread/resume') return { thread: { id: params.threadId, status: this.statuses.get(params.threadId) } };
    if (method === 'thread/list') return { data: this.listed, nextCursor: null };
    if (method === 'thread/turns/list') return { data: this.turns.has(params.threadId) ? [this.turns.get(params.threadId)] : [] };
    if (method === 'model/list') return { data: this.models };
    if (method === 'thread/items/list') return { data: [{ item: { id: 'old', type: 'agentMessage', text: 'old response' } }], nextCursor: null };
    if (method === 'turn/start') {
      if (this.holdTurn) return new Promise((_resolve, reject) => this.held.push(reject));
      this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'turn' } } });
      return { turn: { id: 'turn', status: 'inProgress' } };
    }
    return {};
  }
  reply(id: string | number, result: any) { this.replies.push({ id, result }); }
  rejectRequest(id: string | number, error: string) { this.replies.push({ id, error }); }
  socketPath() { return '/tmp/peers-flow/codex.sock'; }
  close() {
    for (const reject of this.held.splice(0)) reject(new Error('Codex app-server was stopped.'));
    this.emit('disconnected', new Error('closed'));
  }
}
function fixture(extra: Partial<Dependencies> = {}) {
  const rpc = new FakeRpc();
  const conversations = new Map(['one', 'two'].map((id) => [id, { id, provider: 'codex', sessionId: '', directoryPath: `/work/${id}` } as Conversation]));
  const snapshots: any[] = [];
  const limits: { id: string; message: string }[] = [];
  const statuses: { id: string; state: CodexThreadState; detail?: string }[] = [];
  const manager = new CodexAgents({
    get: (id) => conversations.get(id) || null,
    update: (id, p) => Object.assign(conversations.get(id)!, p),
    options: () => ({ sandbox: 'workspace-write', approvalPolicy: 'on-request', developerInstructions: 'house rules' }),
    changed: (s) => snapshots.push(s),
    list: () => [...conversations.values()],
    userData: '/tmp/peers-flow',
    onLimit: (id, message) => limits.push({ id, message }),
    onThreadStatus: (id, state, detail) => statuses.push({ id, state, detail }),
    ...extra,
  }, rpc as unknown as CodexRpc);
  const event = (method: string, threadId: string, extra: any) => rpc.emit('notification', { method, params: { threadId, ...extra } });
  return { manager, rpc, conversations, snapshots, limits, statuses, event };
}
/** A pinned row whose thread already exists on the server. */
function pinned(conv: Conversation, threadId: string, state = 'working'): Conversation {
  return Object.assign(conv, { pinned: true, sessionId: threadId, state, status: state });
}
/**
 * Let the 'connected' handler's re-sync run. It is several round trips deep and
 * the rollout retry sleeps on a real timer, so both phases have to be drained.
 */
const settle = async () => { for (let i = 0; i < 12; i++) { await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 1)); } };
/** Wait for something the re-sync is expected to reach, rather than guessing at turns. */
const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
};
const forkedFromClaude = (): Conversation['handover'] => ({ from: 'claude', sessionId: 'claude-session', directoryPath: '/work/one', at: new Date().toISOString() });

test('parallel sends are deduplicated and each conversation gets its own cwd and thread', async () => {
  const f = fixture();
  try {
    await Promise.all([f.manager.send('one', 'first'), f.manager.send('two', 'second')]);
    assert.equal(f.rpc.calls.filter((c) => c.method === 'thread/start').length, 2);
    assert.deepEqual(f.rpc.calls.filter((c) => c.method === 'thread/start').map((c) => c.params.cwd).sort(), ['/work/one', '/work/two']);
    await assert.rejects(f.manager.send('one', 'duplicate'), /still working/);
    assert.equal(f.rpc.calls.filter((c) => c.method === 'turn/start').length, 2);
  } finally { f.manager.close(); }
});

test('streamed results belong to their thread and an empty later turn cannot return an old answer', async () => {
  const f = fixture();
  try {
    await f.manager.send('one', 'question');
    f.event('item/agentMessage/delta', 'thread-1', { itemId: 'answer', delta: 'hello' });
    f.event('turn/completed', 'thread-1', { turn: { status: 'completed', items: [] } });
    assert.equal(f.conversations.get('one')!.lastResult, 'hello');
    assert.equal(f.conversations.get('two')!.lastResult, undefined);
    await f.manager.send('one', 'second');
    f.event('turn/completed', 'thread-1', { turn: { status: 'completed', items: [] } });
    assert.equal(f.conversations.get('one')!.lastResult, '');
  } finally { f.manager.close(); }
});

test('approval requests require a response for the owning conversation', async () => {
  const f = fixture();
  try {
    await Promise.all([f.manager.send('one', 'a'), f.manager.send('two', 'b')]);
    f.rpc.emit('request', { id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'echo test' } });
    assert.equal(f.rpc.replies.length, 0);
    assert.equal((await f.manager.snapshot('one')).state, 'needs-input');
    assert.equal((await f.manager.snapshot('two')).requests.length, 0);
    await assert.rejects(f.manager.reply('two', 42, { accept: true }), /no longer pending/);
    await f.manager.reply('one', 42, { accept: false });
    assert.deepEqual(f.rpc.replies, [{ id: 42, result: { decision: 'decline' } }]);
    await assert.rejects(f.manager.reply('one', 42, { accept: true }), /no longer pending/);
  } finally { f.manager.close(); }
});

test('interruption is scoped to the active turn; completion clears pending questions', async () => {
  const f = fixture();
  try {
    await f.manager.send('one', 'a');
    f.rpc.emit('request', { id: 4, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', questions: [] } });
    await f.manager.stop('one');
    assert.deepEqual(f.rpc.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn' } });
    f.event('turn/completed', 'thread-1', { turn: { status: 'interrupted', items: [] } });
    const s = await f.manager.snapshot('one');
    assert.equal(s.state, 'stopped'); assert.equal(s.requests.length, 0);
  } finally { f.manager.close(); }
});

test('saved conversations resume through paginated history and preserve thread identity', async () => {
  const f = fixture();
  try {
    f.conversations.get('one')!.sessionId = 'saved-thread';
    const [a, b] = await Promise.all([f.manager.snapshot('one'), f.manager.snapshot('one')]);
    assert.equal(a.threadId, 'saved-thread'); assert.equal(b.entries[0].text, 'old response');
    assert.equal(f.rpc.calls.filter((c) => c.method === 'thread/resume').length, 1);
    assert.equal(f.rpc.calls.filter((c) => c.method === 'thread/start').length, 0);
  } finally { f.manager.close(); }
});

test('fork uses Codex thread/fork, receives a new id and normal shutdown preserves completed state', async () => {
  const f = fixture();
  f.conversations.get('one')!.forkFromSessionId = 'source';
  await f.manager.snapshot('one');
  assert.equal(f.rpc.calls[0].method, 'thread/fork');
  assert.equal(f.rpc.calls[0].params.threadId, 'source');
  assert.equal(f.conversations.get('one')!.sessionId, 'thread-1');
  f.manager.close();
  assert.equal(f.conversations.get('one')!.state, 'idle');
});

test('server crash is visible and reopens the persisted thread instead of duplicating work', async () => {
  const f = fixture();
  try {
    await f.manager.send('one', 'a');
    f.rpc.emit('disconnected', new Error('lost server'));
    assert.equal(f.snapshots.at(-1).error, 'lost server');
    assert.equal(f.conversations.get('one')!.state, 'error');
    await f.manager.snapshot('one');
    assert.equal(f.rpc.calls.filter((c) => c.method === 'thread/start').length, 1);
    assert.equal(f.rpc.calls.filter((c) => c.method === 'thread/resume').length, 1);
  } finally { f.manager.close(); }
});

test('request responses preserve explicit choices and do not grant session-wide access', () => {
  assert.deepEqual(approvalResult('item/permissions/requestApproval', { permissions: { network: { enabled: true } } }, { accept: true }), { permissions: { network: { enabled: true } }, scope: 'turn' });
  assert.deepEqual(approvalResult('item/permissions/requestApproval', { permissions: { network: {} } }, { accept: false }), { permissions: {}, scope: 'turn' });
  assert.deepEqual(approvalResult('item/tool/requestUserInput', { questions: [{ id: 'q' }] }, { accept: true, answers: { q: 'choice' } }), { answers: { q: { answers: ['choice'] } } });
  assert.throws(() => approvalResult('future/request', {}, { accept: true }), /Unsupported/);
});

test('tool output is bounded and hidden reasoning is never rendered', () => {
  assert.equal(codexEntry({ id: 'r', type: 'reasoning', content: ['private'] }), null);
  const entry = codexEntry({ id: 'c', type: 'commandExecution', command: 'build', aggregatedOutput: 'x'.repeat(100000) })!;
  assert(entry.text.length < 17000);
});

test('models are listed default first, hidden ones are dropped and the list is cached', async () => {
  const f = fixture();
  try {
    const models = await f.manager.listModels();
    assert.deepEqual(models.map((m) => m.id), ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5']);
    assert.deepEqual(models[0], { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: true, description: undefined });
    assert.equal(models[2].displayName, 'gpt-5.5'); // Falls back to the id.
    assert.equal(models[1].description, 'Workhorse');
    await f.manager.listModels();
    assert.equal(f.rpc.calls.filter((c) => c.method === 'model/list').length, 1);
  } finally { f.manager.close(); }
});

test('a Codex that cannot list models reports none rather than breaking the picker', async () => {
  const f = fixture();
  try {
    f.rpc.fail = 'model/list';
    assert.deepEqual(await f.manager.listModels(), []);
    f.rpc.fail = undefined;
    assert.equal((await f.manager.listModels()).length, 3); // A failure is never cached.
  } finally { f.manager.close(); }
});

test('restarting after an account switch parks threads instead of failing them, and resumes them', async () => {
  const f = fixture();
  try {
    await f.manager.send('one', 'a');
    assert.equal(f.manager.hasRunningTurn(), true);
    await f.manager.restart();
    assert.equal(f.manager.hasRunningTurn(), false);
    const conv = f.conversations.get('one')!;
    assert.equal(conv.state, 'idle');
    assert.equal(conv.status, 'idle');
    assert.equal(conv.description, 'Codex account switched — reopen to continue');
    assert.equal(f.snapshots.at(-1).state, 'idle');
    assert.equal(f.snapshots.at(-1).error, undefined);
    assert.equal(conv.sessionId, 'thread-1'); // The thread id survives the restart.
    await f.manager.snapshot('one');
    assert.deepEqual(f.rpc.calls.at(-2), { method: 'thread/resume', params: { sandbox: 'workspace-write', approvalPolicy: 'on-request', developerInstructions: 'house rules', cwd: '/work/one', threadId: 'thread-1', excludeTurns: true } });
  } finally { f.manager.close(); }
});

test('restarting a Codex that was never connected is harmless', async () => {
  const f = fixture();
  try {
    await f.manager.restart();
    assert.equal(f.manager.hasRunningTurn(), false);
    await f.manager.send('one', 'a');
    assert.equal(f.rpc.calls.filter((c) => c.method === 'thread/start').length, 1);
  } finally { f.manager.close(); }
});

test('a row forked from Claude starts a fresh thread, never forks the other provider, and carries its seed out of band', async () => {
  const f = fixture({ handoverContext: (conv) => `PRIOR WORK for ${conv.id}` });
  try {
    const conv = f.conversations.get('one')!;
    conv.handover = forkedFromClaude();
    conv.forkFromSessionId = 'claude-session'; // A Claude id: Codex must not fork it.
    const snapshot = await f.manager.snapshot('one');
    const start = f.rpc.calls.find((c) => c.method === 'thread/start')!;
    assert.ok(start, 'a fork from Claude starts a new Codex thread');
    assert.equal(f.rpc.calls.filter((c) => c.method === 'thread/fork').length, 0);
    assert.equal(start.params.developerInstructions, 'house rules\n\nPRIOR WORK for one');
    assert.deepEqual(snapshot.entries.map((e) => e.id), ['handover']);
    assert.match(snapshot.entries[0].text, /Forked from Claude Code/);
    assert.equal(snapshot.entries[0].role, 'tool');

    // The prompt itself stays exactly what the user typed.
    await f.manager.send('one', 'carry on');
    const turn = f.rpc.calls.find((c) => c.method === 'turn/start')!;
    assert.equal(turn.params.input[0].text, 'carry on');
    assert.ok(conv.handover, 'the seed is still pending until Codex answers');
    f.event('turn/completed', 'thread-1', { turn: { status: 'completed', items: [] } });
    assert.equal(conv.handover, undefined);
  } finally { f.manager.close(); }
});

test('a fork with no readable context sends the thread options through untouched', async () => {
  const f = fixture({ handoverContext: () => '   ' });
  try {
    f.conversations.get('one')!.handover = forkedFromClaude();
    await f.manager.snapshot('one');
    assert.equal(f.rpc.calls[0].params.developerInstructions, 'house rules');
  } finally { f.manager.close(); }
});

test('hitting the Codex quota is reported once per turn, from either notification', async () => {
  const f = fixture();
  try {
    await f.manager.send('one', 'a');
    f.event('error', 'thread-1', { error: { message: 'You have hit your usage limit. Try again later.' } });
    f.event('turn/completed', 'thread-1', { turn: { id: 'turn', status: 'failed', error: { message: 'usage limit reached' }, items: [] } });
    assert.deepEqual(f.limits, [{ id: 'one', message: 'You have hit your usage limit. Try again later.' }]);
    assert.equal(f.conversations.get('one')!.state, 'error');

    await f.manager.send('one', 'b');
    f.event('turn/completed', 'thread-1', { turn: { id: 'turn', status: 'failed', error: { message: 'Too Many Requests (429)' }, items: [] } });
    assert.equal(f.limits.length, 2);
    assert.equal(f.limits[1].message, 'Too Many Requests (429)');
  } finally { f.manager.close(); }
});

test('an ordinary failure is not mistaken for a rate limit', async () => {
  const f = fixture();
  try {
    await f.manager.send('one', 'a');
    f.event('turn/completed', 'thread-1', { turn: { id: 'turn', status: 'failed', error: { message: 'sandbox denied write access' }, items: [] } });
    f.event('error', 'thread-1', { willRetry: true, error: { message: 'rate limited, retrying' } });
    assert.deepEqual(f.limits, []);
  } finally { f.manager.close(); }
});

test('a Codex thread can be condensed to seed a fork back to Claude', async () => {
  const f = fixture();
  try {
    f.conversations.get('one')!.handover = forkedFromClaude();
    await f.manager.snapshot('one');
    f.event('item/completed', 'thread-1', { item: { id: 'u', type: 'userMessage', content: [{ text: 'fix the build' }] } });
    f.event('item/completed', 'thread-1', { item: { id: 'a', type: 'agentMessage', text: 'build is green' } });
    f.event('item/completed', 'thread-1', { item: { id: 'c', type: 'commandExecution', command: 'npm test', aggregatedOutput: 'ok' } });
    const text = await f.manager.historyText('one');
    assert.equal(text, 'USER: fix the build\n\nASSISTANT: build is green'); // Tools and the fork note are left out.

    // A conversation that is not open falls back to the thread on the server.
    f.conversations.get('two')!.sessionId = 'saved-thread';
    assert.equal(await f.manager.historyText('two'), 'ASSISTANT: old response');
    assert.equal(await f.manager.historyText('missing'), '');
  } finally { f.manager.close(); }
});

test('a restart mid-turn fails the send without making the parked row look broken', async () => {
  const f = fixture();
  try {
    await f.manager.snapshot('one');
    f.rpc.holdTurn = true;
    const sending = f.manager.send('one', 'a');
    await new Promise((resolve) => setImmediate(resolve)); // Let send() reach the held turn/start.
    assert.equal(f.manager.hasRunningTurn(), true);
    await f.manager.restart();
    await assert.rejects(sending, /stopped/);
    const conv = f.conversations.get('one')!;
    assert.equal(conv.state, 'idle');
    assert.equal(conv.description, 'Codex account switched — reopen to continue');
  } finally { f.manager.close(); }
});

// ---- Rejoining threads that kept running without the app -------------------

test('a thread status becomes a row state, and says nothing when the server is not sure', () => {
  assert.deepEqual(mapThreadStatus({ type: 'active', activeFlags: [] }), { state: 'working' });
  assert.deepEqual(mapThreadStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }), { state: 'blocked', detail: 'Codex needs your input' });
  assert.deepEqual(mapThreadStatus({ type: 'active', activeFlags: ['waitingOnUserInput'] }), { state: 'blocked', detail: 'Codex needs your input' });
  assert.equal(mapThreadStatus({ type: 'active', activeFlags: ['usageLimited'] })!.state, 'blocked');
  assert.deepEqual(mapThreadStatus({ type: 'systemError', message: 'the model is gone' }), { state: 'error', detail: 'the model is gone' });
  assert.equal(mapThreadStatus({ type: 'notLoaded' }), null); // Keeps whatever is stored.
  assert.equal(mapThreadStatus(undefined), null);

  // Idle is only "no turn is running": which ending it was is the last turn's.
  assert.deepEqual(mapThreadStatus({ type: 'idle' }, { lastTurnStatus: 'completed' }), { state: 'done' });
  assert.deepEqual(mapThreadStatus({ type: 'idle' }, { lastTurnStatus: 'failed', lastTurnError: 'boom' }), { state: 'error', detail: 'boom' });
  assert.deepEqual(mapThreadStatus({ type: 'idle' }, { lastTurnStatus: 'interrupted' }), { state: 'stopped' });
  assert.equal(mapThreadStatus({ type: 'idle' }, { lastTurnStatus: 'inProgress', stored: 'working' }), null);
  assert.deepEqual(mapThreadStatus({ type: 'idle' }, { stored: 'working' }), { state: 'done' }); // Finished while we were away.
  assert.equal(mapThreadStatus({ type: 'idle' }, { stored: 'done' }), null);
  assert.deepEqual(mapThreadStatus({ type: 'idle' }, { stored: 'idle' }), { state: 'idle' });

  // A thread that has run nothing has finished nothing: `thread/start` answers
  // idle, and reading that as an ending painted a new chat "done" — a green dot
  // — for the whole of its first turn.
  assert.equal(mapThreadStatus({ type: 'idle' }, { stored: 'working', hasTurns: false }), null);
  assert.equal(mapThreadStatus({ type: 'idle' }, { stored: 'starting', hasTurns: false }), null);
  assert.equal(mapThreadStatus({ type: 'idle' }, { stored: 'idle', hasTurns: false }), null);
  // Having turns is not itself an ending — the last turn's status still decides.
  assert.deepEqual(mapThreadStatus({ type: 'idle' }, { stored: 'working', hasTurns: true }), { state: 'done' });
});

test('reconnecting resumes every pinned Codex thread, applies its status and backfills what was missed', async () => {
  const f = fixture();
  try {
    pinned(f.conversations.get('one')!, 'thread-live', 'working');
    pinned(f.conversations.get('two')!, 'thread-over', 'working');
    f.conversations.get('two')!.pinned = false; // Unpinned: not our business any more.
    f.rpc.statuses.set('thread-live', { type: 'active', activeFlags: [] });
    f.rpc.emit('connected');
    await until(() => f.statuses.length > 0, 'the re-sync to repaint the row');

    const resumed = f.rpc.calls.filter((c) => c.method === 'thread/resume');
    assert.deepEqual(resumed.map((c) => c.params.threadId), ['thread-live']);
    assert.equal(resumed[0].params.cwd, '/work/one'); // Resume carries the row's own options.
    // Item deltas are live-forward only, so a rejoin always backfills.
    assert.equal(f.rpc.calls.filter((c) => c.method === 'thread/items/list').length, 1);
    assert.equal(f.conversations.get('one')!.state, 'working');
    assert.deepEqual(f.statuses, [{ id: 'one', state: 'working', detail: undefined }]);
    assert.equal((await f.manager.snapshot('one')).entries[0].text, 'old response');
  } finally { f.manager.close(); }
});

test('a row whose thread finished while the app was shut down comes back done, not working', async () => {
  const f = fixture();
  try {
    pinned(f.conversations.get('one')!, 'thread-live', 'working');
    f.conversations.get('two')!.pinned = false;
    f.rpc.statuses.set('thread-live', { type: 'idle' });
    f.rpc.turns.set('thread-live', { id: 't1', status: 'completed' });
    f.rpc.emit('connected');
    await until(() => f.conversations.get('one')!.state === 'done', 'the finished thread to settle');
    assert.equal(f.conversations.get('one')!.state, 'done');
    assert.equal(f.conversations.get('one')!.description, 'Codex finished');
  } finally { f.manager.close(); }
});

test('thread/list repaints rows in one call and a settled row is never resumed', async () => {
  const f = fixture();
  try {
    pinned(f.conversations.get('one')!, 'thread-done', 'done');
    pinned(f.conversations.get('two')!, 'thread-busy', 'idle');
    f.rpc.listed = [
      { id: 'thread-done', status: { type: 'idle' } },
      { id: 'thread-busy', status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
    ];
    f.rpc.statuses.set('thread-busy', { type: 'active', activeFlags: ['waitingOnApproval'] });
    f.rpc.emit('connected');
    await until(() => f.conversations.get('two')!.state === 'blocked', 'the busy thread to be rejoined');
    assert.deepEqual(f.rpc.calls.filter((c) => c.method === 'thread/resume').map((c) => c.params.threadId), ['thread-busy']);
    assert.equal(f.conversations.get('one')!.state, 'done'); // Listed idle, already settled: untouched.
    assert.equal(f.conversations.get('two')!.state, 'blocked');
    assert.equal(f.conversations.get('two')!.description, 'Codex needs your input');
  } finally { f.manager.close(); }
});

test('a thread whose first turn has not written a rollout yet is retried, not failed', async () => {
  const f = fixture();
  const delay = RESUME_RETRY.delayMs;
  RESUME_RETRY.delayMs = 1;
  try {
    pinned(f.conversations.get('one')!, 'thread-new', 'starting');
    f.conversations.get('two')!.pinned = false;
    f.rpc.queued.set('thread/resume', [
      new Error('no rollout found for thread id thread-new'),
      new Error('no rollout found for thread id thread-new'),
    ]);
    f.rpc.statuses.set('thread-new', { type: 'active', activeFlags: [] });
    f.rpc.emit('connected');
    await until(() => f.conversations.get('one')!.state === 'working', 'the retried resume to succeed');
    assert.equal(f.rpc.calls.filter((c) => c.method === 'thread/resume').length, 3);
    assert.equal(f.conversations.get('one')!.state, 'working');
  } finally { RESUME_RETRY.delayMs = delay; f.manager.close(); }
});

test('a resume that never succeeds leaves the row exactly as it was stored', async () => {
  const f = fixture();
  try {
    pinned(f.conversations.get('one')!, 'thread-gone', 'working');
    f.conversations.get('two')!.pinned = false;
    f.rpc.fail = 'thread/resume';
    f.rpc.emit('connected');
    await settle();
    const conv = f.conversations.get('one')!;
    assert.equal(conv.state, 'working');
    assert.notEqual(conv.status, 'error');
  } finally { f.manager.close(); }
});

test('an approval left pending while nobody was connected lands in the snapshot on resume', async () => {
  const f = fixture();
  try {
    pinned(f.conversations.get('one')!, 'thread-held', 'working');
    f.conversations.get('two')!.pinned = false;
    f.rpc.statuses.set('thread-held', { type: 'active', activeFlags: ['waitingOnApproval'] });
    // The server re-delivers it in the same millisecond as the resume response.
    f.rpc.queued.set('thread/resume', [() => {
      f.rpc.emit('request', { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-held', command: 'curl example.com' } });
      return { thread: { id: 'thread-held', status: { type: 'active', activeFlags: ['waitingOnApproval'] } } };
    }]);
    f.rpc.emit('connected');
    await until(() => f.conversations.get('one')!.state === 'blocked', 'the re-delivered approval to land');
    assert.deepEqual(f.rpc.replies, []); // Never rejected as an unknown thread.
    const snapshot = await f.manager.snapshot('one');
    assert.deepEqual(snapshot.requests.map((r) => r.id), [7]);
    await f.manager.reply('one', 7, { accept: false });
    assert.deepEqual(f.rpc.replies, [{ id: 7, result: { decision: 'decline' } }]);
  } finally { f.manager.close(); }
});

test('a broadcast status change reaches a row the app never resumed', async () => {
  const f = fixture();
  try {
    pinned(f.conversations.get('one')!, 'thread-x', 'working');
    f.event('thread/status/changed', 'thread-x', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    await until(() => f.statuses.length > 0, 'the broadcast to reach the row');
    assert.equal(f.conversations.get('one')!.state, 'blocked');
    assert.deepEqual(f.statuses.at(-1), { id: 'one', state: 'blocked', detail: 'Codex needs your input' });

    // A thread started by somebody else matches no row and changes nothing.
    f.event('thread/started', 'thread-somebody-else', { thread: { id: 'thread-somebody-else', status: { type: 'active' } } });
    await settle();
    assert.equal(f.statuses.length, 1);
  } finally { f.manager.close(); }
});

test('the thread/started broadcast cannot mark a brand-new chat done during its first turn', async () => {
  const f = fixture();
  try {
    f.conversations.get('one')!.state = 'starting'; // What main.ts writes when the chat is spawned.
    await f.manager.send('one', 'first message');
    assert.equal(f.conversations.get('one')!.state, 'working');

    // `thread/start` makes the server broadcast `thread/started` carrying
    // `status: idle` — it reaches every client, and it used to land *after*
    // send() had painted the row working.
    f.event('thread/started', 'thread-1', { thread: { id: 'thread-1', status: { type: 'idle' } } });
    await settle();
    assert.equal(f.conversations.get('one')!.state, 'working'); // Still blue, not "Codex finished".

    // The same, for a server that refuses to list the turns of a thread whose
    // first user message has not been recorded yet.
    f.rpc.queued.set('thread/turns/list', [new Error('thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message')]);
    f.event('thread/status/changed', 'thread-1', { status: { type: 'idle' } });
    await settle();
    assert.equal(f.conversations.get('one')!.state, 'working');

    // The turn's own completion is still what ends it.
    f.event('turn/completed', 'thread-1', { turn: { status: 'completed', items: [] } });
    assert.equal(f.conversations.get('one')!.state, 'done');
  } finally { f.manager.close(); }
});

test('an idle status overtaken while we ask how the last turn ended is dropped', async () => {
  const f = fixture();
  try {
    pinned(f.conversations.get('one')!, 'thread-x', 'idle');
    // The previous turn really did complete — but a new one starts while
    // `thread/turns/list` is in flight, which is the whole race: the answer is
    // about the turn before the one now running.
    f.rpc.queued.set('thread/turns/list', [() => {
      f.conversations.get('one')!.state = 'working';
      return { data: [{ status: 'completed' }] };
    }]);
    f.event('thread/status/changed', 'thread-x', { status: { type: 'idle' } });
    await settle();
    assert.equal(f.conversations.get('one')!.state, 'working');
  } finally { f.manager.close(); }
});

test('opening a row mid-turn no longer relabels a working thread as idle', async () => {
  const f = fixture();
  try {
    f.conversations.get('one')!.sessionId = 'thread-running';
    f.rpc.statuses.set('thread-running', { type: 'active', activeFlags: [] });
    assert.equal((await f.manager.snapshot('one')).state, 'working');
  } finally { f.manager.close(); }
});

// ---- Queueing onto a busy thread -------------------------------------------

test('queue uses the app-server when it has thread/queue/add', async () => {
  const f = fixture();
  const ran: string[][] = [];
  const real = queueCli.run;
  queueCli.run = async (args) => { ran.push(args); };
  try {
    await f.manager.send('one', 'a');
    await f.manager.queue('one', 'also check the tests');
    const add = f.rpc.calls.find((c) => c.method === 'thread/queue/add')!;
    assert.equal(add.params.threadId, 'thread-1');
    assert.deepEqual(add.params.input, [{ type: 'text', text: 'also check the tests', text_elements: [] }]);
    assert.match(String(add.params.clientUserMessageId), /^[0-9a-f-]{36}$/);
    assert.deepEqual(ran, []);
  } finally { queueCli.run = real; f.manager.close(); }
});

test('queue falls back to the codex CLI when the app-server has no queue method', async () => {
  const f = fixture();
  const ran: string[][] = [];
  const real = queueCli.run;
  queueCli.run = async (args) => { ran.push(args); };
  try {
    await f.manager.send('one', 'a');
    f.rpc.queued.set('thread/queue/add', [new Error('Invalid request: unknown variant `thread/queue/add`')]);
    await f.manager.queue('one', 'nudge');
    assert.deepEqual(ran, [['queue', '--thread', 'thread-1', '--message', 'nudge', '--remote', 'unix:///tmp/peers-flow/codex.sock']]);

    // The absence is remembered: no second pointless round trip.
    await f.manager.queue('one', 'again');
    assert.equal(f.rpc.calls.filter((c) => c.method === 'thread/queue/add').length, 1);
    assert.equal(ran.length, 2);
  } finally { queueCli.run = real; f.manager.close(); }
});

test('queue reports a real failure instead of quietly shelling out', async () => {
  const f = fixture();
  const real = queueCli.run;
  queueCli.run = async () => { throw new Error('the CLI should not have been reached'); };
  try {
    await f.manager.send('one', 'a');
    f.rpc.queued.set('thread/queue/add', [new Error('thread is archived')]);
    await assert.rejects(f.manager.queue('one', 'nudge'), /archived/);
    await assert.rejects(f.manager.queue('two', 'no thread yet'), /no Codex thread/);
  } finally { queueCli.run = real; f.manager.close(); }
});

test('forgetting a conversation unsubscribes but leaves the thread on the server', async () => {
  const f = fixture();
  try {
    await f.manager.send('one', 'a');
    await f.manager.forget('one');
    assert.deepEqual(f.rpc.calls.at(-1), { method: 'thread/unsubscribe', params: { threadId: 'thread-1' } });
    assert.equal(f.rpc.calls.filter((c) => c.method === 'thread/delete' || c.method === 'thread/archive').length, 0);
  } finally { f.manager.close(); }
});

test('closing the app gives up the connection, not the work in flight', async () => {
  const f = fixture();
  await f.manager.send('one', 'a');
  f.manager.close();
  const conv = f.conversations.get('one')!;
  assert.equal(conv.state, 'working'); // The app-server kept running it.
  assert.notEqual(conv.description, 'App closed. Reopen to continue.');
});

const defaultPermissionCases: { name: string; row: Partial<Conversation>; method: string }[] = [
  { name: 'new UI chat', row: {}, method: 'thread/start' },
  { name: 'delegated peer', row: { delegatedByConversationId: 'parent' }, method: 'thread/start' },
  { name: 'Codex fork', row: { forkFromSessionId: 'source-thread' }, method: 'thread/fork' },
  { name: 'Claude handover', row: { handover: forkedFromClaude(), forkFromSessionId: 'claude-session' }, method: 'thread/start' },
  { name: 'resumed chat', row: { sessionId: 'existing-thread' }, method: 'thread/resume' },
];

for (const { name, row, method } of defaultPermissionCases) {
  test(`${name} defaults to full access without command approvals`, async () => {
    const f = fixture({ options: () => ({ developerInstructions: 'house rules' }) });
    try {
      Object.assign(f.conversations.get('one')!, row);
      await f.manager.send('one', 'a');
      const launch = f.rpc.calls.find((c) => c.method === method)!;
      assert.ok(launch, `expected ${method}`);
      assert.equal(launch.params.approvalPolicy, 'never');
      assert.equal(launch.params.sandbox, 'danger-full-access');
      assert.equal(launch.params.developerInstructions, 'house rules');
      // The first turn must inherit the thread's settings, without downgrading them.
      const turn = f.rpc.calls.find((c) => c.method === 'turn/start')!;
      assert.equal(turn.params.approvalPolicy, undefined);
      assert.equal(turn.params.sandboxPolicy, undefined);
    } finally { f.manager.close(); }
  });
}

test('reconnecting to an existing daemon reasserts the full-access thread defaults', async () => {
  const f = fixture({ options: () => ({}) });
  try {
    pinned(f.conversations.get('one')!, 'thread-live');
    f.rpc.statuses.set('thread-live', { type: 'active', activeFlags: [] });
    f.rpc.emit('connected');
    await until(() => f.statuses.length > 0, 'the thread to rejoin');
    const resume = f.rpc.calls.find((c) => c.method === 'thread/resume')!;
    assert.equal(resume.params.approvalPolicy, 'never');
    assert.equal(resume.params.sandbox, 'danger-full-access');
    assert.equal(f.conversations.get('one')!.state, 'working');
    assert.equal(f.rpc.calls.some((c) => c.method === 'turn/interrupt'), false);
  } finally { f.manager.close(); }
});

test('explicit thread permission overrides remain supported', async () => {
  const f = fixture();
  try {
    await f.manager.send('one', 'a');
    const start = f.rpc.calls.find((c) => c.method === 'thread/start')!;
    assert.equal(start.params.approvalPolicy, 'on-request');
    assert.equal(start.params.sandbox, 'workspace-write');
  } finally { f.manager.close(); }
});
