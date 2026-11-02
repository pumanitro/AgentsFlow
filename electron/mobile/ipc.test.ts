import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOBILE_IPC } from '../../shared/mobile';
import type { MobileStatus, PairingOffer } from '../../shared/mobile';
import { registerMobileIpc } from './ipc';
import { makeMobileApi } from './preload-api';
import type { MobileGateway } from './types';

const baseStatus = (over: Partial<MobileStatus> = {}): MobileStatus => ({
  running: true, port: 47820, devMode: false, paused: false, connectedSockets: 0, devices: [],
  settings: { ownerLogin: '', sttKeySet: false, vocabulary: [], httpsPort: 8443 },
  tailnet: { available: false, serveOn: false }, pairing: null, ...over,
});

function fakeGateway() {
  const calls: [string, ...unknown[]][] = [];
  let status = baseStatus();
  const listeners: ((s: MobileStatus) => void)[] = [];
  const offer: PairingOffer = { code: 'ABC123', url: 'http://127.0.0.1:47820', expiresAt: new Date(Date.now() + 120000).toISOString(), qr: 'peersflow://pair?url=x&code=ABC123&fp=', fingerprint: '' };
  const g = {
    port: 47820,
    status: () => status,
    startPairing: () => { calls.push(['startPairing']); status = { ...status, pairing: offer }; return offer; },
    cancelPairing: () => { calls.push(['cancelPairing']); status = { ...status, pairing: null }; },
    revokeDevice: (id: string) => { calls.push(['revoke', id]); },
    revokeAll: () => { calls.push(['revokeAll']); },
    setPaused: (p: boolean) => { calls.push(['setPaused', p]); },
    setDeviceScopes: (id: string, s: unknown) => { calls.push(['setScopes', id, s]); },
    updateSettings: (patch: unknown) => { calls.push(['updateSettings', patch]); return { ...status.settings, ownerLogin: 'o' }; },
    onStatus: (cb: (s: MobileStatus) => void) => { listeners.push(cb); return () => undefined; },
    stop: async () => undefined,
  } as unknown as MobileGateway;
  return { g, calls, listeners, setStatus: (s: MobileStatus) => { status = s; } };
}

function setup(gw: MobileGateway | null) {
  const handlers = new Map<string, (...a: any[]) => any>();
  const pushed: MobileStatus[] = [];
  registerMobileIpc({ handle: (ch, fn) => { handlers.set(ch, fn); } }, () => gw, (s) => pushed.push(s));
  const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({}, ...a);
  return { handlers, pushed, call };
}

test('status before the gateway exists', async () => {
  const { call } = setup(null);
  const s = await call(MOBILE_IPC.status);
  assert.equal(s.running, false);
  assert.equal(s.lastError, 'gateway not running');
  assert.deepEqual(s.settings, { ownerLogin: '', sttKeySet: false, vocabulary: [], httpsPort: 8443 });
});

test('registers every request channel', () => {
  const { handlers } = setup(null);
  for (const k of ['status', 'startPairing', 'cancelPairing', 'revoke', 'revokeAll', 'setPaused', 'setScopes', 'updateSettings'] as const) {
    assert.ok(handlers.has(MOBILE_IPC[k]), k);
  }
});

test('every channel round-trips and pushes', async () => {
  const f = fakeGateway();
  const { call, pushed } = setup(f.g);
  const offer = await call(MOBILE_IPC.startPairing);
  assert.ok(offer.qrDataUrl.startsWith('data:image/png;base64,'));
  assert.equal(pushed.at(-1)!.pairing!.qrDataUrl, offer.qrDataUrl);
  await call(MOBILE_IPC.revoke, 'd1');
  await call(MOBILE_IPC.revokeAll);
  await call(MOBILE_IPC.setPaused, true);
  await call(MOBILE_IPC.setScopes, 'd1', ['view', 'admin']);
  const settings = await call(MOBILE_IPC.updateSettings, { ownerLogin: 'o' });
  assert.equal(settings.ownerLogin, 'o');
  await call(MOBILE_IPC.cancelPairing);
  assert.deepEqual(f.calls, [
    ['startPairing'], ['revoke', 'd1'], ['revokeAll'], ['setPaused', true],
    ['setScopes', 'd1', ['view', 'admin']], ['updateSettings', { ownerLogin: 'o' }], ['cancelPairing'],
  ]);
  assert.equal(pushed.length, 7);
  assert.equal(pushed.at(-1)!.pairing, null);
});

test('status carries a cached qrDataUrl for the live code', async () => {
  const f = fakeGateway();
  const { call } = setup(f.g);
  await call(MOBILE_IPC.startPairing);
  const a = await call(MOBILE_IPC.status);
  const b = await call(MOBILE_IPC.status);
  assert.ok(a.pairing.qrDataUrl.startsWith('data:image/png;base64,'));
  assert.equal(a.pairing.qrDataUrl, b.pairing.qrDataUrl);
});

test('gateway status events are pushed with a QR once subscribed', async () => {
  const f = fakeGateway();
  const { call, pushed } = setup(f.g);
  await call(MOBILE_IPC.status);
  assert.equal(f.listeners.length, 1);
  await call(MOBILE_IPC.status);
  assert.equal(f.listeners.length, 1);
  f.listeners[0](baseStatus({ pairing: { code: 'ZZZ', url: 'u', expiresAt: '', qr: 'peersflow://pair?code=ZZZ', fingerprint: '' } }));
  // QR rendering is async and slower under load: wait for the push instead of a fixed 50 ms.
  for (let i = 0; i < 100 && !pushed.at(-1)?.pairing?.qrDataUrl; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(pushed.at(-1)!.pairing!.qrDataUrl!.startsWith('data:image/png;base64,'));
});

test('late gateway is picked up by polling', async () => {
  const f = fakeGateway();
  let gw: MobileGateway | null = null;
  const handlers = new Map<string, (...a: any[]) => any>();
  registerMobileIpc({ handle: (ch, fn) => { handlers.set(ch, fn); } }, () => gw, () => undefined);
  await handlers.get(MOBILE_IPC.status)!({});
  assert.equal(f.listeners.length, 0);
  gw = f.g;
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(f.listeners.length, 1);
});

test('preload api maps to channels', async () => {
  const invoked: unknown[][] = [];
  const ons = new Map<string, (...a: any[]) => void>();
  const api = makeMobileApi({
    invoke: async (ch, ...a) => { invoked.push([ch, ...a]); return undefined; },
    on: (ch, l) => { ons.set(ch, l); },
    removeListener: (ch, l) => { if (ons.get(ch) === l) ons.delete(ch); },
  });
  await api.status(); await api.startPairing(); await api.cancelPairing(); await api.revokeDevice('d'); await api.revokeAll();
  await api.setPaused(true); await api.setDeviceScopes('d', ['view']); await api.updateSettings({ sttKey: 'k' });
  assert.deepEqual(invoked.map((i) => i[0]), [
    'mobile:status', 'mobile:startPairing', 'mobile:cancelPairing', 'mobile:revoke', 'mobile:revokeAll', 'mobile:setPaused', 'mobile:setScopes', 'mobile:updateSettings',
  ]);
  assert.deepEqual(invoked[3], ['mobile:revoke', 'd']);
  assert.deepEqual(invoked[6], ['mobile:setScopes', 'd', ['view']]);
  let got: MobileStatus | null = null;
  const off = api.onUpdated((s) => { got = s; });
  ons.get('mobile:updated')!({}, baseStatus());
  assert.ok(got);
  off();
  assert.equal(ons.has('mobile:updated'), false);
});
