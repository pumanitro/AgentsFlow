import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { emptyState, readState, writeState } from './state';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'services-state-'));
}
const EMPTY = { version: 1, lastUsedAt: {}, sleptAt: {}, wokeAt: {}, dockerQuietSince: null };

test('readState: a missing file is no history', () => {
  assert.deepEqual(readState(path.join(tmp(), 'nope.json')), EMPTY);
  assert.deepEqual(emptyState(), EMPTY);
});

test('readState: unreadable JSON, an array or a scalar are no history too', () => {
  const f = path.join(tmp(), 'services-state.json');
  for (const body of ['{not json', '[]', '7', 'null', '']) {
    fs.writeFileSync(f, body);
    assert.deepEqual(readState(f), EMPTY, body);
  }
});

test('state: write → read round-trip, the directory is created and no temp file is left', () => {
  const dir = tmp();
  const f = path.join(dir, 'sub', 'services-state.json');
  const s = { version: 1 as const, lastUsedAt: { 'atlas-dashboard-api': 1_700_000_000_000 }, sleptAt: { 'compose:arrow': 1_700_000_100_000 }, wokeAt: {}, dockerQuietSince: 1_700_000_200_000 };
  writeState(s, f);
  assert.deepEqual(readState(f), s);
  writeState(emptyState(), f);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['services-state.json']);
  assert.deepEqual(readState(f), EMPTY);
});

test('readState: bad clocks are dropped one by one', () => {
  const f = path.join(tmp(), 'services-state.json');
  fs.writeFileSync(f, JSON.stringify({ lastUsedAt: { a: 5, b: 'x', c: -1, d: null, '': 9 }, sleptAt: [1, 2], wokeAt: 'no', dockerQuietSince: 'soon' }));
  assert.deepEqual(readState(f), { version: 1, lastUsedAt: { a: 5 }, sleptAt: {}, wokeAt: {}, dockerQuietSince: null });
});
