import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { consumeDeferredMarker, listDeferredMarkers, parseDeferredMarker } from './deferred-markers';
import { DEFERRED_TTL_MS } from './paths';

// The marker the admission hook writes (schema 1), as in PLAN "Done means" #4.
const NOW = Date.parse('2026-10-11T09:45:00.000Z');

function markerJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1, at: '2026-10-11T09:41:00.000Z', sessionId: 'abc12345-0000', cwd: '/tmp', transcriptPath: '/tmp/t.jsonl',
    toolName: 'Agent', what: 'spawn: probe', subagentType: 'general-purpose', model: 'haiku',
    reason: 'memory is tight', availGB: 5, state: 'critical', ...over,
  });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-deferred-'));
}

function put(dir: string, name: string, text: string, mtimeMs: number = NOW - 60_000): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('parseDeferredMarker: a valid marker comes back whole', () => {
  assert.deepEqual(parseDeferredMarker(markerJson()), {
    schema: 1, at: '2026-10-11T09:41:00.000Z', sessionId: 'abc12345-0000', cwd: '/tmp', transcriptPath: '/tmp/t.jsonl',
    toolName: 'Agent', what: 'spawn: probe', subagentType: 'general-purpose', model: 'haiku',
    reason: 'memory is tight', availGB: 5, state: 'critical',
  });
});

test('parseDeferredMarker: optional fields may be absent, availGB may be null', () => {
  const m = parseDeferredMarker(markerJson({ subagentType: undefined, model: undefined, availGB: null }));
  assert.ok(m);
  assert.equal(m.availGB, null);
  assert.equal('subagentType' in m, false);
  assert.equal('model' in m, false);
});

test('parseDeferredMarker: rubbish, another schema, no session or no time ⇒ null', () => {
  assert.equal(parseDeferredMarker('{"schema":1,"at":"2026-10-11T09:41'), null);
  assert.equal(parseDeferredMarker(''), null);
  assert.equal(parseDeferredMarker('[]'), null);
  assert.equal(parseDeferredMarker('null'), null);
  assert.equal(parseDeferredMarker(markerJson({ schema: 2 })), null);
  assert.equal(parseDeferredMarker(markerJson({ sessionId: '' })), null);
  assert.equal(parseDeferredMarker(markerJson({ sessionId: 42 })), null);
  assert.equal(parseDeferredMarker(markerJson({ at: 'yesterday' })), null);
});

test('parseDeferredMarker: a marker with no description still names something', () => {
  assert.equal(parseDeferredMarker(markerJson({ what: '' }))?.what, 'Agent');
});

test('listDeferredMarkers: a missing directory is simply empty', () => {
  assert.deepEqual(listDeferredMarkers(path.join(os.tmpdir(), 'keeper-deferred-does-not-exist'), NOW), []);
});

test('listDeferredMarkers: valid markers, sorted by time', () => {
  const dir = tmpDir();
  const late = put(dir, 'abc12345-2.json', markerJson({ at: '2026-10-11T09:43:00.000Z', what: 'spawn: late' }));
  const early = put(dir, 'abc12345-1.json', markerJson({ at: '2026-10-11T09:40:00.000Z', what: 'spawn: early' }));
  const got = listDeferredMarkers(dir, NOW);
  assert.deepEqual(got.map((g) => g.file), [early, late]);
  assert.deepEqual(got.map((g) => g.marker.what), ['spawn: early', 'spawn: late']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listDeferredMarkers: an unparseable file is dropped and unlinked', () => {
  const dir = tmpDir();
  const bad = put(dir, 'deadbeef-1.json', '{"schema":1,"at":');
  const good = put(dir, 'abc12345-1.json', markerJson());
  const got = listDeferredMarkers(dir, NOW);
  assert.deepEqual(got.map((g) => g.file), [good]);
  assert.equal(fs.existsSync(bad), false);
  assert.equal(fs.existsSync(good), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listDeferredMarkers: an unparseable file written a second ago is left for the next tick', () => {
  const dir = tmpDir();
  const halfWritten = put(dir, 'deadbeef-1.json', '{"schema":1,', NOW - 1_000);
  assert.deepEqual(listDeferredMarkers(dir, NOW), []);
  assert.equal(fs.existsSync(halfWritten), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listDeferredMarkers: TTL sweep — a marker older than six hours is dropped and unlinked', () => {
  const dir = tmpDir();
  const stale = put(dir, 'abc12345-1.json', markerJson({ at: new Date(NOW - DEFERRED_TTL_MS - 1_000).toISOString() }));
  const edge = put(dir, 'abc12345-2.json', markerJson({ at: new Date(NOW - DEFERRED_TTL_MS + 60_000).toISOString() }));
  const got = listDeferredMarkers(dir, NOW);
  assert.deepEqual(got.map((g) => g.file), [edge]);
  assert.equal(fs.existsSync(stale), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listDeferredMarkers: files that are not markers are ignored and kept', () => {
  const dir = tmpDir();
  const tmp = put(dir, 'abc12345-1.json.tmp', '{"half":');
  const other = put(dir, '.DS_Store', 'x');
  assert.deepEqual(listDeferredMarkers(dir, NOW), []);
  assert.equal(fs.existsSync(tmp), true);
  assert.equal(fs.existsSync(other), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('consumeDeferredMarker: unlinks, and never throws on a file that is already gone', () => {
  const dir = tmpDir();
  const file = put(dir, 'abc12345-1.json', markerJson());
  consumeDeferredMarker(file);
  assert.equal(fs.existsSync(file), false);
  assert.doesNotThrow(() => consumeDeferredMarker(file));
  assert.doesNotThrow(() => consumeDeferredMarker(path.join(dir, 'nope', 'x.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});
