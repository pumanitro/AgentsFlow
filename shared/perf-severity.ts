import type { PerfSnapshot } from './types';

export type PerfSeverity = 'normal' | 'warning' | 'danger';

export interface PerfVerdict {
  severity: PerfSeverity;
  // Two bare numbers for the collapsed header, e.g. "100% · 4.6s" — the
  // sidebar is ~280px wide and the header also holds the title and ↻, so
  // labels go in `badgeLong` (tooltip) instead of the badge itself.
  badge: string;
  badgeLong: string;
  // The single worst dimension, in words — the tooltip / first line of the body.
  reason: string;
}

const RANK: Record<PerfSeverity, number> = { normal: 0, warning: 1, danger: 2 };

export function worse(a: PerfSeverity, b: PerfSeverity): PerfSeverity {
  return RANK[b] > RANK[a] ? b : a;
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  if (ms >= 10_000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export function fmtMB(mb: number): string {
  if (!Number.isFinite(mb) || mb < 0) return '–';
  if (mb >= 10_240) return `${Math.round(mb / 1024)} GB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

// Thresholds. Load is judged relative to core count: 1× means every core has
// a runnable thread; 2× means the machine is oversubscribed and every process
// — this app included — is waiting for CPU it will not get.
export const LOAD_WARN = 1.0;
export const LOAD_DANGER = 2.0;
export const CPU_WARN = 80;
export const CPU_DANGER = 95;
export const LAG_WARN_MS = 250;
export const LAG_DANGER_MS = 1000;
export const MEM_WARN = 85;
export const MEM_DANGER = 95;

export function severityFor(value: number, warnAt: number, dangerAt: number): PerfSeverity {
  if (value >= dangerAt) return 'danger';
  if (value >= warnAt) return 'warning';
  return 'normal';
}

/** The kernel's pressure level wins when known; otherwise fall back to used-%. */
export function memorySeverity(sys: Pick<PerfSnapshot['system'], 'memUsedPct' | 'memPressure'>): PerfSeverity {
  if (sys.memPressure === 'critical') return 'danger';
  if (sys.memPressure === 'warning') return 'warning';
  if (sys.memPressure === 'normal') return severityFor(sys.memUsedPct, MEM_DANGER, 101);
  return severityFor(sys.memUsedPct, MEM_WARN, MEM_DANGER);
}

/** Summarise a snapshot into one severity + a header badge + a one-line cause. */
export function perfVerdict(s: PerfSnapshot): PerfVerdict {
  const loadRatio = s.system.cores > 0 ? s.system.load1 / s.system.cores : 0;
  const cpu = s.system.cpuBusyPct;
  const dims: Array<{ sev: PerfSeverity; reason: string }> = [
    {
      sev: severityFor(loadRatio, LOAD_WARN, LOAD_DANGER),
      reason: `Machine oversubscribed: load ${s.system.load1.toFixed(0)} on ${s.system.cores} cores (${loadRatio.toFixed(1)}×) — every process is waiting for CPU.`,
    },
    {
      sev: cpu === null ? 'normal' : severityFor(cpu, CPU_WARN, CPU_DANGER),
      reason: `Machine CPU at ${cpu ?? 0}% — other processes are consuming the cores.`,
    },
    {
      sev: severityFor(s.loop.lagMaxMs, LAG_WARN_MS, LAG_DANGER_MS),
      reason: `Main event loop lagged ${fmtMs(s.loop.lagMaxMs)} in the last minute — the UI froze for that long.`,
    },
    {
      sev: memorySeverity(s.system),
      reason: s.system.memPressure && s.system.memPressure !== 'normal'
        ? `Memory pressure ${s.system.memPressure} (${s.system.memUsedPct}% used) — the kernel is compressing and swapping.`
        : `Memory at ${s.system.memUsedPct}% — the machine is close to swapping.`,
    },
  ];
  let worst = dims[0];
  for (const d of dims) if (RANK[d.sev] > RANK[worst.sev]) worst = d;
  const cpuShort = cpu === null ? `L${s.system.load1.toFixed(0)}` : `${Math.round(cpu)}%`;
  const cpuLong = cpu === null ? `load ${s.system.load1.toFixed(0)}` : `CPU ${Math.round(cpu)}%`;
  return {
    severity: worst.sev,
    badge: `${cpuShort} · ${fmtMs(s.loop.lagMaxMs)}`,
    badgeLong: `${cpuLong} · lag ${fmtMs(s.loop.lagMaxMs)}`,
    reason: worst.sev === 'normal' ? 'Machine and app are healthy.' : worst.reason,
  };
}
