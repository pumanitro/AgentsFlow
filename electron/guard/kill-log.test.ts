import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { KillLogEntry } from '../../shared/types';
import { appendKillLog, parseKillLogLine, readKillLogSince } from './kill-log';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-kills-')), 'locks', 'memguard-kills.jsonl');
}
const A: KillLogEntry = { at: '2026-10-11T09:41:00.000Z', by: 'peersflow-guard', kind: 'container', name: 'arrow-db-1', dry: true, reason: 'memory critical — idle 2h13m, project arrow', projectDir: '/Users/iij/IdeaProjects/arrow' };
const B: KillLogEntry = { at: '2026-10-11T09:41:30.000Z', by: 'memguard-system', kind: 'process-group', name: 'vitest', dry: false, reason: 'critical', pgid: 4242, family: 'vitest', cmd: 'node vitest run', cwd: '/Users/iij/IdeaProjects/atlas-of-doors', claudePid: 55037, sessionId: 'abc12345-0000' };

test('parseKillLogLine: a guard entry and a launchd-memguard entry round-trip', () => {
  assert.deepEqual(parseKillLogLine(JSON.stringify(A)), A);
  assert.deepEqual(parseKillLogLine(JSON.stringify(B) + '\n'), B);
});

test('parseKillLogLine: junk, wrong writers and missing fields are rejected', () => {
  assert.equal(parseKillLogLine(''), null);
  assert.equal(parseKillLogLine('not json'), null);
  assert.equal(parseKillLogLine('[]'), null);
  assert.equal(parseKillLogLine(JSON.stringify({ ...A, by: 'someone-else' })), null);
  assert.equal(parseKillLogLine(JSON.stringify({ ...A, kind: 'vm' })), null);
  assert.equal(parseKillLogLine(JSON.stringify({ ...A, name: '' })), null);
  assert.equal(parseKillLogLine(JSON.stringify({ ...A, dry: 'yes' })), null);
  assert.equal(parseKillLogLine(JSON.stringify({ ...A, at: 'yesterday' })), null);
});

test('parseKillLogLine: unknown extra keys and wrongly typed optionals are dropped', () => {
  const e = parseKillLogLine(JSON.stringify({ ...A, pgid: 'x', extra: 1, reason: undefined }));
  assert.deepEqual(e, { at: A.at, by: A.by, kind: A.kind, name: A.name, dry: true, reason: '', projectDir: A.projectDir });
});

test('kill log: a missing file reads as empty at the same offset', () => {
  assert.deepEqual(readKillLogSince(0, tmpFile()), { entries: [], offset: 0 });
});

test('kill log: append creates the directory and writes one JSON line per entry', () => {
  const f = tmpFile();
  appendKillLog(A, f);
  appendKillLog(B, f);
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '');
  assert.deepEqual(JSON.parse(lines[0]), A);
});

test('kill log: read-since returns only what was appended after the offset', () => {
  const f = tmpFile();
  appendKillLog(A, f);
  const first = readKillLogSince(0, f);
  assert.deepEqual(first.entries, [A]);
  assert.equal(first.offset, fs.statSync(f).size);
  assert.deepEqual(readKillLogSince(first.offset, f), { entries: [], offset: first.offset });
  appendKillLog(B, f);
  const second = readKillLogSince(first.offset, f);
  assert.deepEqual(second.entries, [B]);
  assert.equal(second.offset, fs.statSync(f).size);
});

test('kill log: a half-written last line is left for the next read', () => {
  const f = tmpFile();
  appendKillLog(A, f);
  const half = JSON.stringify(B);
  fs.appendFileSync(f, half.slice(0, 40));
  const r1 = readKillLogSince(0, f);
  assert.deepEqual(r1.entries, [A]);
  fs.appendFileSync(f, half.slice(40) + '\n');
  assert.deepEqual(readKillLogSince(r1.offset, f).entries, [B]);
});

test('kill log: a bad line between good ones is skipped, non-ASCII survives the byte offset', () => {
  const f = tmpFile();
  appendKillLog({ ...A, reason: 'pamięć krytyczna — zażółć' }, f);
  const r1 = readKillLogSince(0, f);
  fs.appendFileSync(f, 'garbage line\n');
  appendKillLog(B, f);
  assert.equal(r1.entries[0].reason, 'pamięć krytyczna — zażółć');
  assert.deepEqual(readKillLogSince(r1.offset, f).entries, [B]);
});

test('kill log: a file that shrank (rotated) is read again from the start', () => {
  const f = tmpFile();
  appendKillLog(A, f);
  appendKillLog(B, f);
  const { offset } = readKillLogSince(0, f);
  fs.writeFileSync(f, JSON.stringify(B) + '\n');
  const r = readKillLogSince(offset, f);
  assert.deepEqual(r.entries, [B]);
  assert.equal(r.offset, fs.statSync(f).size);
});

test('kill log: a nonsense offset is treated as the start', () => {
  const f = tmpFile();
  appendKillLog(A, f);
  assert.deepEqual(readKillLogSince(-5, f).entries, [A]);
  assert.deepEqual(readKillLogSince(NaN, f).entries, [A]);
});
