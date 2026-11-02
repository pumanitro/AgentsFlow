import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import { createGatewayServer, HttpError, badRequest } from './server';
import { createAuthService } from './auth';
import { createDeviceStore } from './devices';
import { MOBILE_API_PREFIX, MOBILE_OWNER_HEADER } from '../../shared/mobile';
import type { GatewayServer, RouteCtx } from './types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mobile-'));
const OWNER = 'me@example.com';
const logs: { msg: string; data?: Record<string, unknown> }[] = [];
const servers: GatewayServer[] = [];
let n = 0;

function build(o: { devMode: boolean; paused?: () => boolean }) {
  const devices = createDeviceStore(path.join(tmp, `dev${n++}.json`));
  const auth = createAuthService({ devices, devMode: o.devMode, ownerLogin: () => OWNER, log: (m, d) => logs.push({ msg: m, data: d }) });
  const server = createGatewayServer({ port: 0, devMode: o.devMode, auth, log: (m, d) => logs.push({ msg: m, data: d }), paused: o.paused ?? (() => false) });
  servers.push(server);
  const pair = (scopes?: ('view' | 'talk' | 'admin')[]) => {
    const offer = auth.createPairingCode('u', '');
    const r = auth.redeemPairingCode(offer.code, 'phone', '127.0.0.1')!;
    if (scopes) devices.setScopes(r.device.id, scopes);
    return r;
  };
  return { devices, auth, server, pair };
}

interface Res { status: number; body: any; text: string }
function req(port: number, method: string, p: string, o: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: MOBILE_API_PREFIX + p, headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: any = null;
        try { body = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, body, text });
      });
    });
    r.on('error', reject);
    if (o.body !== undefined) r.write(o.body);
    r.end();
  });
}

const ownerH = { [MOBILE_OWNER_HEADER]: OWNER };
const bearer = (token: string) => ({ ...ownerH, authorization: `Bearer ${token}` });
const jsonH = (token: string) => ({ ...bearer(token), 'content-type': 'application/json' });

// ---- prod-mode server (devMode false) ----
const prod = build({ devMode: false, paused: () => pausedFlag });
let pausedFlag = false;
let prodPort = 0;
const seen: RouteCtx[] = [];
// ---- dev-mode server ----
const dev = build({ devMode: true });
let devPort = 0;

function routes(s: GatewayServer) {
  s.addRoute('GET', '/ping', 'none', () => ({ ok: true, name: 'peersflow-mobile', v: 1 }));
  s.addRoute('POST', '/pair', 'pair', () => ({ paired: true }));
  s.addRoute('POST', '/dev/pair-code', 'dev', () => ({ code: 'DEV' }));
  s.addRoute('GET', '/me', 'view', (ctx) => { seen.push(ctx); return { id: ctx.device?.id }; });
  s.addRoute('GET', '/conversations/:id', 'view', (ctx) => ({ id: ctx.params.id, filter: ctx.query.get('filter') }));
  s.addRoute('POST', '/conversations/:id/reply', 'talk', (ctx) => ({ echo: ctx.body }));
  s.addRoute('POST', '/conversations/:id/stop', 'talk', () => undefined);
  s.addRoute('POST', '/admin-only', 'admin', () => ({ ok: true }));
  s.addRoute('GET', '/conflict', 'view', () => { throw new HttpError(409, 'conflict', 'the chat is not running'); });
  s.addRoute('GET', '/bad', 'view', () => { throw badRequest('nope'); });
  s.addRoute('GET', '/boom', 'view', () => { throw new Error('secret internals at /Users/x'); });
}

let wsSeen: { ws: WebSocket; ctx: RouteCtx } | null = null;
before(async () => {
  routes(prod.server);
  routes(dev.server);
  prod.server.onEvents((ws, ctx) => { wsSeen = { ws: ws as unknown as WebSocket, ctx }; ws.send('hi'); });
  prodPort = await prod.server.listen();
  devPort = await dev.server.listen();
});
after(async () => {
  for (const s of servers) await s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('listen resolves a real port bound to loopback', () => {
  assert.ok(prodPort > 0 && devPort > 0 && prodPort !== devPort);
});

test('unpaired request to a view route -> 401 unauthorized', async () => {
  const r = await req(prodPort, 'GET', '/me', { headers: ownerH });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'unauthorized');
});

test('valid device gets 200 and ctx.device', async () => {
  const { token, device } = prod.pair();
  const r = await req(prodPort, 'GET', '/me', { headers: bearer(token) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: device.id });
  assert.equal(seen.at(-1)?.ip, '127.0.0.1');
});

test('route params and query are passed', async () => {
  const { token } = prod.pair();
  const r = await req(prodPort, 'GET', '/conversations/a%20b?filter=needs', { headers: bearer(token) });
  assert.deepEqual(r.body, { id: 'a b', filter: 'needs' });
});

test('revoked device -> 401', async () => {
  const { token, device } = prod.pair();
  prod.devices.revoke(device.id);
  const r = await req(prodPort, 'GET', '/me', { headers: bearer(token) });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'unauthorized');
});

test('wrong owner header with devMode false -> 403', async () => {
  const { token } = prod.pair();
  const r = await req(prodPort, 'GET', '/me', { headers: { [MOBILE_OWNER_HEADER]: 'evil@x.com', authorization: `Bearer ${token}` } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'forbidden');
});

test('missing owner header: 403 with devMode false, 200 with devMode true', async () => {
  const p = await req(prodPort, 'GET', '/ping');
  assert.equal(p.status, 403);
  assert.equal(p.body.code, 'forbidden');
  const { token } = prod.pair();
  assert.equal((await req(prodPort, 'GET', '/me', { headers: { authorization: `Bearer ${token}` } })).status, 403);
  const d = await req(devPort, 'GET', '/ping');
  assert.equal(d.status, 200);
  assert.deepEqual(d.body, { ok: true, name: 'peersflow-mobile', v: 1 });
  const dt = dev.pair();
  assert.equal((await req(devPort, 'GET', '/me', { headers: { authorization: `Bearer ${dt.token}` } })).status, 200);
});

test('talk route with a view-only device -> 403 forbidden', async () => {
  const { token } = prod.pair(['view']);
  const r = await req(prodPort, 'POST', '/conversations/c1/reply', { headers: jsonH(token), body: '{"text":"hi"}' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'forbidden');
});

test('admin route needs the admin scope', async () => {
  const { token, device } = prod.pair();
  assert.equal((await req(prodPort, 'POST', '/admin-only', { headers: bearer(token) })).status, 403);
  prod.devices.setScopes(device.id, ['view', 'talk', 'admin']);
  assert.equal((await req(prodPort, 'POST', '/admin-only', { headers: bearer(token) })).status, 200);
});

test('talk route with JSON body echoes; undefined return -> {ok:true}', async () => {
  const { token } = prod.pair();
  const r = await req(prodPort, 'POST', '/conversations/c1/reply', { headers: jsonH(token), body: '{"text":"hi","clientId":"x"}' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { echo: { text: 'hi', clientId: 'x' } });
  const s = await req(prodPort, 'POST', '/conversations/c1/stop', { headers: bearer(token) });
  assert.deepEqual([s.status, s.body], [200, { ok: true }]);
});

test('dev route: 200 from 127.0.0.1 in devMode, 404 with devMode false', async () => {
  const d = await req(devPort, 'POST', '/dev/pair-code');
  assert.deepEqual([d.status, d.body], [200, { code: 'DEV' }]);
  const p = await req(prodPort, 'POST', '/dev/pair-code', { headers: ownerH });
  const missing = await req(prodPort, 'POST', '/no/such/route', { headers: ownerH });
  assert.equal(p.status, 404);
  assert.deepEqual(p.body, missing.body, 'indistinguishable from a missing route');
  assert.equal((await req(prodPort, 'GET', '/dev/pair-code', { headers: ownerH })).status, 404);
});

test('paused -> 503 paused on a view route, but pair still answers', async () => {
  const { token } = prod.pair();
  pausedFlag = true;
  try {
    const r = await req(prodPort, 'GET', '/me', { headers: bearer(token) });
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: 'mobile access is paused on the Mac', code: 'paused' });
    const p = await req(prodPort, 'POST', '/pair', { headers: { ...ownerH, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(p.status, 200);
    assert.equal((await req(prodPort, 'GET', '/ping', { headers: ownerH })).status, 200);
  } finally { pausedFlag = false; }
});

test('6th pair-scoped request within a minute -> 429', async () => {
  const fresh = build({ devMode: true });
  fresh.server.addRoute('POST', '/pair', 'pair', () => ({ ok: true }));
  const port = await fresh.server.listen();
  for (let i = 0; i < 5; i++) assert.equal((await req(port, 'POST', '/pair')).status, 200);
  const r = await req(port, 'POST', '/pair');
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'rate_limited');
});

test('body > 256 KB -> 400', async () => {
  const { token } = prod.pair();
  const big = JSON.stringify({ text: 'x'.repeat(300 * 1024) });
  const r = await req(prodPort, 'POST', '/conversations/c1/reply', { headers: jsonH(token), body: big });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'bad_request');
});

test('invalid JSON -> 400; non-JSON content-type -> 400', async () => {
  const { token } = prod.pair();
  const r = await req(prodPort, 'POST', '/conversations/c1/reply', { headers: jsonH(token), body: '{nope' });
  assert.deepEqual([r.status, r.body.code], [400, 'bad_request']);
  const t = await req(prodPort, 'POST', '/conversations/c1/reply', { headers: { ...bearer(token), 'content-type': 'text/plain' }, body: 'hi' });
  assert.deepEqual([t.status, t.body.code], [400, 'bad_request']);
});

test('unknown route -> 404 JSON; method mismatch -> 400 bad_request', async () => {
  const r = await req(prodPort, 'GET', '/nope', { headers: ownerH });
  assert.deepEqual([r.status, r.body.code], [404, 'not_found']);
  const outside = await new Promise<number>((resolve) => http.get({ host: '127.0.0.1', port: prodPort, path: '/' }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }));
  assert.equal(outside, 404);
  const m = await req(prodPort, 'POST', '/ping', { headers: ownerH });
  assert.deepEqual([m.status, m.body.code], [400, 'bad_request']);
});

test('handler throwing HttpError(409) -> 409 with that body; badRequest -> 400', async () => {
  const { token } = prod.pair();
  const r = await req(prodPort, 'GET', '/conflict', { headers: bearer(token) });
  assert.deepEqual([r.status, r.body], [409, { error: 'the chat is not running', code: 'conflict' }]);
  const b = await req(prodPort, 'GET', '/bad', { headers: bearer(token) });
  assert.deepEqual([b.status, b.body], [400, { error: 'nope', code: 'bad_request' }]);
});

test('handler throwing a plain Error -> 500 with no stack in the body', async () => {
  const { token } = prod.pair();
  const r = await req(prodPort, 'GET', '/boom', { headers: bearer(token) });
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'internal error', code: 'unavailable' });
  assert.ok(!r.text.includes('secret') && !r.text.includes('at '), 'no internals leak');
  assert.ok(logs.some((l) => l.msg === 'route failed' && l.data?.path === `${MOBILE_API_PREFIX}/boom`));
});

function wsOpen(port: number, headers: Record<string, string>): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${MOBILE_API_PREFIX}/events`, { headers });
    ws.on('unexpected-response', (_req, res) => { resolve({ status: res.statusCode }); res.resume(); });
    ws.on('open', () => resolve({ ws }));
    ws.on('error', () => { /* reported via unexpected-response */ });
  });
}

test('WS upgrade without bearer -> 401 and connections() stays 0', async () => {
  const r = await wsOpen(prodPort, ownerH);
  assert.equal(r.status, 401);
  assert.equal(prod.server.connections(), 0);
});

test('WS upgrade with a valid token -> onEvents gets the socket and ctx.device', async () => {
  const { token, device } = prod.pair();
  // Listen before 'open': the server's greeting can arrive in the same chunk as the handshake.
  const ws = new WebSocket(`ws://127.0.0.1:${prodPort}${MOBILE_API_PREFIX}/events`, { headers: bearer(token) });
  const got = await new Promise<string>((resolve, reject) => { ws.once('message', (m) => resolve(String(m))); ws.once('error', reject); });
  assert.equal(got, 'hi');
  assert.equal(wsSeen?.ctx.device?.id, device.id);
  assert.equal(prod.server.connections(), 1);
  (wsSeen!.ws as WebSocket).close();
  for (let i = 0; i < 50 && prod.server.connections() > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(prod.server.connections(), 0);
});

test('close() terminates live sockets', async () => {
  const s = build({ devMode: true });
  s.server.onEvents(() => {});
  const port = await s.server.listen();
  const { token } = s.pair();
  const { ws } = await wsOpen(port, { authorization: `Bearer ${token}` });
  assert.ok(ws);
  const closed = new Promise<void>((r) => ws!.once('close', () => r()));
  await s.server.close();
  await closed;
  assert.equal(s.server.connections(), 0);
});
