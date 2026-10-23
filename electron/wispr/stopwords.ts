// Wispr Flow's own stopword list — the words its auto-learn refuses to put in the
// Dictionary. Using the same list keeps the learner from teaching Wispr anything Wispr
// itself would consider noise ("hair", "the", "nie").
//
// Three sources, best first:
//   cache    — our copy under userData, refreshed at most every 30 days
//   network  — Wispr's public CDN file (the one the app downloads)
//   bundled  — stopwords.fallback.json shipped beside this module, so a machine that is
//              offline on first start still filters properly
// The list barely changes, so a stale cache beats no list, and nothing here may throw:
// the learner treats stopwords as a filter, not as a reason to stop.

import * as fs from 'fs';
import * as path from 'path';
import type { Stopwords } from './types';
import { normalizeWord } from './text';

export const STOPWORDS_URL = 'https://wispr-flow-cdn.s3.us-west-2.amazonaws.com/static/data/dictionary_stopwords.json';
export const STOPWORDS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// A real list has ~15k entries. Anything much smaller is an error page or a truncated
// download that would quietly let common words through.
const MIN_VALID_WORDS = 1000;

export function stopwordsFrom(words: Iterable<string>, origin: Stopwords['origin']): Stopwords {
  const set = new Set<string>();
  for (const w of words) {
    const k = normalizeWord(w);
    if (k) set.add(k);
  }
  return { has: (key: string) => set.has(key), size: set.size, origin };
}

function validList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length >= MIN_VALID_WORDS && v.every((w) => typeof w === 'string');
}

function readList(file: string): string[] | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v) && v.length > 0 && v.every((w) => typeof w === 'string') ? v : null;
  } catch {
    return null;
  }
}

// Read from disk rather than `require('./stopwords.fallback.json')` so the 190 KB list is
// parsed only when there is no cache. tsc emits it because electron/tsconfig.json
// includes wispr/*.json.
function bundled(): Stopwords {
  const list = readList(path.join(__dirname, 'stopwords.fallback.json'));
  if (list) return stopwordsFrom(list, 'bundled');
  console.warn('[agentsflow][wispr-learner] stopwords: no cache, no network, no bundled list');
  return stopwordsFrom([], 'none');
}

function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

async function download(fetchImpl: typeof fetch, timeoutMs: number): Promise<string[] | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(STOPWORDS_URL, { signal: ac.signal });
    if (!res.ok) return null;
    const v: unknown = await res.json();
    return validList(v) ? v : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadStopwords(opts: {
  cacheFile: string;
  fetchImpl?: typeof fetch | null;
  timeoutMs?: number;
  maxAgeMs?: number;
  nowMs?: number;
}): Promise<Stopwords> {
  try {
    const { cacheFile, timeoutMs = 10_000, maxAgeMs = STOPWORDS_MAX_AGE_MS, nowMs = Date.now() } = opts;
    const fetchImpl = opts.fetchImpl === undefined ? globalThis.fetch : opts.fetchImpl;

    const cached = readList(cacheFile);
    let ageMs = Infinity;
    try {
      ageMs = nowMs - fs.statSync(cacheFile).mtimeMs;
    } catch {
      /* no cache */
    }
    if (cached && ageMs < maxAgeMs) return stopwordsFrom(cached, 'cache');

    const fresh = fetchImpl ? await download(fetchImpl, timeoutMs) : null;
    if (fresh) {
      try {
        writeAtomic(cacheFile, JSON.stringify(fresh));
      } catch (e) {
        // Still use the download; we just fetch again next start.
        console.warn('[agentsflow][wispr-learner] stopwords: cache write failed:', (e as Error).message);
      }
      return stopwordsFrom(fresh, 'network');
    }
    if (cached) return stopwordsFrom(cached, 'cache');
    return bundled();
  } catch (e) {
    console.warn('[agentsflow][wispr-learner] stopwords: load failed:', (e as Error).message);
    return bundled();
  }
}
