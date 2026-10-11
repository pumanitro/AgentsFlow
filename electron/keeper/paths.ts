// Where the Keeper, the memory guard and the machine-side tooling meet on disk.
//
// These paths are a contract with two shell scripts that never import this
// file — the admission hook (~/.claude/hooks/mem-admission.sh) and the launchd
// memguard (~/Library/Scripts/memguard-system.sh) — so a change here is a
// change there. Kept in one module so the Keeper, the guard and their tests all
// name the same files.

import * as os from 'os';
import * as path from 'path';

export const LOCKS_DIR = path.join(os.homedir(), '.claude', 'locks');
export const DEFERRED_DIR = path.join(LOCKS_DIR, 'mem-deferred');                 // <sessionId first 8>-<epochMs>.json, DeferredMarker JSON
export const PINS_FILE = path.join(LOCKS_DIR, 'memguard-pins.json');              // GuardPins; missing ⇒ {version:1, keep:[], mode:'dry-run', idleMinutes:120}
export const KILL_LOG = path.join(LOCKS_DIR, 'memguard-kills.jsonl');             // one KillLogEntry per line, append-only, both writers
export const ADMISSION_CLOSED_FILE = path.join(LOCKS_DIR, 'mem-admission-closed'); // JSON {since,level,reason,writtenAt}; FRESH while mtime age < 120 s
export const ADMISSION_CLOSED_FRESH_MS = 120_000;
export const DEFERRED_TTL_MS = 6 * 60 * 60 * 1000;
