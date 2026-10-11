import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { readPins, writePins } from './pins';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pins-'));
}
const DEFAULTS = { version: 1, keep: [], mode: 'dry-run', idleMinutes: 120 };

test('readPins: a missing file is the safe default — dry-run', () => {
  assert.deepEqual(readPins(path.join(tmp(), 'nope.json')), DEFAULTS);
});

test('readPins: unreadable JSON, an array or a scalar are the defaults too', () => {
  const dir = tmp();
  for (const body of ['{not json', '[]', '"live"', 'null', '']) {
    const f = path.join(dir, 'pins.json');
    fs.writeFileSync(f, body);
    assert.deepEqual(readPins(f), DEFAULTS, body);
  }
});

test('pins: write → read round-trip, and the directory is created', () => {
  const f = path.join(tmp(), 'locks', 'memguard-pins.json');
  writePins({ version: 1, keep: ['arrow-db-1', 'influence-postgres'], mode: 'live', idleMinutes: 45 }, f);
  assert.deepEqual(readPins(f), { version: 1, keep: ['arrow-db-1', 'influence-postgres'], mode: 'live', idleMinutes: 45 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { version: 1, keep: ['arrow-db-1', 'influence-postgres'], mode: 'live', idleMinutes: 45 });
});

test('writePins: atomic — no temp file is left beside it, and a rewrite replaces the whole file', () => {
  const dir = tmp();
  const f = path.join(dir, 'pins.json');
  writePins({ version: 1, keep: ['a', 'b', 'c'], mode: 'live', idleMinutes: 300 }, f);
  writePins({ version: 1, keep: [], mode: 'dry-run', idleMinutes: 120 }, f);
  assert.deepEqual(fs.readdirSync(dir), ['pins.json']);
  assert.deepEqual(readPins(f), DEFAULTS);
});

test('readPins: partial or hand-edited files fall back field by field', () => {
  const f = path.join(tmp(), 'pins.json');
  fs.writeFileSync(f, JSON.stringify({ keep: ['b', 'a', 'a', 7, ''] }));
  assert.deepEqual(readPins(f), { version: 1, keep: ['a', 'b'], mode: 'dry-run', idleMinutes: 120 });
  fs.writeFileSync(f, JSON.stringify({ mode: 'live', idleMinutes: -5, keep: 'redis' }));
  assert.deepEqual(readPins(f), { version: 1, keep: [], mode: 'live', idleMinutes: 120 });
});

test('readPins: only the exact word "live" turns the actor on', () => {
  const f = path.join(tmp(), 'pins.json');
  for (const mode of ['LIVE', 'Live', 'on', true, 1, 'live ', null]) {
    fs.writeFileSync(f, JSON.stringify({ mode }));
    assert.equal(readPins(f).mode, 'dry-run', String(mode));
  }
});
