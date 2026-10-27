// The services log: one JSON line per thing that happened to a managed service
// (put to sleep, woken, a wake guard armed or refused, Docker started/stopped).
// Append-only; the Performance panel shows the newest lines under "What
// happened". Reading takes only the tail of the file and skips any line that is
// not a whole, valid entry (a writer may be mid-append).

import * as fs from 'fs';
import * as path from 'path';
import type { ServiceLogBy, ServiceLogEntry, ServiceLogEvent } from '../../shared/services';

// The tail read never takes more than this; 30 entries fit many times over.
const TAIL_BYTES = 256 * 1024;

const EVENTS: readonly ServiceLogEvent[] = ['slept', 'woke', 'sleep-failed', 'wake-failed', 'proxy-armed', 'proxy-failed', 'discovered', 'docker-started', 'docker-stopped'];
const BYS: readonly ServiceLogBy[] = ['idle', 'pressure', 'request', 'click', 'startup', 'docker'];

export function appendServiceLog(e: ServiceLogEntry, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(e) + '\n');
}

export function parseServiceLogLine(line: string): ServiceLogEntry | null {
  const t = (line || '').trim();
  if (!t.startsWith('{')) return null;
  let j: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(t);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    j = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof j.at !== 'string' || !Number.isFinite(Date.parse(j.at))) return null;
  if (typeof j.id !== 'string' || !j.id) return null;
  if (!EVENTS.includes(j.event as ServiceLogEvent)) return null;
  if (!BYS.includes(j.by as ServiceLogBy)) return null;
  return {
    at: j.at,
    id: j.id,
    name: typeof j.name === 'string' && j.name ? j.name : j.id,
    event: j.event as ServiceLogEvent,
    by: j.by as ServiceLogBy,
    detail: typeof j.detail === 'string' ? j.detail : '',
  };
}

/** The last `max` valid entries, newest first. Missing file ⇒ []. Never throws. */
export function readServiceLogTail(file: string, max = 30): ServiceLogEntry[] {
  if (!(max > 0)) return [];
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - TAIL_BYTES);
    const len = size - from;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, from);
    const lines = buf.subarray(0, got).toString('utf8').split('\n');
    // Started mid-file: the first piece is the end of a line cut by the window.
    if (from > 0) lines.shift();
    const out: ServiceLogEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
      const e = parseServiceLogLine(lines[i]);
      if (e) out.push(e);
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}
