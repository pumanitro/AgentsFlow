// The memory ladder: ok → warn → closed → critical.
//
// Why not "available GB": on the morning this was written a vitest herd took
// the machine from fine to frozen in nine minutes while `avail` never left
// 22–36 GB. What moved was the compressor (34.6 → 56.8 GB) and, late, the
// kernel's own pressure level. So the level here is read off compressed size,
// swap and its growth, and the kernel level — never off availability.
//
// Pure: parsers over the text of three commands plus a small state machine with
// confirmation ticks, so one odd sample cannot flip the level. Thresholds
// mirror ~/.claude/tools/cpu-gate/mem.mjs DEFAULTS where they overlap.

import type { MemLevel, MemSample } from '../../shared/types';

export const WARN_COMPRESSED_GB = 32;
export const WARN_SWAP_GB = 8;
export const CRIT_COMPRESSED_GB = 60;
export const CRIT_SWAP_GROWTH_GB_PER_5MIN = 2;
export const WARN_SUSTAINED_MS = 5 * 60_000;
export const CRIT_CONFIRM_TICKS = 2;
export const OK_CONFIRM_TICKS = 2;

export interface LevelState { level: MemLevel; since: number; reasons: string[]; warnSince: number | null; critTicks: number; okTicks: number }

const GIB = 1024 ** 3;
const GROWTH_WINDOW_MS = 5 * 60_000;
// A baseline older than this is a sampling gap (sleep, a stalled tick), not a
// trend: no growth figure rather than one stretched over the gap.
const GROWTH_MAX_SPAN_MS = 10 * 60_000;

function vmPages(vmStat: string, label: string): number | null {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^"?${esc}"?:\\s+(\\d+)\\.?\\s*$`, 'm').exec(vmStat);
  return m ? Number(m[1]) : null;
}

/** `sysctl -n vm.swapusage` → used GB ("used = 18944.50M"; K/M/G suffixes). */
function swapUsedGB(swapusage: string): number | null {
  const m = /used\s*=\s*([\d.]+)\s*([KMG])/i.exec(swapusage);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  return unit === 'G' ? n : unit === 'M' ? n / 1024 : n / (1024 * 1024);
}

/**
 * vm_stat ("page size of N bytes", "Pages occupied by compressor",
 * free+speculative+purgeable+file-backed → availGB),
 * `sysctl -n kern.memorystatus_vm_pressure_level` (1|2|4),
 * `sysctl -n vm.swapusage` ("used = 18.50M|G").
 *
 * null when the compressor or swap cannot be read: those two drive the ladder,
 * and a made-up zero would read as "swap just collapsed" and then, one tick
 * later, as a burst of growth. The kernel level and `availGB` may be missing.
 */
export function parseMemSample(vmStat: string, pressure: string, swapusage: string, now: number): MemSample | null {
  const ps = /page size of (\d+) bytes/.exec(vmStat || '');
  if (!ps) return null;
  const pageSize = Number(ps[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const compressor = vmPages(vmStat, 'Pages occupied by compressor');
  if (compressor === null) return null;
  const swap = swapUsedGB(swapusage || '');
  if (swap === null) return null;

  const free = vmPages(vmStat, 'Pages free');
  const speculative = vmPages(vmStat, 'Pages speculative');
  const purgeable = vmPages(vmStat, 'Pages purgeable');
  const fileBacked = vmPages(vmStat, 'File-backed pages');
  const availGB = free === null
    ? null
    : ((free + (speculative ?? 0) + (purgeable ?? 0) + (fileBacked ?? 0)) * pageSize) / GIB;

  const p = Number.parseInt((pressure || '').trim(), 10);
  return {
    at: now,
    pressure: p === 1 || p === 2 || p === 4 ? p : null,
    compressedGB: (compressor * pageSize) / GIB,
    swapUsedGB: swap,
    availGB,
  };
}

/**
 * Swap growth over the trailing five minutes, in GB per 5 min (negative when
 * swap is draining). null until ≥5 min of samples: the baseline is the newest
 * sample at least five minutes older than the latest one.
 */
export function swapGrowthGBper5min(samples: MemSample[], now: number): number | null {
  const usable = samples.filter((s) => s.at <= now);
  if (usable.length < 2) return null;
  const latest = usable[usable.length - 1];
  let base: MemSample | null = null;
  for (let i = usable.length - 2; i >= 0; i--) {
    if (latest.at - usable[i].at >= GROWTH_WINDOW_MS) { base = usable[i]; break; }
  }
  if (!base) return null;
  const span = latest.at - base.at;
  if (span > GROWTH_MAX_SPAN_MS) return null;
  return ((latest.swapUsedGB - base.swapUsedGB) * GROWTH_WINDOW_MS) / span;
}

function gb(n: number): string {
  return n.toFixed(1);
}

/**
 * critical: pressure===4 || compressedGB>60 || growth>2, after CRIT_CONFIRM_TICKS consecutive;
 * warn: pressure===2 || compressed>32 || swap>8; closed: warn sustained ≥ WARN_SUSTAINED_MS;
 * ok: none of the above for OK_CONFIRM_TICKS; unknown: sample null.
 *
 * A level that is only being HELD while a change confirms is never 'critical':
 * the actor acts on 'critical', so it must not act on a signal that has already
 * gone. A held critical reads as 'closed'.
 */
export function nextLevel(prev: LevelState, s: MemSample | null, samples: MemSample[], now: number): LevelState {
  const at = (level: MemLevel): number => (level === prev.level ? prev.since : now);

  if (!s) {
    // One unreadable sample does not restart the sustained-warn clock.
    return { level: 'unknown', since: at('unknown'), reasons: ['memory sample unreadable'], warnSince: prev.warnSince, critTicks: 0, okTicks: 0 };
  }

  const growth = swapGrowthGBper5min(samples, now);
  const crit: string[] = [];
  if (s.pressure === 4) crit.push('kernel memory pressure critical');
  if (s.compressedGB > CRIT_COMPRESSED_GB) crit.push(`compressed ${gb(s.compressedGB)} GB > ${CRIT_COMPRESSED_GB}`);
  if (growth !== null && growth > CRIT_SWAP_GROWTH_GB_PER_5MIN) crit.push(`swap growing ${gb(growth)} GB / 5 min > ${CRIT_SWAP_GROWTH_GB_PER_5MIN}`);
  const warn: string[] = [];
  if (s.pressure === 2) warn.push('kernel memory pressure warn');
  if (s.compressedGB > WARN_COMPRESSED_GB && s.compressedGB <= CRIT_COMPRESSED_GB) warn.push(`compressed ${gb(s.compressedGB)} GB > ${WARN_COMPRESSED_GB}`);
  if (s.swapUsedGB > WARN_SWAP_GB) warn.push(`swap ${gb(s.swapUsedGB)} GB > ${WARN_SWAP_GB}`);

  if (crit.length === 0 && warn.length === 0) {
    const okTicks = prev.okTicks + 1;
    if (okTicks >= OK_CONFIRM_TICKS) {
      return { level: 'ok', since: at('ok'), reasons: [], warnSince: null, critTicks: 0, okTicks };
    }
    const held: MemLevel = prev.level === 'critical' ? 'closed' : prev.level;
    return { level: held, since: at(held), reasons: [`clearing (${okTicks}/${OK_CONFIRM_TICKS})`], warnSince: prev.warnSince, critTicks: 0, okTicks };
  }

  const warnSince = prev.warnSince ?? now;
  const sustained: MemLevel = now - warnSince >= WARN_SUSTAINED_MS || prev.level === 'closed' || prev.level === 'critical' ? 'closed' : 'warn';

  if (crit.length > 0) {
    const critTicks = prev.critTicks + 1;
    if (critTicks >= CRIT_CONFIRM_TICKS) {
      return { level: 'critical', since: at('critical'), reasons: [...crit, ...warn], warnSince, critTicks, okTicks: 0 };
    }
    return { level: sustained, since: at(sustained), reasons: [...crit, ...warn, `confirming critical (${critTicks}/${CRIT_CONFIRM_TICKS})`], warnSince, critTicks, okTicks: 0 };
  }

  return { level: sustained, since: at(sustained), reasons: warn, warnSince, critTicks: 0, okTicks: 0 };
}
