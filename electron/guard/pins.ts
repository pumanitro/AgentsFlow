// The guard's pins file: which containers the user wants left alone, whether
// the guard is allowed to act at all (mode), and how long "idle" is. A missing
// or unreadable file means the safe defaults — above all mode 'dry-run'.

import * as fs from 'fs';
import * as path from 'path';
import type { GuardPins } from '../../shared/types';
import { PINS_FILE } from '../keeper/paths';

const DEFAULTS: GuardPins = { version: 1, keep: [], mode: 'dry-run', idleMinutes: 120 };

/** Missing/unreadable ⇒ {version:1, keep:[], mode:'dry-run', idleMinutes:120}. */
export function readPins(file: string = PINS_FILE): GuardPins {
  let j: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULTS, keep: [] };
    j = parsed as Record<string, unknown>;
  } catch {
    return { ...DEFAULTS, keep: [] };
  }
  const keep = Array.isArray(j.keep)
    ? Array.from(new Set(j.keep.filter((n): n is string => typeof n === 'string' && n.length > 0))).sort()
    : [];
  return {
    version: 1,
    keep,
    // Only the exact word turns the actor on.
    mode: j.mode === 'live' ? 'live' : 'dry-run',
    idleMinutes: typeof j.idleMinutes === 'number' && Number.isFinite(j.idleMinutes) && j.idleMinutes > 0 ? j.idleMinutes : DEFAULTS.idleMinutes,
  };
}

/** Atomic (tmp + rename). */
export function writePins(p: GuardPins, file: string = PINS_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
