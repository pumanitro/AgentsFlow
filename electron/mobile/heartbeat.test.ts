import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHeartbeat } from './heartbeat';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-hb-')), 'mobile-heartbeat.json');
const T0 = Date.parse('2026-10-28T08:00:00Z');

test('no previous file ⇒ lastOutage is null and a beat is written', () => {
  const f = tmpFile();
  const hb = createHeartbeat(f, { now: () => T0 });
  hb.start();
  assert.equal(hb.lastOutage(), null);
  assert.equal(hb.startedAt, T0);
  const disk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(disk.at, new Date(T0).toISOString());
  assert.equal(disk.cleanShutdownAt, undefined);
  hb.stop();
});

test('stale previous file without a clean marker ⇒ clean false', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ at: '2026-10-28T03:47:00.000Z', startedAt: '2026-10-27T20:00:00.000Z' }));
  const hb = createHeartbeat(f, { now: () => T0 });
  hb.start();
  assert.deepEqual(hb.lastOutage(), { from: '2026-10-28T03:47:00.000Z', to: '2026-10-28T08:00:00.000Z', clean: false });
  hb.stop();
});

test('clean shutdown marker ⇒ clean true (stop → start round trip)', () => {
  const f = tmpFile();
  let t = T0;
  const a = createHeartbeat(f, { now: () => t });
  a.start();
  t += 60_000;
  a.stop();
  t += 3_600_000;
  const b = createHeartbeat(f, { now: () => t });
  b.start();
  const out = b.lastOutage()!;
  assert.equal(out.clean, true);
  assert.equal(out.from, new Date(T0 + 60_000).toISOString());
  assert.equal(out.to, new Date(t).toISOString());
  b.stop();
});

test('a clean marker older than the last beat ⇒ clean false', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ at: '2026-10-28T03:00:00.000Z', startedAt: 'x', cleanShutdownAt: '2026-10-27T03:00:00.000Z' }));
  const hb = createHeartbeat(f, { now: () => T0 });
  hb.start();
  assert.equal(hb.lastOutage()!.clean, false);
  hb.stop();
});

test('corrupt file is treated as no file', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{oops');
  const hb = createHeartbeat(f, { now: () => T0 });
  hb.start();
  assert.equal(hb.lastOutage(), null);
  hb.stop();
});
