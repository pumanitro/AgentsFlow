import * as fs from 'fs';
import * as path from 'path';
import type { IdempotencyCache } from './types';

// Every phone write carries a clientId. The first answer is remembered here
// (persisted, so a retry after a Mac restart still dedupes) and replayed for
// the same clientId. LRU by insertion order: Map iteration order is insertion
// order, so the first key is always the oldest.

const FILE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 500;

interface Entry { at: number; result: unknown }

function load(filePath: string, warn: (msg: string) => void): Map<string, Entry> {
  const out = new Map<string, Entry>();
  let text: string;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return out; }   // no file yet: normal
  try {
    const raw = JSON.parse(text);
    if (!raw || !Array.isArray(raw.entries)) throw new Error('no entries array');
    for (const e of raw.entries) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !e[1] || typeof e[1] !== 'object') continue;
      const at = typeof e[1].at === 'number' ? e[1].at : 0;
      out.set(e[0], { at, result: e[1].result });
    }
  } catch (err) {
    warn(`[agentsflow][mobile] idempotency cache unreadable, starting empty: ${(err as Error).message}`);
    out.clear();
  }
  return out;
}

export function createIdempotencyCache(filePath: string, max = 1000): IdempotencyCache {
  const cap = Math.max(1, Math.floor(max));
  // The contract factory takes no logger; a bad file is reported once on stderr.
  const map = load(filePath, (m) => console.warn(m));
  while (map.size > cap) map.delete(map.keys().next().value as string);
  let timer: NodeJS.Timeout | null = null;

  const writeNow = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, entries: [...map.entries()] }), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    }
  };

  return {
    get(clientId) { return map.get(clientId)?.result; },
    set(clientId, result) {
      map.delete(clientId);
      map.set(clientId, { at: Date.now(), result });
      while (map.size > cap) map.delete(map.keys().next().value as string);
      if (!timer) { timer = setTimeout(writeNow, SAVE_DEBOUNCE_MS); timer.unref?.(); }
    },
    flushSync() { writeNow(); },
  };
}
