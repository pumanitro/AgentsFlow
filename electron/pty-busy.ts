// Is a detached, silent `claude --resume` still WORKING? The idle-PTY reaper in
// pty-manager.ts treats "no viewer + no output for the TTL" as "finished", and
// that is wrong for a CLI that ended its turn with background work pending: a
// `run_in_background` Bash task (a shell parked on `sleep`/a watcher), a
// scheduled wake-up, an active /goal. The TUI paints nothing while it waits, so
// to the reaper it looks exactly like a chat the user closed and forgot — and
// on 2026-10-09 and 2026-10-10 the reaper killed a session twice, mid-overnight
// loop, at idleMs ≈ 660 000 each time.
//
// The CLI leaves two cheap, exact signs of work in its process tree:
//   - `caffeinate`: Claude Code runs it while a turn or background work is live
//     (an idle chat has none);
//   - a shell child (`zsh`/`bash`/`sh`…): a background Bash task's own shell.
// MCP servers (`node`, `Electron`, `python3`…) are children of every session,
// busy or not, so they never count. A name in parentheses is a zombie `ps`
// prints for an exited child — not work either.
//
// Pure functions here (no electron / node-pty imports) so the rule is unit-tested;
// `liveWorkOf` is the one `ps` call the reaper makes per tick.
import { execFileSync } from 'child_process';

export interface PsRow { pid: number; ppid: number; comm: string; }

/** Process names that mean "this CLI is still working". */
export const BUSY_CHILD_RE = /^(caffeinate|zsh|bash|sh|dash|fish|ksh)$/;

/** Parses `ps -axo pid=,ppid=,comm=` output. Malformed lines are skipped. */
export function parsePsRows(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3].trim() });
  }
  return rows;
}

/** The names of `pid`'s DIRECT children that are signs of live work, in `ps` order. */
export function busyChildren(rows: PsRow[], pid: number): string[] {
  if (!Number.isFinite(pid) || pid <= 0) return [];
  const out: string[] = [];
  for (const r of rows) {
    if (r.ppid !== pid) continue;
    const name = r.comm.split('/').pop() ?? r.comm;
    if (name.startsWith('(')) continue;            // zombie: `(bash)`
    if (BUSY_CHILD_RE.test(name.replace(/^-/, ''))) out.push(name);
  }
  return out;
}

/**
 * The live-work children of a CLI process right now, or [] when there are none
 * or `ps` cannot be read (a reaper must never fail on a diagnostic).
 */
export function liveWorkOf(pid: number): string[] {
  if (!Number.isFinite(pid) || pid <= 0) return [];
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 5000 });
    return busyChildren(parsePsRows(out), pid);
  } catch {
    return [];
  }
}
