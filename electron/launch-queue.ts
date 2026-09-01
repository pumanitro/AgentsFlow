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
 * WHAT COUNTS toward the cap: sessions actually consuming CPU — starting or
 * working, plus a live busy status (which wins over a stale recorded state,
 * same precedence the status dot uses). Deliberately NOT counted:
 *   - blocked / needs-input / idle / terminal states: parked on a human or
 *     finished. Counting a blocked run would let four permission prompts
 *     stall an unattended overnight batch forever.
 *   - delegated sub-peer spawns bypass the gate entirely (main.ts passes
 *     `bypassQueue`): the delegating parent blocks awaiting the delegate, so
 *     queueing the delegate behind its own parent's slot would deadlock both.
 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;

export function maxConcurrentRuns(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AGENTSFLOW_MAX_CONCURRENT_RUNS);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return DEFAULT_MAX_CONCURRENT_RUNS;
}

const RUNNING_STATES = new Set(['starting', 'working', 'active']);

/** Is this conversation occupying a CPU slot right now? */
export function isRunning(c: Pick<Conversation, 'state' | 'status'>): boolean {
  const status = (c.status || '').toLowerCase();
  if (status === 'busy' || status === 'working' || status === 'starting') return true;
  return RUNNING_STATES.has((c.state || '').toLowerCase());
}

export function countRunning(convs: Conversation[]): number {
  let n = 0;
  for (const c of convs) if (isRunning(c)) n += 1;
  return n;
}

export function freeSlots(convs: Conversation[], env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(0, maxConcurrentRuns(env) - countRunning(convs));
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
