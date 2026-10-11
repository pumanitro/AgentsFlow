// What the guard does about memory pressure — and it does it only at
// 'critical'. Stop candidates with a known compose project folder are stopped (state
// is kept; `docker start` brings them back); one with no project folder gets a notice
// first and is stopped a minute later only if the machine is still critical and
// nobody pinned it. Never more than two stops a tick, never a pinned,
// auto-remove, live-chat or active container.
//
// Planning is pure; applying takes its `exec`, so dry-run can be proven to run
// no `docker stop` at all.

import type { GuardContainerRow, GuardPins, KillLogEntry, MemLevel } from '../../shared/types';
import type { Exec } from './docker-inventory';

export type GuardAction = { kind: 'notice'; name: string; stoppingAt: number } | { kind: 'stop'; name: string; projectDir: string | null; reason: string } | { kind: 'cancel-notice'; name: string };

export const MAX_STOPS_PER_TICK = 2;
export const NOTICE_MS = 60_000;
const STOP_TIMEOUT_MS = 30_000;

/**
 * Pure. A pending notice travels on the row itself: the guard relabels a
 * noticed candidate `verdict: 'stopping'` with `stoppingAt`, and this function
 * turns it into a stop once that time has passed — or into a cancel-notice when
 * the level has dropped or the user pinned it meanwhile.
 */
export function planActions(level: MemLevel, rows: GuardContainerRow[], pins: GuardPins, now: number): GuardAction[] {
  const pinned = (r: GuardContainerRow): boolean => r.pinned || pins.keep.includes(r.name);
  const actions: GuardAction[] = [];

  if (level !== 'critical') {
    for (const r of rows) if (r.verdict === 'stopping') actions.push({ kind: 'cancel-notice', name: r.name });
    return actions;
  }

  // Longest idle first: the order is about use, never about size.
  const ordered = rows
    .filter((r) => r.running && (r.verdict === 'stop-candidate' || r.verdict === 'stopping'))
    .sort((a, b) => (b.idleMinutes ?? 0) - (a.idleMinutes ?? 0) || a.name.localeCompare(b.name));

  let stops = 0;
  let notices = 0;
  for (const r of ordered) {
    if (pinned(r) || r.autoRemove) {
      if (r.verdict === 'stopping') actions.push({ kind: 'cancel-notice', name: r.name });
      continue;
    }
    const reason = `memory critical — ${r.note}`;
    if (r.verdict === 'stopping') {
      const due = r.stoppingAt ? Date.parse(r.stoppingAt) : NaN;
      // An unreadable deadline is not a licence to stop: the notice starts over.
      if (!Number.isFinite(due)) actions.push({ kind: 'cancel-notice', name: r.name });
      else if (due <= now && stops < MAX_STOPS_PER_TICK) { actions.push({ kind: 'stop', name: r.name, projectDir: r.projectDir, reason }); stops++; }
      continue;
    }
    // "Known" means a folder we could match against live chats. A project label
    // with no folder (supabase CLI) proves nothing about who is using it: notice first.
    if (r.project && r.projectDir) {
      if (stops < MAX_STOPS_PER_TICK) { actions.push({ kind: 'stop', name: r.name, projectDir: r.projectDir, reason }); stops++; }
    } else if (notices < MAX_STOPS_PER_TICK) {
      actions.push({ kind: 'notice', name: r.name, stoppingAt: now + NOTICE_MS });
      notices++;
    }
  }
  return actions;
}

/**
 * dry-run → log '[agentsflow][guard] WOULD-STOP <name> …' + KillLogEntry{dry:true};
 * live → `docker stop <name>` (timeout 30 s) + KillLogEntry{dry:false}.
 *
 * Anything but the exact mode 'live' is dry-run. In dry-run nothing reaches the
 * user either: a "stopping in 60 s" notification for a stop that will not
 * happen would be a false alarm, so the notice is only logged. A live stop that
 * fails leaves no entry.
 */
export async function applyActions(actions: GuardAction[], opts: { mode: GuardPins['mode']; exec: Exec; notify: (t: string, b: string) => void; now: number }): Promise<KillLogEntry[]> {
  const live = opts.mode === 'live';
  const at = new Date(opts.now).toISOString();
  const entries: KillLogEntry[] = [];
  for (const a of actions) {
    if (a.kind === 'cancel-notice') {
      console.log(`[agentsflow][guard] notice withdrawn for ${a.name}`);
      continue;
    }
    if (a.kind === 'notice') {
      if (!live) {
        console.log(`[agentsflow][guard] WOULD-NOTIFY ${a.name} (dry-run): stop planned in ${Math.round((a.stoppingAt - opts.now) / 1000)} s`);
        continue;
      }
      try {
        opts.notify('Memory guard', `Memory critical — stopping container ${a.name} in 60 s. Pin it in Performance › Memory guard to keep it.`);
      } catch {
        /* a failed notification must not stop the pass */
      }
      continue;
    }
    const entry: KillLogEntry = { at, by: 'peersflow-guard', kind: 'container', name: a.name, dry: !live, reason: a.reason };
    if (a.projectDir) entry.projectDir = a.projectDir;
    if (!live) {
      console.log(`[agentsflow][guard] WOULD-STOP ${a.name} (dry-run): ${a.reason}`);
      entries.push(entry);
      continue;
    }
    const out = await opts.exec('docker', ['stop', a.name], STOP_TIMEOUT_MS);
    if (out === null) {
      console.warn(`[agentsflow][guard] docker stop ${a.name} failed or timed out`);
      continue;
    }
    console.warn(`[agentsflow][guard] STOPPED ${a.name}: ${a.reason} (bring it back with: docker start ${a.name})`);
    entries.push(entry);
  }
  return entries;
}
