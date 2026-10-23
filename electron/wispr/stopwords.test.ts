import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadStopwords, stopwordsFrom, STOPWORDS_MAX_AGE_MS, STOPWORDS_URL } from './stopwords';

const DAY = 24 * 60 * 60 * 1000;
// A downloadable list must look real (≥ 1000 words) to be accepted.
const NET_LIST = ['netword', ...Array.from({ length: 1200 }, (_, i) => `w${i}`)];
const CACHE_LIST = ['cachedword', 'the'];

function tmpCache(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-sw-')), 'sub', 'stopwords.json');
}

function writeCache(file: string, list: string[], ageMs: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list));
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}

function okFetch(list: unknown, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    return { ok: true, json: async () => list } as Response;
  }) as unknown as typeof fetch;
}
const failingFetch = (async () => {
  throw new Error('offline');
}) as unknown as typeof fetch;
const mustNotFetch = (async () => {
  throw new Error('fetch must not be called');
}) as unknown as typeof fetch;

test('stopwordsFrom normalizes entries', () => {
  const sw = stopwordsFrom(['Hello', '’tis', 'x.', ''], 'none');
  assert.ok(sw.has('hello'));
  assert.ok(sw.has('tis'));
  assert.ok(sw.has('x'));
  assert.equal(sw.size, 3);
  assert.equal(sw.origin, 'none');
});

test('a fresh cache wins without touching the network', async () => {
  const cacheFile = tmpCache();
  writeCache(cacheFile, CACHE_LIST, DAY);
  const sw = await loadStopwords({ cacheFile, fetchImpl: mustNotFetch });
  assert.equal(sw.origin, 'cache');
  assert.ok(sw.has('cachedword'));
});

test('a stale cache is replaced by a working download, and the cache is rewritten', async () => {
  const cacheFile = tmpCache();
  writeCache(cacheFile, CACHE_LIST, STOPWORDS_MAX_AGE_MS + DAY);
  const calls: string[] = [];
  const sw = await loadStopwords({ cacheFile, fetchImpl: okFetch(NET_LIST, calls) });
  assert.equal(sw.origin, 'network');
  assert.deepEqual(calls, [STOPWORDS_URL]);
  assert.ok(sw.has('netword'));
  assert.ok(!sw.has('cachedword'));
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), NET_LIST);
  assert.deepEqual(fs.readdirSync(path.dirname(cacheFile)), ['stopwords.json'], 'no tmp file left behind');
});

test('a failing download falls back to the stale cache', async () => {
  const cacheFile = tmpCache();
  writeCache(cacheFile, CACHE_LIST, STOPWORDS_MAX_AGE_MS + DAY);
  const sw = await loadStopwords({ cacheFile, fetchImpl: failingFetch });
  assert.equal(sw.origin, 'cache');
  assert.ok(sw.has('cachedword'));
});

test('a too-small download is rejected', async () => {
  const cacheFile = tmpCache();
  writeCache(cacheFile, CACHE_LIST, STOPWORDS_MAX_AGE_MS + DAY);
  const sw = await loadStopwords({ cacheFile, fetchImpl: okFetch(['only', 'three', 'words']) });
  assert.equal(sw.origin, 'cache');
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), CACHE_LIST);
});

test('a download that hangs is aborted at the timeout', async () => {
  const cacheFile = tmpCache();
  const hanging = ((_u: string, init?: RequestInit) =>
    new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
  const t0 = Date.now();
  const sw = await loadStopwords({ cacheFile, fetchImpl: hanging, timeoutMs: 50 });
  assert.equal(sw.origin, 'bundled');
  assert.ok(Date.now() - t0 < 2000);
});

test('nothing cached and no network → the bundled list', async () => {
  const cacheFile = tmpCache();
  const sw = await loadStopwords({ cacheFile, fetchImpl: failingFetch });
  assert.equal(sw.origin, 'bundled');
  assert.equal(sw.size, 15504);
  assert.ok(sw.has('hair'));
  assert.ok(sw.has('nie'), 'Polish entry from the bundled file');
  assert.ok(!fs.existsSync(cacheFile), 'bundled list is not written to the cache');
});

test('fetchImpl null never fetches; corrupt cache is ignored', async () => {
  const cacheFile = tmpCache();
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, '{not json');
  const sw = await loadStopwords({ cacheFile, fetchImpl: null });
  assert.equal(sw.origin, 'bundled');
});
