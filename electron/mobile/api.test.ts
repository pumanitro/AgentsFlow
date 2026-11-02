import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Conversation, TrackedDirectory } from '../../shared/types';
import type { ConversationSummary, FeedItem, MessagesPage } from '../../shared/mobile';
import type { ApiContext, DeviceRecord, GatewayDeps, GatewayServer, RouteCtx, RouteHandler, RouteScope, SendResult } from './types';
import { registerRoutes } from './api';
import { HttpError } from './server';

// Sibling modules (WP-11) are replaced on their CommonJS exports: api.ts reads
// them as `module.fn(...)` at call time, so the patch takes effect.
/* eslint-disable @typescript-eslint/no-var-requires */
const summariesMod = require('./summaries');
const tailerMod = require('./transcript-tailer');
const jobMod = require('./job-state');
const vocabMod = require('./vocabulary');
const patched: [any, string, unknown][] = [];
function patch(mod: any, name: string, fn: unknown): void { patched.push([mod, name, mod[name]]); mod[name] = fn; }

const calls = { page: [] as { file: string; o: { before?: number; limit: number } }[] };

beforeEach(() => {
  calls.page = [];
  patch(summariesMod, 'toSummary', (c: Conversation): ConversationSummary => ({
    id: c.id, peerId: c.directoryId, peerName: 'p', title: c.title, detail: '', state: c.state as never, rawState: c.state,
    needsYou: c.state === 'blocked', pinned: c.pinned, provider: c.provider ?? 'claude', chatKind: 'chat',
    createdAt: c.createdAt, updatedAt: c.createdAt, hasSession: !!c.sessionId,
  }));
  patch(summariesMod, 'orderSummaries', (list: ConversationSummary[], order: { id: string }[]) =>
    [...list].sort((a, b) => order.findIndex((x) => x.id === a.id) - order.findIndex((x) => x.id === b.id)));
  patch(summariesMod, 'filterSummaries', (list: ConversationSummary[], filter: string | null) =>
    filter === 'needs' ? list.filter((s) => s.needsYou) : list);
  patch(tailerMod, 'readMessagesPage', (file: string, o: { before?: number; limit: number }): MessagesPage => {
    calls.page.push({ file, o });
    return { entries: [], hasMore: false, cursor: 0, end: 10 };
  });
  patch(tailerMod, 'hasUserTextAfter', () => true);
  patch(jobMod, 'readJobSlice', () => null);
  patch(jobMod, 'sliceFromJobState', () => null);
  patch(vocabMod, 'buildVocabulary', (_d: unknown, extra: string[], at: string) => ({ words: ['x', ...extra], updatedAt: at }));
});
afterEach(() => { while (patched.length) { const [m, n, f] = patched.pop()!; m[n] = f; } });


// A HOME whose ~/.claude/skills/voice-task exists, so the /voice-task prompt is used.
function homeWithVoiceSkill(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-home-'));
  fs.mkdirSync(path.join(h, '.claude', 'skills', 'voice-task'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'skills', 'voice-task', 'SKILL.md'), '---\nname: voice-task\n---\n');
  return h;
}

// ---- fakes ----

const dir = (id: string, displayName: string, remote = false): TrackedDirectory =>
  ({ id, path: `/p/${id}`, displayName, addedAt: '', ...(remote ? { remote: { host: 'h' } as never } : {}) });

const conv = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  id, sessionId: `s-${id}`, daemonShort: `d-${id}`, sessionName: '', directoryId: 'a', directoryPath: '/p/a', displayName: '',
  title: `t-${id}`, description: '', pinned: true, state: 'working', status: '', intent: '', createdAt: '2026-10-01T00:00:00Z', lastPrompt: '',
  ...over,
} as Conversation);

const device: DeviceRecord = { id: 'dev1', name: 'phone', tokenHash: 'h', scopes: ['view', 'talk'], createdAt: 'c', lastSeenAt: 'l', cursor: 0 };

function fakeServer() {
  const routes = new Map<string, { scope: RouteScope; handler: RouteHandler }>();
  const server: GatewayServer = {
    addRoute(m, p, scope, handler) { routes.set(`${m} ${p}`, { scope, handler }); },
    onEvents() {}, listen: async () => 0, close: async () => {}, connections: () => 0,
  };
  const call = async (key: string, o: { params?: Record<string, string>; query?: string; body?: unknown } = {}) => {
    const r = routes.get(key);
    if (!r) throw new Error(`no route ${key}`);
    const rc: RouteCtx = { device, params: o.params ?? {}, query: new URLSearchParams(o.query ?? ''), body: o.body, ip: '127.0.0.1', devMode: true, headers: {} };
    return r.handler(rc) as Promise<any>;
  };
  return { server, routes, call };
}

function setup(over: Partial<GatewayDeps> = {}, ctxOver: Partial<ApiContext> = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-api-'));
  const transcript = path.join(tmp, 't.jsonl');
  fs.writeFileSync(transcript, '{"x":1}\n');
  const convs = [conv('c1'), conv('c2', { state: 'blocked' }), conv('c3', { provider: 'codex' }), conv('c4', { sessionId: '' })];
  const sends: Parameters<GatewayDeps['sendToSession']>[0][] = [];
  const spawns: Parameters<GatewayDeps['spawn']>[0][] = [];
  const noted: [string, string, string][] = [];
  let sendResult: SendResult = { ok: true, via: 'headless' };
  const idemMap = new Map<string, unknown>();
  const deps: GatewayDeps = {
    userDataDir: tmp, projectsRoot: tmp, jobsRoot: tmp, port: 0, devMode: true, appVersion: '1', env: {},
    store: {
      getDirectories: () => [dir('a', 'Alpha'), dir('l', 'LiSa', true)],
      getConversations: () => convs,
      getConversation: (id) => convs.find((c) => c.id === id) ?? null,
      getPinnedOrder: () => [{ kind: 'conversation', id: 'c2' }, { kind: 'conversation', id: 'c1' }, { kind: 'conversation', id: 'c3' }, { kind: 'conversation', id: 'c4' }],
    },
    liveRows: () => [],
    readJobState: (ds) => { assert.ok(ds, 'readJobState must not get an empty daemonShort'); return null; },
    jobStateMtimeMs: () => 0,
    findTranscript: () => transcript,
    sendToSession: async (o) => { sends.push(o); return sendResult; },
    stopAgent: async () => {},
    setPinned: () => {},
    spawn: async (r) => { spawns.push(r); return { conversationId: 'new1', sessionId: 's', daemonShort: 'd' }; },
    notifications: null,
    bus: new EventEmitter(),
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    log: () => {},
    now: () => Date.parse('2026-10-28T10:00:00Z'),
    ...over,
  };
  const fs_ = fakeServer();
  const feed: FeedItem[] = [1, 2, 3].map((seq) => ({ seq, kind: 'outcome', conversationId: 'c1', title: '', peerName: '', at: '', spoken: `s${seq}`, messageId: '' }));
  let stt: string | null = null;
  const ctx: ApiContext = {
    deps, server: fs_.server,
    auth: {
      authenticate: () => ({ ok: true, device }), ownerOk: () => true,
      createPairingCode: (url, fp) => ({ code: 'ABCD-EFGH', url, expiresAt: '', qr: '', fingerprint: fp }),
      currentOffer: () => null, cancelPairing: () => {},
      redeemPairingCode: (code) => (code === 'ABCD-EFGH' ? { token: 'tok', device } : null),
      allow: () => true,
    },
    devices: { settings: () => ({ ownerLogin: '', sttKey: '', vocabulary: ['peers'], paused: false, httpsPort: 8443 }) } as never,
    idem: { get: (k) => idemMap.get(k), set: (k, v) => { idemMap.set(k, v); }, flushSync: () => {} },
    feed: { append: () => { throw new Error('x'); }, after: (s) => feed.filter((f) => f.seq > s), latestSeq: () => 3, flushSync: () => {} },
    tailer: { subscribe: () => {}, unsubscribe: () => {}, stop: () => {} },
    heartbeat: { start() {}, stop() {}, lastOutage: () => null, startedAt: 0 },
    cliVersion: () => 'v', health: () => ({ ok: true } as never),
    pairUrl: () => 'http://10.0.2.2:1', fingerprint: () => '', sttKey: () => stt,
    noteSent: (c, t, s) => { noted.push([c, t, s]); },
    ...ctxOver,
  };
  registerRoutes(ctx);
  return {
    ...fs_, deps, ctx, sends, spawns, noted, idemMap,
    setSend: (r: SendResult) => { sendResult = r; },
    setStt: (k: string | null) => { stt = k; },
  };
}

async function rejects(p: Promise<unknown>, status: number, code?: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof HttpError && e.status === status && (!code || e.code === code));
}

// ---- tests ----

test('GET /ping answers without auth scope', async () => {
  const t = setup();
  assert.equal(t.routes.get('GET /ping')!.scope, 'none');
  assert.deepEqual(await t.call('GET /ping'), { ok: true, name: 'peersflow-mobile', v: 1 });
});

test('GET /peers maps tracked directories', async () => {
  const t = setup();
  assert.deepEqual(await t.call('GET /peers'), {
    peers: [{ id: 'a', name: 'Alpha', path: '/p/a', remote: false }, { id: 'l', name: 'LiSa', path: '/p/l', remote: true }],
  });
});

test('GET /me finds the LISA peer case-insensitively', async () => {
  const t = setup();
  const me = await t.call('GET /me');
  assert.equal(me.voicePeerId, 'l');
  assert.equal(me.device.id, 'dev1');
  assert.equal(me.device.tokenHash, undefined);
});

test('GET /conversations applies pinned order and filter=needs', async () => {
  const t = setup();
  const all = await t.call('GET /conversations');
  assert.deepEqual(all.summaries.map((s: ConversationSummary) => s.id), ['c2', 'c1', 'c3', 'c4']);
  const needs = await t.call('GET /conversations', { query: 'filter=needs' });
  assert.deepEqual(needs.summaries.map((s: ConversationSummary) => s.id), ['c2']);
});

test('GET /conversations does not read job state for a conversation without daemonShort', async () => {
  const t = setup({ store: { ...setup().deps.store, getConversations: () => [conv('x', { daemonShort: '' })], getPinnedOrder: () => [] } });
  const r = await t.call('GET /conversations');
  assert.equal(r.summaries.length, 1);
});

test('GET /conversations/:id 404s on an unknown id', async () => {
  const t = setup();
  await rejects(t.call('GET /conversations/:id', { params: { id: 'nope' } }), 404, 'not_found');
  const d = await t.call('GET /conversations/:id', { params: { id: 'c1' } });
  assert.equal(d.summary.id, 'c1');
  assert.equal(d.job, null);
});

test('GET messages passes before/limit through and clamps limit 999 to 200', async () => {
  const t = setup();
  await t.call('GET /conversations/:id/messages', { params: { id: 'c1' }, query: 'before=1234&limit=20' });
  await t.call('GET /conversations/:id/messages', { params: { id: 'c1' }, query: 'limit=999' });
  await t.call('GET /conversations/:id/messages', { params: { id: 'c1' } });
  assert.deepEqual(calls.page.map((c) => c.o), [{ before: 1234, limit: 20 }, { before: undefined, limit: 200 }, { before: undefined, limit: 50 }]);
});

test('GET messages for a conversation without a session is an empty page', async () => {
  const t = setup();
  assert.deepEqual(await t.call('GET /conversations/:id/messages', { params: { id: 'c4' } }), { entries: [], hasMore: false, cursor: 0, end: 0 });
  assert.equal(calls.page.length, 0);
});

test('GET messages for a Codex conversation maps the snapshot', async () => {
  const t = setup({
    codexSnapshot: async () => ({ conversationId: 'c3', threadId: 't', state: 'idle', requests: [], hasOlder: false,
      entries: [{ id: 'a', role: 'user', text: 'hi' }, { id: 'b', role: 'tool', text: 'ls' }, { id: 'c', role: 'assistant', text: 'yo' }] }),
  });
  const page = await t.call('GET /conversations/:id/messages', { params: { id: 'c3' } });
  assert.deepEqual(page.entries.map((e: any) => [e.id, e.kind, e.text]), [['codex:0', 'user.text', 'hi'], ['codex:2', 'assistant.text', 'yo']]);
  const t2 = setup();
  assert.deepEqual((await t2.call('GET /conversations/:id/messages', { params: { id: 'c3' } })).entries, []);
});

test('reply happy path sends once with a verify function', async () => {
  const t = setup();
  const r = await t.call('POST /conversations/:id/reply', { params: { id: 'c1' }, body: { text: 'hello', clientId: 'k1', source: 'voice' } });
  assert.deepEqual(r, { ok: true, via: 'headless' });
  assert.equal(t.sends.length, 1);
  assert.equal(t.sends[0].sessionId, 's-c1');
  assert.equal(t.sends[0].attachId, 'd-c1');
  assert.equal(typeof t.sends[0].verify, 'function');
  assert.equal(t.sends[0].verify!(), true);
  assert.deepEqual(t.noted, [['c1', 'hello', 'voice']]);
});

test('replayed clientId returns the cached body plus duplicate and does not send again', async () => {
  const t = setup();
  const first = await t.call('POST /conversations/:id/reply', { params: { id: 'c1' }, body: { text: 'hello', clientId: 'k1' } });
  const second = await t.call('POST /conversations/:id/reply', { params: { id: 'c1' }, body: { text: 'hello', clientId: 'k1' } });
  assert.deepEqual(second, { ...first, duplicate: true });
  assert.equal(t.sends.length, 1);
});

test('a failed send is not cached: the retry sends again', async () => {
  const t = setup();
  patch(tailerMod, 'hasUserTextAfter', () => false);   // the failed text never landed
  t.setSend({ ok: false, error: 'pty gone' });
  const a = await t.call('POST /conversations/:id/reply', { params: { id: 'c1' }, body: { text: 'hello', clientId: 'k2' } });
  assert.deepEqual(a, { ok: false, error: 'pty gone' });
  t.setSend({ ok: true, via: 'open-chat' });
  const b = await t.call('POST /conversations/:id/reply', { params: { id: 'c1' }, body: { text: 'hello', clientId: 'k2' } });
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, undefined);
  assert.equal(t.sends.length, 2);
});

test('reply validation, 404, Codex 503 and not-running 409', async () => {
  const t = setup();
  await rejects(t.call('POST /conversations/:id/reply', { params: { id: 'c1' }, body: { text: '', clientId: 'k' } }), 400, 'bad_request');
  await rejects(t.call('POST /conversations/:id/reply', { params: { id: 'c1' }, body: { text: 'x', clientId: 'k'.repeat(81) } }), 400);
  await rejects(t.call('POST /conversations/:id/reply', { params: { id: 'c1' }, body: { text: 'x'.repeat(20_001), clientId: 'k' } }), 400);
  await rejects(t.call('POST /conversations/:id/reply', { params: { id: 'zz' }, body: { text: 'x', clientId: 'k' } }), 404);
  await rejects(t.call('POST /conversations/:id/reply', { params: { id: 'c3' }, body: { text: 'x', clientId: 'k' } }), 503, 'unavailable');
  await rejects(t.call('POST /conversations/:id/reply', { params: { id: 'c4' }, body: { text: 'x', clientId: 'k' } }), 409, 'conflict');
  assert.equal(t.sends.length, 0);
});

test('reply to a session with no daemon and no live row is 409', async () => {
  const base = setup();
  const t = setup({ store: { ...base.deps.store, getConversation: () => conv('q', { daemonShort: '' }) } });
  await rejects(t.call('POST /conversations/:id/reply', { params: { id: 'q' }, body: { text: 'x', clientId: 'k' } }), 409);
  const t2 = setup({
    store: { ...base.deps.store, getConversation: () => conv('q', { daemonShort: '' }) },
    liveRows: () => [{ pid: 1, cwd: '/', kind: 'interactive', startedAt: 0, sessionId: 's-q' }],
  });
  assert.equal((await t2.call('POST /conversations/:id/reply', { params: { id: 'q' }, body: { text: 'x', clientId: 'k' } })).ok, true);
});

test('answer uses the same send path', async () => {
  const t = setup();
  const r = await t.call('POST /conversations/:id/answer', { params: { id: 'c2' }, body: { questionId: 'q1', text: 'Option A', clientId: 'a1' } });
  assert.equal(r.ok, true);
  assert.equal(t.sends[0].text, 'Option A');
});

test('spawn voice builds the /voice-task prompt, voice kind and until-done contract', async () => {
  const t = setup({ env: { HOME: homeWithVoiceSkill() } });
  const r = await t.call('POST /conversations', { body: { peerId: 'l', prompt: '  check the build  ', kind: 'voice', clientId: 'v1', spokenAt: '2026-10-28T09:00:00Z' } });
  assert.deepEqual(r, { conversationId: 'new1' });
  const s = t.spawns[0];
  assert.equal(s.chatKind, 'voice');
  assert.equal(s.contract, 'until-done');
  assert.ok(s.prompt.startsWith('/voice-task check the build'));
  assert.ok(s.prompt.includes('spokenAt: 2026-10-28T09:00:00Z'));
  assert.equal(s.title, 'check the build');
  assert.equal(s.dir.id, 'l');
  const again = await t.call('POST /conversations', { body: { peerId: 'l', prompt: 'x', kind: 'voice', clientId: 'v1' } });
  assert.deepEqual(again, { conversationId: 'new1', duplicate: true });
  assert.equal(t.spawns.length, 1);
});

test('spawn voice without spokenAt stamps now', async () => {
  const t = setup({ env: { HOME: homeWithVoiceSkill() } });
  await t.call('POST /conversations', { body: { peerId: 'l', prompt: 'x', kind: 'voice', clientId: 'v2' } });
  assert.ok(t.spawns[0].prompt.includes('spokenAt: 2026-10-28T10:00:00.000Z'));
});

test('spawn chat passes the prompt verbatim', async () => {
  const t = setup();
  await t.call('POST /conversations', { body: { peerId: 'a', prompt: '  raw prompt\n', kind: 'chat', clientId: 'c1', model: 'opus', contract: 'once' } });
  const s = t.spawns[0];
  assert.equal(s.prompt, '  raw prompt\n');
  assert.equal(s.chatKind, 'chat');
  assert.equal(s.contract, 'once');
  assert.equal(s.model, 'opus');
  assert.equal(s.title, undefined);
});

test('spawn errors: bad kind 400, unknown peer 404, spawn throwing 503', async () => {
  const t = setup({ spawn: async () => { throw new Error('no pty'); } });
  await rejects(t.call('POST /conversations', { body: { peerId: 'a', prompt: 'x', kind: 'nope', clientId: 'c' } }), 400);
  await rejects(t.call('POST /conversations', { body: { peerId: 'zz', prompt: 'x', kind: 'chat', clientId: 'c' } }), 404);
  await assert.rejects(t.call('POST /conversations', { body: { peerId: 'a', prompt: 'x', kind: 'chat', clientId: 'c' } }),
    (e: unknown) => e instanceof HttpError && e.status === 503 && e.message === 'no pty');
});

test('POST /pair returns sttKey only when one is set', async () => {
  const t = setup();
  const a = await t.call('POST /pair', { body: { code: 'ABCD-EFGH', deviceName: 'Galaxy' } });
  assert.equal(a.token, 'tok');
  assert.equal(a.deviceId, 'dev1');
  assert.equal(a.sttProvider, null);
  assert.equal('sttKey' in a, false);
  t.setStt('sk-test');
  const b = await t.call('POST /pair', { body: { code: 'ABCD-EFGH', deviceName: 'Galaxy' } });
  assert.equal(b.sttProvider, 'openai');
  assert.equal(b.sttKey, 'sk-test');
  await rejects(t.call('POST /pair', { body: { code: 'WRONG-CODE', deviceName: 'x' } }), 404, 'not_found');
  await rejects(t.call('POST /pair', { body: { code: 'abc', deviceName: 'x' } }), 400);
  await rejects(t.call('POST /pair', { body: { code: 'ABCD-EFGH', deviceName: 'x'.repeat(61) } }), 400);
});

test('POST /dev/pair-code uses the pair url', async () => {
  const t = setup();
  assert.equal(t.routes.get('POST /dev/pair-code')!.scope, 'dev');
  const o = await t.call('POST /dev/pair-code');
  assert.equal(o.url, 'http://10.0.2.2:1');
});

test('stop / done / reopen', async () => {
  const stops: [string, string | undefined][] = [];
  const pins: [string, boolean][] = [];
  const t = setup({ stopAgent: async (d, h) => { stops.push([d, h]); }, setPinned: (id, p) => { pins.push([id, p]); } });
  assert.deepEqual(await t.call('POST /conversations/:id/stop', { params: { id: 'c1' } }), { ok: true });
  assert.deepEqual(await t.call('POST /conversations/:id/done', { params: { id: 'c1' } }), { ok: true });
  assert.deepEqual(await t.call('POST /conversations/:id/reopen', { params: { id: 'c1' } }), { ok: true });
  assert.deepEqual(stops, [['d-c1', undefined]]);
  assert.deepEqual(pins, [['c1', false], ['c1', true]]);
  await rejects(t.call('POST /conversations/:id/stop', { params: { id: 'c3' } }), 503);
  await rejects(t.call('POST /conversations/:id/done', { params: { id: 'zz' } }), 404);
});

test('outcomes, notifications and vocabulary', async () => {
  const dismissed: string[] = [];
  const t = setup({
    notifications: {
      snapshot: () => ({ now: '', notifications: [
        { id: 'n1', level: 'action', title: 'T', body: 'B', createdAt: 'c', files: [], source: { kind: 'chat', conversationId: 'c1', peerName: 'Alpha' } },
        { id: 'n2', level: 'warn', title: 'old', createdAt: 'c', files: [], source: { kind: 'app' }, dismissedAt: 'd' },
      ] }),
      dismiss: (id) => { dismissed.push(id); },
    },
  });
  assert.deepEqual((await t.call('GET /outcomes', { query: 'after=1' })).items.map((i: FeedItem) => i.seq), [2, 3]);
  assert.deepEqual(await t.call('GET /notifications'), {
    notifications: [{ id: 'n1', level: 'action', title: 'T', body: 'B', createdAt: 'c', conversationId: 'c1', peerName: 'Alpha' }],
  });
  assert.deepEqual(await t.call('POST /notifications/:id/dismiss', { params: { id: 'n1' } }), { ok: true });
  assert.deepEqual(dismissed, ['n1']);
  const v = await t.call('GET /vocabulary');
  assert.deepEqual(v, { words: ['x', 'peers'], updatedAt: '2026-10-28T10:00:00.000Z' });
});


// ---- exactly-once across in-flight retries and restarts (bug found by the E2E harness) ----

test('a retry while the first send is still in flight waits for it and does not send again', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let sends = 0;
  const t = setup({ sendToSession: async () => { sends++; await gate; return { ok: true, via: 'headless' }; } });
  const a = t.call('POST /conversations/:id/reply', { params: { id: 'c1' }, body: { text: 'hello', clientId: 'k7' } });
  const b = t.call('POST /conversations/:id/reply', { params: { id: 'c1' }, body: { text: 'hello', clientId: 'k7' } });
  await new Promise((r) => setTimeout(r, 10));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(sends, 1);
  assert.equal(ra.ok, true);
  assert.equal(rb.duplicate, true);
});

test('a pending reply whose text already landed (app died before answering) is recovered, not resent', async () => {
  const t = setup();
  t.idemMap.set('reply:k8', { pending: true, file: '/x/t.jsonl', from: 0 });
  patch(tailerMod, 'hasUserTextAfter', () => true);
  const r = await t.call('POST /conversations/:id/reply', { params: { id: 'c1' }, body: { text: 'hello', clientId: 'k8' } });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, true);
  assert.equal(t.sends.length, 0);
  assert.deepEqual(t.idemMap.get('reply:k8'), { ok: true, via: 'headless' });
});

test('a pending reply whose text never landed is sent again, once', async () => {
  const t = setup();
  t.idemMap.set('reply:k9', { pending: true, file: '/x/t.jsonl', from: 0 });
  patch(tailerMod, 'hasUserTextAfter', () => false);
  const r = await t.call('POST /conversations/:id/reply', { params: { id: 'c1' }, body: { text: 'hello', clientId: 'k9' } });
  assert.equal(r.ok, true);
  assert.equal(t.sends.length, 1);
});

test('a spawn retried while the first is in flight creates one chat', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let spawns = 0;
  const t = setup({ spawn: async () => { spawns++; await gate; return { conversationId: 'new9', sessionId: 's', daemonShort: 'd' }; } });
  const body = { peerId: 'a', prompt: 'do it', kind: 'voice', clientId: 's7' };
  const a = t.call('POST /conversations', { body });
  const b = t.call('POST /conversations', { body });
  await new Promise((r) => setTimeout(r, 10));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(spawns, 1);
  assert.equal(ra.conversationId, 'new9');
  assert.equal(rb.conversationId, 'new9');
  assert.equal(rb.duplicate, true);
});


test('a voice task on a peer without the voice-task skill gets the brief inline instead of an unknown command', async () => {
  const t = setup({ env: { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-nohome-')) } });
  await t.call('POST /conversations', { body: { peerId: 'a', prompt: 'check the build', kind: 'voice', clientId: 'v9' } });
  const s = t.spawns[0];
  assert.ok(!s.prompt.startsWith('/voice-task'));
  assert.ok(s.prompt.includes('<spoken>'));
  assert.ok(s.prompt.includes('check the build'));
  assert.equal(s.chatKind, 'voice');
});
