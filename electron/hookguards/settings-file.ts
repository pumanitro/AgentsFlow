// Reading and writing ~/.claude/settings.json for the guard installer.
//
// A malformed file is reported and never written back (the user's hand edit
// wins over our hooks). A write always backs the old file up first into
// <backupDir>/settings.json.backup.<epochMs> — the same dir and naming Claude
// Code uses for its own backups — and lands via tmp + rename, 2-space JSON.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Missing → `{}` with existed:false; unreadable, malformed or not an object → error. */
export function readSettingsJson(p: string): { ok: true; json: Record<string, unknown>; existed: boolean } | { ok: false; error: string } {
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, json: {}, existed: false };
    return { ok: false, error: `cannot read ${p}: ${errMsg(err)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `${p} is not valid JSON: ${errMsg(err)}` };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, error: `${p} is not a JSON object` };
  return { ok: true, json: json as Record<string, unknown>, existed: true };
}

/** Backs up the existing file (if any), then writes `json` atomically. Throws on failure. */
export function writeSettingsJsonWithBackup(p: string, backupDir: string, json: Record<string, unknown>, nowMs: number): { backup: string | null } {
  let backup: string | null = null;
  if (fs.existsSync(p)) {
    fs.mkdirSync(backupDir, { recursive: true });
    backup = path.join(backupDir, `settings.json.backup.${nowMs}`);
    fs.copyFileSync(p, backup);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let mode = 0o644;
  try { mode = fs.statSync(p).mode & 0o777; } catch { /* new file */ }
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n', { mode });
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return { backup };
}
