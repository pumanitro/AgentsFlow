import type { Conversation } from '../shared/types';

/**
 * Launch gate for user-spawned runs — the cap on how many sessions may burn
 * CPU at once, and the pure helpers behind the queue that holds the rest.
 *
 * WHY. 2026-09-01: a batch of 11 near-identical runs launched together held
 * the 16-core machine at 100% for a full hour with a 1-minute load peaking at
 * 357 (22× cores). Aggregate agent throughput FELL as concurrency rose —
 * agents extracted ~550% CPU at load ~50 but only ~250% at load 250+ — and
 * individual `vitest run` invocations stretched from ~2 min to 22-23 min of
 * wall clock. Starting everything at once made the whole batch finish LATER.
 * So beyond the cap, a spawn parks as a 'queued' conversation and is
 * dispatched oldest-first as slots free (main.ts drains one per pass, so a
 * big batch ramps in steps instead of re-creating the thundering herd).
 *
 * WHAT COUNTS toward the cap — LIVE evidence only. The first version counted
 * stored `state`/`status` and immediately wedged on zombies: rows frozen at
 * `working` since July, a run with no daemon at all — 8 "running" on a machine
 * at 34%, so nothing ever dispatched. Recorded state lies (a --resume'd
 * session's state.json freezes; the poller can re-apply stale files), so the
 * gate now counts:
 *   - live `claude agents --json` rows with status 'busy' — processes that
 *     exist and are working RIGHT NOW, AgentsFlow-spawned or not (a terminal
 *     session burns the same cores);
 *   - plus conversations in state 'starting' created within a short boot
 *     grace, which a dispatched-but-not-yet-listed daemon needs so the drain
 *     cannot over-dispatch between listAgents ticks. Deduped against the
 *     busy rows; a 'starting' row older than the grace is a zombie and does
 *     not count.
 * Deliberately NOT counted:
 *   - resident-but-idle and waiting daemons: parked on a human or finished.
 *     Counting a blocked run would let four permission prompts stall an
 *     unattended overnight batch forever.
 *   - delegated sub-peer spawns bypass the gate entirely (main.ts passes
 *     `bypassQueue`): the delegating parent blocks awaiting the delegate, so
 *     queueing the delegate behind its own parent's slot would deadlock both.
 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;

/** How long a dispatched run may sit in 'starting' and still hold a slot. */
export const STARTING_GRACE_MS = 2 * 60 * 1000;

/** The slice of a `claude agents --json` row the gate needs. */
export interface LiveRunRow {
  sessionId: string;
  status?: string;
}

export function maxConcurrentRuns(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AGENTSFLOW_MAX_CONCURRENT_RUNS);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return DEFAULT_MAX_CONCURRENT_RUNS;
}

function isBusy(r: LiveRunRow): boolean {
  return (r.status || '').toLowerCase() === 'busy';
}

function matchesRow(c: Conversation, r: LiveRunRow): boolean {
  if (!r.sessionId) return false;
  if (c.daemonShort && r.sessionId.startsWith(c.daemonShort)) return true;
  return !!c.sessionId && r.sessionId === c.sessionId;
}

/** Occupied CPU slots right now: live busy sessions + still-booting spawns. */
export function countRunning(
  convs: Conversation[],
  liveRows: LiveRunRow[],
  now: number = Date.now(),
): number {
  const busy = liveRows.filter(isBusy);
  let n = busy.length;
  for (const c of convs) {
    if ((c.state || '').toLowerCase() !== 'starting') continue;
    const age = now - Date.parse(c.createdAt);
    if (!(age >= 0 && age < STARTING_GRACE_MS)) continue;
    // Already visible as a busy live row → counted above; don't double-bill.
    if (busy.some((r) => matchesRow(c, r))) continue;
    n += 1;
  }
  return n;
}

export function freeSlots(
  convs: Conversation[],
  liveRows: LiveRunRow[],
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): number {
  return Math.max(0, maxConcurrentRuns(env) - countRunning(convs, liveRows, now));
}

/**
 * The next run to dispatch when a slot frees: oldest queued first, so a batch
 * completes in the order it was launched. Only rows still carrying their
 * `queuedSpawn` payload in state 'queued' qualify — a canceled queued run
 * (state flipped, payload cleared) can never be dispatched.
 */
export function nextQueued(convs: Conversation[]): Conversation | undefined {
  let best: Conversation | undefined;
  for (const c of convs) {
    if (!c.queuedSpawn || (c.state || '').toLowerCase() !== 'queued') continue;
    if (!best || Date.parse(c.createdAt) < Date.parse(best.createdAt)) best = c;
  }
  return best;
}
