import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createIdempotencyCache } from './idempotency';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mobile-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('get/set returns the stored result', () => {
  const c = createIdempotencyCache(path.join(tmp, 'a.json'));
  assert.equal(c.get('x'), undefined);
  c.set('x', { ok: true, via: 'headless' });
  assert.deepEqual(c.get('x'), { ok: true, via: 'headless' });
});

test('evicts the oldest beyond max', () => {
  const c = createIdempotencyCache(path.join(tmp, 'b.json'), 3);
  c.set('1', 1); c.set('2', 2); c.set('3', 3); c.set('4', 4);
  assert.equal(c.get('1'), undefined);
  assert.equal(c.get('2'), 2);
  assert.equal(c.get('4'), 4);
});

test('survives reload from disk', () => {
  const file = path.join(tmp, 'c.json');
  const c = createIdempotencyCache(file, 2);
  c.set('a', { conversationId: 'c1' }); c.set('b', 'B'); c.set('c', 'C');
  c.flushSync();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.entries.length, 2);
  const r = createIdempotencyCache(file, 2);
  assert.equal(r.get('a'), undefined);
  assert.equal(r.get('b'), 'B');
  assert.equal(r.get('c'), 'C');
  r.set('d', 'D');                    // cap still applies after reload
  assert.equal(r.get('b'), undefined);
});

test('debounced write lands without flushSync', async () => {
  const file = path.join(tmp, 'd.json');
  const c = createIdempotencyCache(file);
  c.set('k', 42);
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(createIdempotencyCache(file).get('k'), 42);
});

test('bad file starts empty', () => {
  const file = path.join(tmp, 'e.json');
  fs.writeFileSync(file, 'garbage');
  const c = createIdempotencyCache(file);
  assert.equal(c.get('anything'), undefined);
  c.set('z', 1);
  c.flushSync();
  assert.equal(createIdempotencyCache(file).get('z'), 1);
});
