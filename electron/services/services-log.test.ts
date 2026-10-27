import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { ServiceLogEntry } from '../../shared/services';
import { appendServiceLog, parseServiceLogLine, readServiceLogTail } from './services-log';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'services-log-')), 'pf', 'services-log.jsonl');
}
function entry(i: number, over: Partial<ServiceLogEntry> = {}): ServiceLogEntry {
  return { at: new Date(Date.UTC(2026, 9, 26, 9, i)).toISOString(), id: 'atlas-dashboard-api', name: 'Atlas dashboard — data service', event: i % 2 ? 'woke' : 'slept', by: i % 2 ? 'request' : 'idle', detail: `#${i}`, ...over };
}

test('parseServiceLogLine: a valid entry round-trips; junk and unknown words are rejected', () => {
  const e = entry(1, { by: 'pressure', event: 'proxy-armed' });
  assert.deepEqual(parseServiceLogLine(JSON.stringify(e) + '\n'), e);
  assert.equal(parseServiceLogLine(''), null);
  assert.equal(parseServiceLogLine('not json'), null);
  assert.equal(parseServiceLogLine('[]'), null);
  assert.equal(parseServiceLogLine(JSON.stringify({ ...e, event: 'exploded' })), null);
  assert.equal(parseServiceLogLine(JSON.stringify({ ...e, by: 'someone' })), null);
  assert.equal(parseServiceLogLine(JSON.stringify({ ...e, id: '' })), null);
  assert.equal(parseServiceLogLine(JSON.stringify({ ...e, at: 'yesterday' })), null);
});

test('parseServiceLogLine: a missing name falls back to the id, a missing detail to ""', () => {
  const { name: _n, detail: _d, ...rest } = entry(2);
  assert.deepEqual(parseServiceLogLine(JSON.stringify(rest)), { ...entry(2), name: 'atlas-dashboard-api', detail: '' });
});

test('services log: a missing file reads as empty', () => {
  assert.deepEqual(readServiceLogTail(tmpFile()), []);
});

test('services log: append creates the directory; the tail is newest first and capped', () => {
  const f = tmpFile();
  for (let i = 0; i < 40; i++) appendServiceLog(entry(i), f);
  assert.equal(fs.readFileSync(f, 'utf8').trim().split('\n').length, 40);
  const tail = readServiceLogTail(f);
  assert.equal(tail.length, 30);
  assert.equal(tail[0].detail, '#39');
  assert.equal(tail[29].detail, '#10');
  assert.deepEqual(readServiceLogTail(f, 3).map((e) => e.detail), ['#39', '#38', '#37']);
  assert.deepEqual(readServiceLogTail(f, 0), []);
});

test('services log: a torn last line and junk lines are skipped', () => {
  const f = tmpFile();
  appendServiceLog(entry(1), f);
  fs.appendFileSync(f, 'garbage\n');
  appendServiceLog(entry(2), f);
  fs.appendFileSync(f, JSON.stringify(entry(3)).slice(0, 25));
  assert.deepEqual(readServiceLogTail(f).map((e) => e.detail), ['#2', '#1']);
});

test('services log: a file longer than the read window still gives the newest entries', () => {
  const f = tmpFile();
  const lines: string[] = [];
  for (let i = 0; i < 3000; i++) lines.push(JSON.stringify(entry(i % 60, { detail: `#${i}` })));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.ok(fs.statSync(f).size > 256 * 1024);
  const tail = readServiceLogTail(f, 30);
  assert.equal(tail.length, 30);
  assert.equal(tail[0].detail, '#2999');
  assert.equal(tail[29].detail, '#2970');
});
