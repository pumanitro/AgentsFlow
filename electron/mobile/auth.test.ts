import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAuthService, hashToken, mintToken } from './auth';
import { createDeviceStore } from './devices';
import { MOBILE_OWNER_HEADER, MOBILE_PAIR_SCHEME } from '../../shared/mobile';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mobile-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const logs: { msg: string; data?: Record<string, unknown> }[] = [];

function setup(opts: { devMode?: boolean; owner?: string } = {}) {
  let t = Date.parse('2026-10-28T10:00:00Z');
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const devices = createDeviceStore(path.join(tmp, `d${n++}.json`), clock.now);
  const auth = createAuthService({ devices, devMode: opts.devMode ?? false, ownerLogin: () => opts.owner ?? 'me@example.com', log: (msg, data) => logs.push({ msg, data }), now: clock.now });
  return { auth, devices, clock };
}

test('hashToken is sha256 hex; mintToken is 32 random bytes base64url', () => {
  assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const t = mintToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(t, mintToken());
});

test('pairing offer shape', () => {
  const { auth } = setup();
  const o = auth.createPairingCode('https://mac.tail.ts.net', 'ab12');
  assert.match(o.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  assert.equal(o.qr, `${MOBILE_PAIR_SCHEME}?url=${encodeURIComponent('https://mac.tail.ts.net')}&code=${o.code}&fp=ab12`);
  assert.equal(o.expiresAt, '2026-10-28T10:02:00.000Z');
  assert.deepEqual(auth.currentOffer(), o);
  const o2 = auth.createPairingCode('u', '');
  assert.equal(auth.currentOffer()?.code, o2.code);
  if (o.code !== o2.code) assert.equal(auth.redeemPairingCode(o.code, 'p', '1.1.1.1'), null, 'a replaced offer is dead');
});

test('pairing code expires after 120 s', () => {
  const { auth, clock } = setup();
  const o = auth.createPairingCode('u', '');
  clock.advance(119_000);
  assert.ok(auth.currentOffer());
  clock.advance(1_000);
  assert.equal(auth.currentOffer(), null);
  assert.equal(auth.redeemPairingCode(o.code, 'Pixel', '100.64.0.2'), null);
});

test('redeem is case/dash-insensitive and single-use', () => {
  const { auth, devices } = setup();
  const o = auth.createPairingCode('u', '');
  const sloppy = o.code.toLowerCase().replace('-', ' ');
  const r = auth.redeemPairingCode(sloppy, '  My Galaxy S25+  ', '100.64.0.2');
  assert.ok(r);
  assert.equal(r.device.name, 'My Galaxy S25+');
  assert.deepEqual(r.device.scopes, ['view', 'talk']);
  assert.match(r.device.id, /^[0-9a-f]{12}$/);
  assert.equal(r.device.tokenHash, hashToken(r.token));
  assert.equal(devices.findByTokenHash(hashToken(r.token))?.id, r.device.id);
  assert.equal(auth.currentOffer(), null);
  assert.equal(auth.redeemPairingCode(o.code, 'again', '100.64.0.2'), null);
  assert.ok(!JSON.stringify(logs).includes(r.token), 'token never logged');
});

test('wrong code is rejected, name falls back to phone', () => {
  const { auth } = setup();
  const o = auth.createPairingCode('u', '');
  assert.equal(auth.redeemPairingCode('ZZZZ-ZZZZ' === o.code ? 'YYYY-YYYY' : 'ZZZZ-ZZZZ', 'x', 'ip'), null);
  assert.ok(auth.currentOffer(), 'a wrong guess does not burn the offer');
  assert.equal(auth.redeemPairingCode(o.code, '   ', 'ip')?.device.name, 'phone');
  auth.createPairingCode('u', '');
  auth.cancelPairing();
  assert.equal(auth.currentOffer(), null);
});

test('authenticate: owner header, bearer, revoked', () => {
  const { auth, devices, clock } = setup();
  const o = auth.createPairingCode('u', '');
  const { token, device } = auth.redeemPairingCode(o.code, 'p', 'ip')!;
  const owner = { [MOBILE_OWNER_HEADER]: 'ME@example.com' };
  const ok = auth.authenticate({ ...owner, authorization: `Bearer ${token}` }, '100.64.0.9');
  assert.equal(ok.ok, true);
  clock.advance(1);
  assert.equal(devices.get(device.id)?.lastIp, '100.64.0.9');

  const noOwner = auth.authenticate({ authorization: `Bearer ${token}` }, 'a');
  assert.deepEqual(noOwner.ok ? null : [noOwner.status, noOwner.code], [403, 'forbidden']);
  const wrongOwner = auth.authenticate({ [MOBILE_OWNER_HEADER]: 'evil@x.com', authorization: `Bearer ${token}` }, 'a');
  assert.equal(wrongOwner.ok ? 0 : wrongOwner.status, 403);
  const noBearer = auth.authenticate(owner, 'a');
  assert.deepEqual(noBearer.ok ? null : [noBearer.status, noBearer.code], [401, 'unauthorized']);
  const badToken = auth.authenticate({ ...owner, authorization: 'Bearer nope' }, 'a');
  assert.equal(badToken.ok ? 0 : badToken.status, 401);

  devices.revoke(device.id);
  const revoked = auth.authenticate({ ...owner, authorization: `Bearer ${token}` }, 'a');
  assert.deepEqual(revoked.ok ? null : [revoked.status, revoked.code, revoked.error], [401, 'unauthorized', 'unknown or revoked device']);
});

test('empty ownerLogin fails closed outside dev mode; dev mode skips the owner check', () => {
  assert.equal(setup({ owner: '' }).auth.ownerOk({ [MOBILE_OWNER_HEADER]: '' }), false);
  assert.equal(setup({ owner: '' }).auth.ownerOk({}), false);
  assert.equal(setup({ devMode: true, owner: '' }).auth.ownerOk({}), true);
});

test('auth failures are rate limited per IP after 20/min', () => {
  const { auth, clock } = setup();
  const h = { [MOBILE_OWNER_HEADER]: 'me@example.com', authorization: 'Bearer nope' };
  for (let i = 0; i < 20; i++) assert.equal((auth.authenticate(h, '9.9.9.9') as { status: number }).status, 401);
  assert.equal((auth.authenticate(h, '9.9.9.9') as { status: number }).status, 429);
  assert.equal((auth.authenticate(h, '8.8.8.8') as { status: number }).status, 401);
  clock.advance(60_001);
  assert.equal((auth.authenticate(h, '9.9.9.9') as { status: number }).status, 401);
});

test('allow is a sliding window', () => {
  const { auth, clock } = setup();
  for (let i = 0; i < 5; i++) { assert.equal(auth.allow('k', 5, 60_000), true); clock.advance(10_000); }
  assert.equal(auth.allow('k', 5, 60_000), false);   // t=50s, 5 in window
  clock.advance(10_001);                             // first one slid out
  assert.equal(auth.allow('k', 5, 60_000), true);
});
