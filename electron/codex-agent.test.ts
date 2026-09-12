import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { CodexAgents, approvalResult, codexEntry } from './codex-agent';
import type { Dependencies } from './codex-agent';
import type { CodexRpc } from './codex-protocol';
import type { Conversation } from '../shared/types';

class FakeRpc extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  replies: any[] = [];
  next = 0;
  fail?: string;
  holdTurn = false;
  private held: ((e: Error) => void)[] = [];
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
    if (method === 'thread/start' || method === 'thread/fork') return { thread: { id: `thread-${++this.next}` } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
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
  const manager = new CodexAgents({
    get: (id) => conversations.get(id) || null,
    update: (id, p) => Object.assign(conversations.get(id)!, p),
    options: () => ({ sandbox: 'workspace-write', approvalPolicy: 'on-request', developerInstructions: 'house rules' }),
    changed: (s) => snapshots.push(s),
    onLimit: (id, message) => limits.push({ id, message }),
    ...extra,
  }, rpc as unknown as CodexRpc);
  const event = (method: string, threadId: string, extra: any) => rpc.emit('notification', { method, params: { threadId, ...extra } });
  return { manager, rpc, conversations, snapshots, limits, event };
}
const handedOver = (): Conversation['handover'] => ({ from: 'claude', sessionId: 'claude-session', directoryPath: '/work/one', at: new Date().toISOString() });

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

test('a handed-over row starts a fresh thread, never forks the other provider, and carries its context out of band', async () => {
  const f = fixture({ handoverContext: (conv) => `PRIOR WORK for ${conv.id}` });
  try {
    const conv = f.conversations.get('one')!;
    conv.handover = handedOver();
    conv.forkFromSessionId = 'claude-session'; // A Claude id: Codex must not fork it.
    const snapshot = await f.manager.snapshot('one');
    const start = f.rpc.calls.find((c) => c.method === 'thread/start')!;
    assert.ok(start, 'a handover starts a new Codex thread');
    assert.equal(f.rpc.calls.filter((c) => c.method === 'thread/fork').length, 0);
    assert.equal(start.params.developerInstructions, 'house rules\n\nPRIOR WORK for one');
    assert.deepEqual(snapshot.entries.map((e) => e.id), ['handover']);
    assert.match(snapshot.entries[0].text, /Handed over from Claude Code/);
    assert.equal(snapshot.entries[0].role, 'tool');

    // The prompt itself stays exactly what the user typed.
    await f.manager.send('one', 'carry on');
    const turn = f.rpc.calls.find((c) => c.method === 'turn/start')!;
    assert.equal(turn.params.input[0].text, 'carry on');
    assert.ok(conv.handover, 'the handover is still pending until Codex answers');
    f.event('turn/completed', 'thread-1', { turn: { status: 'completed', items: [] } });
    assert.equal(conv.handover, undefined);
  } finally { f.manager.close(); }
});

test('a handover with no readable context sends the thread options through untouched', async () => {
  const f = fixture({ handoverContext: () => '   ' });
  try {
    f.conversations.get('one')!.handover = handedOver();
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

test('a Codex thread can be condensed for a handover back to Claude', async () => {
  const f = fixture();
  try {
    f.conversations.get('one')!.handover = handedOver();
    await f.manager.snapshot('one');
    f.event('item/completed', 'thread-1', { item: { id: 'u', type: 'userMessage', content: [{ text: 'fix the build' }] } });
    f.event('item/completed', 'thread-1', { item: { id: 'a', type: 'agentMessage', text: 'build is green' } });
    f.event('item/completed', 'thread-1', { item: { id: 'c', type: 'commandExecution', command: 'npm test', aggregatedOutput: 'ok' } });
    const text = await f.manager.historyText('one');
    assert.equal(text, 'USER: fix the build\n\nASSISTANT: build is green'); // Tools and the handover note are left out.

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
