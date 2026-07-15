/**
 * Lightweight main-process performance instrumentation.
 *
 * Every IPC handler and each poller cycle is timed through here so that, when
 * the app feels laggy, main.log tells you *which* main-thread operation is the
 * bottleneck instead of leaving you guessing. Three outputs:
 *
 *   • an immediate WARN line the moment any single op exceeds SLOW_MS (with the
 *     peer it touched, when resolvable),
 *   • a periodic summary of the heaviest labels since the last summary
 *     (by total main-thread time), and
 *   • a rolling buffer of the most recent slow ops that logger.ts dumps right
 *     next to a `[stall]` line — so a freeze can be attributed after the fact.
 *
 * Recording keeps only O(1) scalar aggregates per label (no per-sample arrays),
 * so it is cheap enough to wrap even hot channels like `term:write`: peer
 * resolution and timestamping happen ONLY for ops that actually cross SLOW_MS.
 * All output goes through console.* which logger.ts mirrors to main.log.
 */
import { performance } from 'node:perf_hooks';

// A single op slower than this is logged immediately and remembered for the
// stall dump. Also the gate below which we skip peer resolution entirely, to
// keep instrumentation overhead off the hot path.
export const SLOW_MS = 150;
const SUMMARY_INTERVAL_MS = 5 * 60_000;
const RECENT_SLOW_CAP = 50;
const SUMMARY_TOP_N = 10;

// Some ops have an intrinsically high floor: spawning the `claude` CLI to list
// agents is ~300ms even on a healthy machine, so gating it at the sensitive
// 150ms default flagged EVERY poll tick as "SLOW" — thousands of noise lines a
// day that buried the genuine multi-second spikes and flooded the stall dump.
// Give those ops a realistic floor so only real regressions surface; every
// other label keeps the sensitive default.
const LABEL_SLOW_MS: Record<string, number> = {
  'poll:listAgents': 1500,
  'poll:tick': 1500,
};
function slowThreshold(label: string): number {
  return LABEL_SLOW_MS[label] ?? SLOW_MS;
}

interface Stat {
  count: number;
  totalMs: number;
  maxMs: number;
  maxPeer?: string;
  lastPeer?: string;
  overCount: number; // how many samples crossed SLOW_MS this window
}
// Reset each summary window, so the summary reflects recent behaviour.
const windowStats = new Map<string, Stat>();

interface SlowOp { at: string; label: string; ms: number; peer?: string }
// Rolling buffer of recent slow ops — survives window resets so the stall dump
// still has context.
const recentSlow: SlowOp[] = [];

/** Record one completed operation. `peer` is optional attribution (a peer name). */
export function record(label: string, ms: number, peer?: string): void {
  let s = windowStats.get(label);
  if (!s) { s = { count: 0, totalMs: 0, maxMs: 0, overCount: 0 }; windowStats.set(label, s); }
  s.count++;
  s.totalMs += ms;
  if (peer) s.lastPeer = peer;
  if (ms > s.maxMs) { s.maxMs = ms; s.maxPeer = peer; }
  if (ms >= slowThreshold(label)) {
    s.overCount++;
    recentSlow.push({ at: new Date().toISOString(), label, ms, peer });
    if (recentSlow.length > RECENT_SLOW_CAP) recentSlow.shift();
    console.warn(`[agentsflow][perf] SLOW ${label} ${ms.toFixed(0)}ms${peer ? ` peer=${peer}` : ''}`);
  }
}

/**
 * Time an async (or sync) operation and record it. `peerResolver` is only
 * invoked when the op crossed SLOW_MS, so attribution never costs anything on
 * the fast path.
 */
export async function timed<T>(
  label: string,
  fn: () => Promise<T> | T,
  peerResolver?: () => string | undefined,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - start;
    record(label, ms, ms >= slowThreshold(label) && peerResolver ? peerResolver() : undefined);
  }
}

function formatSummary(): string | null {
  if (windowStats.size === 0) return null;
  const rows = Array.from(windowStats.entries())
    .map(([label, s]) => ({ label, ...s, avgMs: s.totalMs / Math.max(1, s.count) }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, SUMMARY_TOP_N);
  return rows
    .map(
      (r) =>
        `    ${r.label.padEnd(24)} n=${String(r.count).padStart(6)}  total=${r.totalMs.toFixed(0).padStart(7)}ms  avg=${r.avgMs.toFixed(1).padStart(6)}ms  max=${r.maxMs.toFixed(0).padStart(6)}ms` +
        `${r.maxPeer ? ` (max@${r.maxPeer})` : ''}${r.overCount ? `  slow×${r.overCount}` : ''}`,
    )
    .join('\n');
}

/** Start the periodic summary logger. Returns a disposer. */
export function startPerfSummary(): () => void {
  const t = setInterval(() => {
    const body = formatSummary();
    if (body) {
      console.log(
        `[agentsflow][perf] === ${Math.round(SUMMARY_INTERVAL_MS / 60_000)}m summary · heaviest main-thread ops (by total time) ===\n${body}`,
      );
    }
    windowStats.clear();
  }, SUMMARY_INTERVAL_MS);
  t.unref?.();
  return () => clearInterval(t);
}

/**
 * A compact, newest-first list of the most recent slow ops, for logger.ts to
 * append to a `[stall]` line. Returns '' when there's nothing to report, so it
 * can be string-concatenated unconditionally.
 */
export function recentSlowOpsSummary(limit = 12): string {
  if (recentSlow.length === 0) return '';
  const rows = recentSlow
    .slice(-limit)
    .reverse()
    .map((o) => `      ${o.at}  ${o.label}  ${o.ms.toFixed(0)}ms${o.peer ? `  peer=${o.peer}` : ''}`);
  return `\n[agentsflow][perf] recent slow ops before the stall (newest first):\n${rows.join('\n')}`;
}
