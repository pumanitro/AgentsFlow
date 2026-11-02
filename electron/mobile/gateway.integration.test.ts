// End-to-end over real sockets: the real gateway (all sibling modules real),
// fake app deps, dev mode, port 0, temp userData. Skips itself while a sibling
// module is still a wave-0 stub ("not implemented"); the integrator re-runs it
// after wave 1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import type { Conversation, TrackedDirectory } from '../../shared/types';
import type { ServerEvent } from '../../shared/mobile';
import type { GatewayDeps, MobileGateway } from './types';
import { startMobileGateway } from './index';

const SKIP_MSG = 'a sibling module is still a wave-0 stub (not implemented) — re-run after wave 1';

function fakeDeps(userDataDir: string): GatewayDeps {
  const dirs: TrackedDirectory[] = [{ id: 'peer1', path: '/tmp/scratch', displayName: 'Scratch', addedAt: '2026-10-28T00:00:00Z' }];
  const convs: Conversation[] = [{
    id: 'c1', sessionId: '', daemonShort: '', sessionName: '', directoryId: 'peer1', directoryPath: '/tmp/scratch', displayName: 'Scratch',
    title: 'hello', description: '', pinned: true, state: 'idle', status: '', intent: '', createdAt: '2026-10-28T00:00:00Z', lastPrompt: '',
  } as Conversation];
  return {
    userDataDir, projectsRoot: userDataDir, jobsRoot: userDataDir, port: 0, devMode: true, appVersion: 'test', env: {},
    store: {
      getDirectories: () => dirs, getConversations: () => convs,
      getConversation: (id) => convs.find((c) => c.id === id) ?? null,
      getPinnedOrder: () => [{ kind: 'conversation', id: 'c1' }],
    },
    liveRows: () => [], readJobState: () => null, jobStateMtimeMs: () => 0, findTranscript: () => null,
    sendToSession: async () => ({ ok: false, error: 'fake' }), stopAgent: async () => {}, setPinned: () => {},
    spawn: async () => { throw new Error('fake'); }, notifications: null,
    bus: new EventEmitter(),
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    log: () => {},
  };
}

async function start(t: { skip: (m: string) => void }): Promise<MobileGateway | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-gw-'));
  try {
    return await startMobileGateway(fakeDeps(dir));
  } catch (e) {
    if (/not implemented/.test(String(e))) { t.skip(`${SKIP_MSG}: ${String(e)}`); return null; }
    throw e;
  }
}

const netHandles = () => process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap' || r === 'TCPSocketWrap').length;

test('gateway: pair → peers → events hello, then stop within 2 s', async (t) => {
  const before = netHandles();
  const gw = await start(t);
  if (!gw) return;
  const base = `http://127.0.0.1:${gw.port}/api/v1`;
  try {
    const ping = await (await fetch(`${base}/ping`)).json();
    assert.deepEqual(ping, { ok: true, name: 'peersflow-mobile', v: 1 });

    const offerRes = await fetch(`${base}/dev/pair-code`, { method: 'POST' });
    assert.equal(offerRes.status, 200);
    const offer = await offerRes.json();
    assert.match(offer.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(offer.url, `http://10.0.2.2:${gw.port}`);

    const pairRes = await fetch(`${base}/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: offer.code, deviceName: 'e2e' }),
    });
    assert.equal(pairRes.status, 200);
    const pair = await pairRes.json();
    assert.ok(typeof pair.token === 'string' && pair.token.length > 20);
    assert.equal(pair.sttProvider, null);

    const auth = { authorization: `Bearer ${pair.token}` };
    assert.equal((await fetch(`${base}/peers`)).status, 401, 'unpaired client is refused');
    const peers = await (await fetch(`${base}/peers`, { headers: auth })).json();
    assert.deepEqual(peers, { peers: [{ id: 'peer1', name: 'Scratch', path: '/tmp/scratch', remote: false }] });

    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/api/v1/events`, { headers: auth });
    const got: ServerEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout; got ${got.map((e) => e.type).join(',')}`)), 3000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', lastSeq: 0 })));
      ws.on('message', (d) => {
        got.push(JSON.parse(d.toString()));
        if (got.some((e) => e.type === 'conversations.updated')) { clearTimeout(timer); resolve(); }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    assert.equal(got[0].type, 'welcome');
    assert.equal(got[got.length - 1].type, 'conversations.updated');
    assert.equal(gw.status().connectedSockets, 1);
    assert.equal(gw.status().devices.length, 1);
    const closed = new Promise((r) => ws.once('close', r));

    const t0 = Date.now();
    await gw.stop();
    assert.ok(Date.now() - t0 < 2000, `stop took ${Date.now() - t0} ms`);
    await closed;
  } finally {
    await gw.stop();
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(netHandles(), before, 'no TCP server or socket left open');
});

test('gateway: /api/v1/ping answers in dev mode and stop() resolves', async (t) => {
  const gw = await start(t);
  if (!gw) return;
  const r = await fetch(`http://127.0.0.1:${gw.port}/api/v1/ping`);
  assert.equal(r.status, 200);
  const t0 = Date.now();
  await gw.stop();
  assert.ok(Date.now() - t0 < 2000);
});
