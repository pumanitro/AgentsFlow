import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ConversationDetail, ConversationSummary, FeedItem, MessageEntry, ServerEvent } from '../../shared/mobile';
import type { UserNotification } from '../../shared/notifications';
import type { ApiContext, DeviceRecord, GatewayDeps } from './types';
import { createEventHub } from './events';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: ServerEvent[] = [];
  closedWith: number | null = null;
  pings = 0;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number) { if (this.readyState !== 1) return; this.readyState = 3; this.closedWith = code ?? 1000; this.emit('close'); }
  ping() { this.pings++; }
  terminate() { this.close(1006); }
  msg(m: unknown) { this.emit('message', Buffer.from(JSON.stringify(m))); }
  types() { return this.sent.map((e) => e.type); }
}

const device = (id = 'dev1'): DeviceRecord => ({ id, name: 'p', tokenHash: 'h', scopes: ['view'], createdAt: '', lastSeenAt: '', cursor: 0 });
const summary = (id: string, title = id): ConversationSummary => ({
  id, peerId: 'a', peerName: 'A', title, detail: '', state: 'working', rawState: 'working', needsYou: false, pinned: true,
  provider: 'claude', chatKind: 'chat', createdAt: '', updatedAt: '', hasSession: true,
});

function setup(o: { feedSize?: number; notifications?: UserNotification[] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-events-'));
  const file = path.join(tmp, 't.jsonl');
  fs.writeFileSync(file, '{"a":1}\n');
  const bus = new EventEmitter();
  const cursors: [string, number][] = [];
  const feed: FeedItem[] = Array.from({ length: o.feedSize ?? 5 }, (_, i) => ({
    seq: i + 1, kind: 'outcome', conversationId: 'c1', title: '', peerName: '', at: '', spoken: `s${i + 1}`, messageId: '',
  }));
  const tailSubs: { id: string; from: number; cb: (e: MessageEntry[], end: number) => void }[] = [];
  const tailUnsubs: string[] = [];
  let transcriptFor: (id: string) => string | null = () => file;
  let notifs = o.notifications ?? [];
  const deps = {
    store: {
      getConversation: (id: string) => ({ id, sessionId: `s-${id}`, directoryPath: tmp, provider: 'claude' }),
      getConversations: () => [], getDirectories: () => [], getPinnedOrder: () => [],
    },
    findTranscript: (_cwd: string, sid: string) => transcriptFor(sid.replace(/^s-/, '')),
    notifications: { snapshot: () => ({ now: '', notifications: notifs }), dismiss: () => {} },
    bus,
    log: () => {},
  } as unknown as GatewayDeps;
  const ctx = {
    deps,
    devices: { setCursor: (id: string, seq: number) => { cursors.push([id, seq]); } },
    feed: { after: (s: number) => feed.filter((f) => f.seq > s), latestSeq: () => feed.length },
    tailer: {
      subscribe: (id: string, _f: string, from: number, cb: (e: MessageEntry[], end: number) => void) => { tailSubs.push({ id, from, cb }); },
      unsubscribe: (id: string) => { tailUnsubs.push(id); },
      stop: () => {},
    },
    health: () => ({ ok: true, hostname: 'h' }),
  } as unknown as ApiContext;
  let list = [summary('c1'), summary('c2')];
  let summaryCalls = 0;
  let details: Record<string, ConversationDetail> = {};
  const seen: ConversationSummary[][] = [];
  const hub = createEventHub({
    ctx,
    summaries: () => { summaryCalls++; return list; },
    detail: (id) => details[id] ?? null,
    onSummaries: (l) => { seen.push(l); },
    tagEntries: (_id, entries) => entries.map((e) => (e.kind === 'user.text' ? { ...e, source: 'phone' as const } : e)),
  });
  return {
    hub, bus, cursors, tailSubs, tailUnsubs, seen, file,
    summaryCalls: () => summaryCalls,
    setList: (l: ConversationSummary[]) => { list = l; },
    setDetails: (d: Record<string, ConversationDetail>) => { details = d; },
    setTranscript: (f: (id: string) => string | null) => { transcriptFor = f; },
    setNotifs: (n: UserNotification[]) => { notifs = n; },
    connect: (dev = device()) => { const ws = new FakeSocket(); hub.attach(ws as never, dev); return ws; },
  };
}

test('hello replays feed after lastSeq in order, then conversations.updated; cursor ends at 5', () => {
  const t = setup();
  const ws = t.connect();
  ws.msg({ type: 'hello', lastSeq: 2 });
  assert.deepEqual(ws.types(), ['welcome', 'feed', 'feed', 'feed', 'conversations.updated']);
  assert.equal((ws.sent[0] as Extract<ServerEvent, { type: 'welcome' }>).seq, 5);
  assert.deepEqual(ws.sent.slice(1, 4).map((e) => (e as Extract<ServerEvent, { type: 'feed' }>).item.seq), [3, 4, 5]);
  assert.deepEqual((ws.sent[4] as Extract<ServerEvent, { type: 'conversations.updated' }>).summaries.map((s) => s.id), ['c1', 'c2']);
  assert.deepEqual(t.cursors, [['dev1', 3], ['dev1', 4], ['dev1', 5]]);
  t.hub.close();
});

test('a first message that is not hello closes the socket with 4000', () => {
  const t = setup();
  const ws = t.connect();
  ws.msg({ type: 'ping' });
  assert.equal(ws.closedWith, 4000);
  assert.equal(t.hub.count(), 0);
  t.hub.close();
});

test('ping answers pong; bad JSON answers error', () => {
  const t = setup();
  const ws = t.connect();
  ws.msg({ type: 'hello', lastSeq: 5 });
  ws.sent = [];
  ws.msg({ type: 'ping' });
  ws.emit('message', Buffer.from('{nope'));
  assert.deepEqual(ws.types(), ['pong', 'error']);
  t.hub.close();
});

test('subscribe streams messages.appended from the shared tailer, refcounted across sockets', () => {
  const t = setup();
  const a = t.connect(device('A'));
  const b = t.connect(device('B'));
  a.msg({ type: 'hello', lastSeq: 5, subscribe: ['c1'] });
  b.msg({ type: 'hello', lastSeq: 5 });
  b.msg({ type: 'subscribe', ids: ['c1'] });
  assert.equal(t.tailSubs.length, 1, 'one tailer subscription per conversation');
  assert.equal(t.tailSubs[0].id, 'c1');
  assert.equal(t.tailSubs[0].from, fs.statSync(t.file).size);
  a.sent = []; b.sent = [];
  t.tailSubs[0].cb([{ id: 'u:0', kind: 'user.text', at: '', text: 'hi' }], 99);
  for (const ws of [a, b]) {
    assert.deepEqual(ws.sent, [{ type: 'messages.appended', conversationId: 'c1', entries: [{ id: 'u:0', kind: 'user.text', at: '', text: 'hi', source: 'phone' }], end: 99 }]);
  }
  a.msg({ type: 'unsubscribe', ids: ['c1'] });
  assert.deepEqual(t.tailUnsubs, []);
  b.close();
  assert.deepEqual(t.tailUnsubs, ['c1']);
  t.hub.close();
});

test('a conversation without a transcript yet is retried until the file appears', async () => {
  const t = setup();
  let ready = false;
  t.setTranscript(() => (ready ? t.file : null));
  const ws = t.connect();
  ws.msg({ type: 'hello', lastSeq: 5, subscribe: ['c9'] });
  assert.equal(t.tailSubs.length, 0);
  ready = true;
  await sleep(1150);
  assert.equal(t.tailSubs.length, 1);
  t.hub.close();
});

test('subscribe sends conversation.detail, then only when it changes', async () => {
  const t = setup();
  const d1: ConversationDetail = { summary: summary('c1'), job: null };
  t.setDetails({ c1: d1 });
  const ws = t.connect();
  ws.msg({ type: 'hello', lastSeq: 5, subscribe: ['c1'] });
  assert.equal(ws.types().filter((x) => x === 'conversation.detail').length, 1);
  await sleep(1100);
  assert.equal(ws.types().filter((x) => x === 'conversation.detail').length, 1, 'unchanged detail is not resent');
  t.setDetails({ c1: { summary: summary('c1', 'renamed'), job: null } });
  await sleep(1100);
  assert.equal(ws.types().filter((x) => x === 'conversation.detail').length, 2);
  t.hub.close();
});

test('a conversations.changed burst (10 emits in 50 ms) yields one recompute', async () => {
  const t = setup();
  for (let i = 0; i < 10; i++) { t.bus.emit('conversations.changed'); await sleep(5); }
  await sleep(250);
  assert.equal(t.summaryCalls(), 1);
  assert.equal(t.seen.length, 1, 'onSummaries hook ran once');
  t.hub.close();
});

test('recompute: same ids ⇒ conversation.updated for changed rows only; new ids ⇒ conversations.updated', () => {
  const t = setup();
  const ws = t.connect();
  ws.msg({ type: 'hello', lastSeq: 5 });
  t.hub.recompute();            // baseline (ids differ from the empty start ⇒ full list)
  ws.sent = [];
  t.setList([summary('c1', 'changed'), summary('c2')]);
  t.hub.recompute();
  assert.deepEqual(ws.sent, [{ type: 'conversation.updated', summary: summary('c1', 'changed') }]);
  ws.sent = [];
  t.hub.recompute();
  assert.deepEqual(ws.sent, [], 'no change, nothing sent');
  t.setList([summary('c1', 'changed'), summary('c2'), summary('c3')]);
  t.hub.recompute();
  assert.deepEqual(ws.types(), ['conversations.updated']);
  t.hub.close();
});

test('notifications.changed broadcasts only new open notifications', () => {
  const n = (id: string, dismissedAt?: string): UserNotification => ({ id, level: 'action', title: id, createdAt: 'c', files: [], source: { kind: 'chat' }, ...(dismissedAt ? { dismissedAt } : {}) });
  const t = setup({ notifications: [n('old')] });
  const ws = t.connect();
  ws.msg({ type: 'hello', lastSeq: 5 });
  ws.sent = [];
  t.setNotifs([n('old'), n('new'), n('gone', 'x')]);
  t.bus.emit('notifications.changed');
  assert.deepEqual(ws.sent, [{ type: 'notification.added', notification: { id: 'new', level: 'action', title: 'new', createdAt: 'c' } }]);
  t.hub.close();
});

test('broadcastFeed advances cursors; closeDevice and close tear everything down', () => {
  const t = setup();
  const a = t.connect(device('A'));
  const b = t.connect(device('B'));
  a.msg({ type: 'hello', lastSeq: 5, subscribe: ['c1'] });
  b.msg({ type: 'hello', lastSeq: 5 });
  t.hub.broadcastFeed({ seq: 6, kind: 'outcome', conversationId: 'c1', title: '', peerName: '', at: '', spoken: 'x', messageId: '' });
  assert.deepEqual(t.cursors.slice(-2), [['A', 6], ['B', 6]]);
  assert.deepEqual(t.hub.connectedDeviceIds().sort(), ['A', 'B']);
  t.hub.closeDevice('A');
  assert.equal(a.closedWith, 4001);
  assert.deepEqual(t.tailUnsubs, ['c1']);
  assert.equal(t.hub.count(), 1);
  t.hub.close();
  assert.equal(b.closedWith, 1001);
  assert.equal(t.hub.count(), 0);
  assert.equal(t.bus.listenerCount('conversations.changed'), 0);
  assert.equal(t.bus.listenerCount('notifications.changed'), 0);
});
