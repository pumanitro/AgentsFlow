import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDeviceStore } from './devices';
import type { DeviceRecord } from './types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mobile-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const rec = (id: string, over: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: 'Pixel', tokenHash: 'h-' + id, scopes: ['view', 'talk'], createdAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-01T00:00:00.000Z', cursor: 0, ...over,
});

test('round-trips devices and settings through the file', () => {
  const file = path.join(tmp, 'rt.json');
  const s = createDeviceStore(file);
  s.add(rec('a'));
  s.setCursor('a', 7);
  s.updateSettings({ ownerLogin: '  Me@Example.com ', sttKey: 'sk-secret', paused: true });
  s.flushSync();
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
  const r = createDeviceStore(file);
  assert.equal(r.get('a')?.cursor, 7);
  assert.equal(r.findByTokenHash('h-a')?.id, 'a');
  assert.deepEqual(r.settings(), { ownerLogin: 'me@example.com', sttKey: 'sk-secret', vocabulary: [], paused: true, httpsPort: 8443, publicUrl: '' });
});

test('sanitising loader drops bad rows and fills defaults', () => {
  const file = path.join(tmp, 'bad.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, devices: [{ id: 'x', tokenHash: 'hx', scopes: ['view', 'root', 'talk'] }, { tokenHash: 'nope' }, { id: 5 }, null] }));
  const s = createDeviceStore(file);
  assert.equal(s.list().length, 1);
  assert.deepEqual(s.get('x')?.scopes, ['view', 'talk']);
  assert.equal(s.get('x')?.cursor, 0);
  assert.deepEqual(s.settings().vocabulary, []);
  fs.writeFileSync(file, '{not json');
  assert.equal(createDeviceStore(file).list().length, 0);
});

test('revoke blanks the hash so findByTokenHash misses', () => {
  const s = createDeviceStore(path.join(tmp, 'rv.json'));
  s.add(rec('a'));
  s.add(rec('b'));
  s.revoke('a');
  assert.equal(s.findByTokenHash('h-a'), null);
  assert.equal(s.findByTokenHash(''), null);
  assert.equal(s.get('a')?.tokenHash, '');
  assert.ok(s.get('a')?.revokedAt);
  assert.equal(s.list().length, 2);
  s.revokeAll();
  assert.equal(s.findByTokenHash('h-b'), null);
  assert.ok(s.list().every((d) => d.revokedAt && d.tokenHash === ''));
});

test('revoked rows are pruned after 30 days', () => {
  let t = Date.parse('2026-10-01T00:00:00Z');
  const file = path.join(tmp, 'prune.json');
  const s = createDeviceStore(file, () => t);
  s.add(rec('a'));
  s.revoke('a');
  t += 29 * 86_400_000;
  assert.equal(s.list().length, 1);
  t += 2 * 86_400_000;
  assert.equal(s.list().length, 0);
});

test('setScopes always keeps view and drops unknown scopes', () => {
  const s = createDeviceStore(path.join(tmp, 'sc.json'));
  s.add(rec('a'));
  s.setScopes('a', ['admin']);
  assert.deepEqual(s.get('a')?.scopes, ['view', 'admin']);
  s.setScopes('a', ['bogus' as never]);
  assert.deepEqual(s.get('a')?.scopes, ['view']);
});

test('updateSettings dedupes and trims vocabulary, caps at 200', () => {
  const s = createDeviceStore(path.join(tmp, 'voc.json'));
  assert.deepEqual(s.updateSettings({ vocabulary: ['a', 'a', ' b '] }).vocabulary, ['a', 'b']);
  const many = Array.from({ length: 300 }, (_, i) => 'w' + i);
  assert.equal(s.updateSettings({ vocabulary: many }).vocabulary.length, 200);
  assert.equal(s.settings().vocabulary.length, 200);
});

test('touch updates in memory without a write storm', async () => {
  let t = 1_000_000;
  const file = path.join(tmp, 'touch.json');
  const s = createDeviceStore(file, () => t);
  s.add(rec('a'));
  s.flushSync();
  const m0 = fs.readFileSync(file, 'utf8');
  s.touch('a', '100.64.0.2', '2026-10-02T00:00:00.000Z');   // first touch: allowed to schedule
  await new Promise((r) => setTimeout(r, 250));
  const m1 = fs.readFileSync(file, 'utf8');
  assert.notEqual(m1, m0);
  t += 5_000;
  s.touch('a', '100.64.0.3', '2026-10-02T00:00:05.000Z');   // within 30 s: memory only
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(fs.readFileSync(file, 'utf8'), m1);
  assert.equal(s.get('a')?.lastIp, '100.64.0.3');
  t += 30_000;
  s.touch('a', '100.64.0.4', '2026-10-02T00:00:35.000Z');
  await new Promise((r) => setTimeout(r, 250));
  assert.match(fs.readFileSync(file, 'utf8'), /100\.64\.0\.4/);
});
