// Append-only record of everything the learner did (or, in dry-run, would have done)
// to Wispr's Dictionary. One JSON object per line so a crash can at worst tear the
// last line, and a person can `tail` it to see why a word appeared or vanished.

import * as fs from 'fs';
import * as path from 'path';

export interface AuditEntry {
  at: string;
  action: 'insert' | 'soft-delete' | 'would-insert' | 'would-soft-delete' | 'backup' | 'disabled' | 'error';
  id?: string;
  phrase?: string;
  observedSource?: string | null;
  kind?: string;
  why?: string;
  dryRun: boolean;
}

export function appendAudit(file: string, entries: AuditEntry[]): void {
  if (entries.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
}

/** Every parseable line; a torn or garbled line (crash mid-append) is skipped, not fatal. */
export function readAudit(file: string): AuditEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === 'object' && typeof (v as AuditEntry).action === 'string') out.push(v as AuditEntry);
    } catch {
      /* torn line */
    }
  }
  return out;
}
