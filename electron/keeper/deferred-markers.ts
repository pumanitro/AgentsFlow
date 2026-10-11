// Deferred markers: the note the admission hook leaves when it refuses a
// sub-agent spawn for lack of memory. One JSON file per refusal under
// DEFERRED_DIR; the Keeper reads them and, once memory is free and the chat is
// idle, tells the chat to retry — then removes the file.
//
// The hook is a shell script that never imports this module, so the file is the
// whole interface: anything that does not parse as a schema-1 marker is treated
// as rubbish and removed, and a marker nobody claimed within DEFERRED_TTL_MS is
// history (the chat it belonged to has long since moved on or ended).

import * as fs from 'fs';
import * as path from 'path';
import type { DeferredMarker } from '../../shared/types';
import { DEFERRED_DIR, DEFERRED_TTL_MS } from './paths';

// An unparseable file younger than this may simply be half-written (the hook
// may not write atomically); it is left alone for one more tick, not deleted.
const HALF_WRITTEN_GRACE_MS = 10_000;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function parseDeferredMarker(json: string): DeferredMarker | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1) return null;
  if (typeof r.sessionId !== 'string' || !r.sessionId.trim()) return null;
  if (typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return null;
  const marker: DeferredMarker = {
    schema: 1,
    at: r.at,
    sessionId: r.sessionId,
    cwd: str(r.cwd),
    transcriptPath: str(r.transcriptPath),
    toolName: str(r.toolName),
    what: str(r.what).trim() || str(r.toolName) || 'a deferred step',
    reason: str(r.reason),
    availGB: typeof r.availGB === 'number' && Number.isFinite(r.availGB) ? r.availGB : null,
    state: str(r.state),
  };
  if (typeof r.subagentType === 'string' && r.subagentType) marker.subagentType = r.subagentType;
  if (typeof r.model === 'string' && r.model) marker.model = r.model;
  return marker;
}

/** Sorted by `at`; drops and unlinks files older than DEFERRED_TTL_MS or unparseable. */
export function listDeferredMarkers(dir: string = DEFERRED_DIR, now: number = Date.now()): Array<{ file: string; marker: DeferredMarker }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // no directory yet: the hook has never deferred anything
  }
  const out: Array<{ file: string; marker: DeferredMarker }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // a writer's temp file, a .DS_Store
    const file = path.join(dir, name);
    let marker: DeferredMarker | null = null;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
      marker = parseDeferredMarker(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // vanished between readdir and read, or unreadable: not ours to judge
    }
    if (!marker) {
      if (now - mtimeMs >= HALF_WRITTEN_GRACE_MS) consumeDeferredMarker(file);
      continue;
    }
    if (now - Date.parse(marker.at) > DEFERRED_TTL_MS) {
      consumeDeferredMarker(file);
      continue;
    }
    out.push({ file, marker });
  }
  out.sort((a, b) => Date.parse(a.marker.at) - Date.parse(b.marker.at) || a.file.localeCompare(b.file));
  return out;
}

/** Unlink; never throws. */
export function consumeDeferredMarker(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}
