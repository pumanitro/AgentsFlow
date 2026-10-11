// The kill log: one JSON line per thing stopped to protect memory, whoever
// stopped it — this app's guard (containers) or the launchd memguard (process
// groups). Append-only, shared by both writers, and read by the Keeper from a
// byte offset so a chat can be told what was stopped under it and how to get it
// back. Dry-run entries are logged too; that is how a WOULD-STOP gets reviewed.

import * as fs from 'fs';
import * as path from 'path';
import type { KillLogEntry } from '../../shared/types';
import { KILL_LOG } from '../keeper/paths';

// One read never takes more than this; a longer backlog is picked up over the
// following calls (the returned offset says where to continue).
const MAX_READ_BYTES = 1024 * 1024;

export function appendKillLog(e: KillLogEntry, file: string = KILL_LOG): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(e) + '\n');
}

export function parseKillLogLine(line: string): KillLogEntry | null {
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
  if (j.by !== 'peersflow-guard' && j.by !== 'memguard-system') return null;
  if (j.kind !== 'container' && j.kind !== 'process-group') return null;
  if (typeof j.name !== 'string' || !j.name) return null;
  if (typeof j.dry !== 'boolean') return null;
  const e: KillLogEntry = { at: j.at, by: j.by, kind: j.kind, name: j.name, dry: j.dry, reason: typeof j.reason === 'string' ? j.reason : '' };
  if (typeof j.pgid === 'number' && Number.isFinite(j.pgid)) e.pgid = j.pgid;
  if (typeof j.claudePid === 'number' && Number.isFinite(j.claudePid)) e.claudePid = j.claudePid;
  if (typeof j.family === 'string') e.family = j.family;
  if (typeof j.cmd === 'string') e.cmd = j.cmd;
  if (typeof j.cwd === 'string') e.cwd = j.cwd;
  if (typeof j.projectDir === 'string') e.projectDir = j.projectDir;
  if (typeof j.sessionId === 'string') e.sessionId = j.sessionId;
  return e;
}

/**
 * Entries appended at or after byte `offset`, and the offset to pass next time.
 * Only whole lines are consumed (a writer may be mid-append); a file that shrank
 * is read again from the start. Never throws.
 */
export function readKillLogSince(offset: number, file: string = KILL_LOG): { entries: KillLogEntry[]; offset: number } {
  let from = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < from) from = 0;
    const len = Math.min(size - from, MAX_READ_BYTES);
    if (len <= 0) return { entries: [], offset: from };
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, from);
    const end = buf.subarray(0, got).lastIndexOf(0x0a);
    // No newline in a full window: one absurd line — step over it rather than stall on it forever.
    if (end < 0) return { entries: [], offset: got === MAX_READ_BYTES ? from + got : from };
    const entries: KillLogEntry[] = [];
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      const e = parseKillLogLine(line);
      if (e) entries.push(e);
    }
    return { entries, offset: from + end + 1 };
  } catch {
    return { entries: [], offset: from };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}
