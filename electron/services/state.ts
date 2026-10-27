// The services' clocks: when each one was last used, put to sleep and woken,
// and since when Docker has had no running container. Machine-written, kept
// across app restarts so a restart does not reset "used 3 h ago" to "just now".
// A missing or unreadable file is simply no history.

import * as fs from 'fs';
import * as path from 'path';
import type { ServicesStateFile } from '../../shared/services';

export function emptyState(): ServicesStateFile {
  return { version: 1, lastUsedAt: {}, sleptAt: {}, wokeAt: {}, dockerQuietSince: null };
}

function clocks(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, at] of Object.entries(v as Record<string, unknown>)) {
    if (id && typeof at === 'number' && Number.isFinite(at) && at > 0) out[id] = at;
  }
  return out;
}

/** Missing/unreadable ⇒ empty clocks; bad entries are dropped one by one. */
export function readState(file: string): ServicesStateFile {
  let j: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState();
    j = parsed as Record<string, unknown>;
  } catch {
    return emptyState();
  }
  const quiet = j.dockerQuietSince;
  return {
    version: 1,
    lastUsedAt: clocks(j.lastUsedAt),
    sleptAt: clocks(j.sleptAt),
    wokeAt: clocks(j.wokeAt),
    dockerQuietSince: typeof quiet === 'number' && Number.isFinite(quiet) && quiet > 0 ? quiet : null,
  };
}

/** Atomic (tmp + rename). */
export function writeState(s: ServicesStateFile, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
