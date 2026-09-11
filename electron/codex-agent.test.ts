import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { CodexAgents, approvalResult, codexEntry } from './codex-agent';
import type { CodexRpc } from './codex-protocol';
import type { Conversation } from '../shared/types';

class FakeRpc extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  replies: any[] = [];
  next = 0;
  async start() {}
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/fork') return { thread: { id: `thread-${++this.next}` } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'thread/items/list') return { data: [{ item: { id: 'old', type: 'agentMessage', text: 'old response' } }], nextCursor: null };
    if (method === 'turn/start') {
      this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'turn' } } });
      return { turn: { id: 'turn', status: 'inProgress' } };
    }
    return {};
  }
  reply(id: string | number, result: any) { this.replies.push({ id, result }); }
  rejectRequest(id: string | number, error: string) { this.replies.push({ id, error }); }
  close() { this.emit('disconnected', new Error('closed')); }
}
function fixture() {
  const rpc = new FakeRpc();
  const conversations = new Map(['one', 'two'].map((id) => [id, { id, provider: 'codex', sessionId: '', directoryPath: `/work/${id}` } as Conversation]));
  const snapshots: any[] = [];
  const manager = new CodexAgents({
    get: (id) => conversations.get(id) || null,
    update: (id, p) => Object.assign(conversations.get(id)!, p),
    options: () => ({ sandbox: 'workspace-write', approvalPolicy: 'on-request' }),
    changed: (s) => snapshots.push(s),
  }, rpc as unknown as CodexRpc);
  const event = (method: string, threadId: string, extra: any) => rpc.emit('notification', { method, params: { threadId, ...extra } });
  return { manager, rpc, conversations, snapshots, event };
}

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
