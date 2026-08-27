import type {
  PerfActionRow, PerfHistory, PerfHistoryPoint, PerfSnapshot, PerfToolCategory,
} from '../shared/types';
import { fmtMB, fmtMs, perfVerdict } from '../shared/perf-severity';

/**
 * Turns what the Performance view is showing into something a Claude Code
 * session can actually read: the live snapshot plus the chosen slice of the
 * rolling history, rendered as a markdown digest (+ a raw JSON side-car).
 *
 * Everything here is pure — main.ts owns the filesystem — so the shape of the
 * report is unit-testable without an Electron app around it.
 */

export interface PerfReportInput {
  snapshot: PerfSnapshot;
  history: PerfHistory | null;
  // The window the user picked in the header (5 / 15 / 30 / 60 min).
  rangeMin: number;
  now?: number;
}

export interface PerfReportData {
  generatedAt: string;
  rangeMin: number;
  samples: number;
  intervalMs: number;
  verdict: ReturnType<typeof perfVerdict>;
  snapshot: PerfSnapshot;
  history: PerfHistory | null;
}

export interface PerfReport {
  markdown: string;
  data: PerfReportData;
  // One line for the UI: "1h · 720 samples · danger".
  summary: string;
}

const SPARK = '▁▂▃▄▅▆▇█';
const DOWNSAMPLE_ROWS = 30;
const TOP_ROWS = 10;

export interface SeriesStats {
  n: number;
  min: number;
  med: number;
  p95: number;
  max: number;
  mean: number;
}

function nums(values: Array<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/** min / median / p95 / max / mean over the non-null samples, or null if none. */
export function seriesStats(values: Array<number | null | undefined>): SeriesStats | null {
  const v = nums(values);
  if (v.length === 0) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  return {
    n: v.length,
    min: sorted[0],
    med: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    mean: v.reduce((s, x) => s + x, 0) / v.length,
  };
}

/**
 * A unicode sparkline of the series, scaled 0..max so the shape survives the
 * trip into a text prompt (an agent reading the digest still sees the spikes).
 */
export function sparkline(values: Array<number | null | undefined>, width = 40): string {
  const v = nums(values);
  if (v.length === 0) return '';
  const buckets = bucketize(v, Math.min(width, v.length));
  const max = Math.max(...buckets);
  const min = Math.min(...buckets);
  if (max <= 0) return SPARK[0].repeat(buckets.length);
  // A series that never moves is drawn flat at mid-height — full-height blocks
  // would read as "pinned at maximum", which is the opposite of the truth.
  if (max - min < max * 0.005) return SPARK[3].repeat(buckets.length);
  return buckets.map((x) => SPARK[Math.min(SPARK.length - 1, Math.round((x / max) * (SPARK.length - 1)))]).join('');
}

/** Split into `count` contiguous buckets and take the mean of each. */
function bucketize(values: number[], count: number): number[] {
  if (count <= 0 || values.length === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * values.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / count));
    const slice = values.slice(from, to);
    out.push(slice.reduce((s, x) => s + x, 0) / slice.length);
  }
  return out;
}

/**
 * Fold the raw 5-second points into ~30 rows. Averages the level metrics and
 * keeps the WORST lag in each bucket — a 4-second freeze must not be averaged
 * away, it is the whole reason someone opens this panel.
 */
export function downsamplePoints(points: PerfHistoryPoint[], rows = DOWNSAMPLE_ROWS): Array<{
  from: number; to: number;
  cpuBusyPct: number | null; load1: number | null; memUsedPct: number | null;
  lagMaxMs: number; appCpuPct: number | null; agentsCpu: number | null; threadsRunning: number | null;
}> {
  if (points.length === 0) return [];
  const count = Math.min(rows, points.length);
  const out = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * points.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * points.length) / count));
    const slice = points.slice(from, to);
    const mean = (pick: (p: PerfHistoryPoint) => number | null | undefined): number | null => {
      const v = nums(slice.map(pick));
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
    };
    out.push({
      from: slice[0].t,
      to: slice[slice.length - 1].t,
      cpuBusyPct: mean((p) => p.cpuBusyPct),
      load1: mean((p) => p.load1),
      memUsedPct: mean((p) => p.memUsedPct),
      lagMaxMs: Math.max(0, ...slice.map((p) => p.lagMaxMs || 0)),
      appCpuPct: mean((p) => p.mainCpuPct + p.rendererCpuPct),
      agentsCpu: mean((p) => p.agentsCpu),
      threadsRunning: mean((p) => (p.threads ? p.threads.running : null)),
    });
  }
  return out;
}

export interface RangeTop {
  key: string;
  label: string;
  meanCpu: number;
  peakCpu: number;
  samples: number;
  extra?: string;
}

/**
 * Rank contributors across the window by mean CPU. `mean` is over the whole
 * window (not just the samples the thing appears in), so a command that ran
 * for 20 s out of 15 min does not outrank one that ran throughout.
 */
export function rankOverRange<T>(
  points: PerfHistoryPoint[],
  rowsAt: (p: PerfHistoryPoint) => T[] | null | undefined,
  keyOf: (row: T) => string,
  labelOf: (row: T) => string,
  cpuOf: (row: T) => number,
  extraOf?: (row: T) => string | undefined,
): RangeTop[] {
  const acc = new Map<string, { label: string; total: number; peak: number; samples: number; extra?: string }>();
  let censusPoints = 0;
  for (const p of points) {
    const rows = rowsAt(p);
    if (!rows) continue;
    censusPoints++;
    for (const r of rows) {
      const key = keyOf(r);
      const cpu = cpuOf(r);
      const prev = acc.get(key);
      if (!prev) acc.set(key, { label: labelOf(r), total: cpu, peak: cpu, samples: 1, extra: extraOf?.(r) });
      else {
        prev.total += cpu;
        prev.peak = Math.max(prev.peak, cpu);
        prev.samples++;
        if (!prev.extra && extraOf) prev.extra = extraOf(r);
      }
    }
  }
  const denom = Math.max(1, censusPoints);
  return Array.from(acc.entries())
    .map(([key, v]) => ({ key, label: v.label, meanCpu: v.total / denom, peakCpu: v.peak, samples: v.samples, extra: v.extra }))
    .sort((a, b) => b.meanCpu - a.meanCpu);
}

// ---------- formatting helpers ----------

function n1(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  return Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : `${n1(v)}%`;
}

function clock(t: number): string {
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function stamp(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dur(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function actionKey(a: PerfActionRow): string {
  return `${a.name}|${a.cmd}`;
}

function actionLabel(a: { name: string; cmd: string }): string {
  return a.cmd ? `${a.name} ${a.cmd}` : a.name;
}

function agentLabel(pid: number, names: PerfHistory['agentNames']): string {
  const n = names[String(pid)];
  if (!n) return `claude (pid ${pid})`;
  if (n.title) return n.peer ? `${n.peer} · ${n.title}` : n.title;
  return n.kind === 'spare' ? `bg agent (pid ${pid})` : `session (pid ${pid})`;
}

// ---------- the report ----------

export function buildPerfReport({ snapshot, history, rangeMin, now = Date.now() }: PerfReportInput): PerfReport {
  const since = now - rangeMin * 60_000;
  const points = (history?.points ?? []).filter((p) => p.t >= since);
  const names = history?.agentNames ?? {};
  const intervalMs = history?.intervalMs ?? 5000;
  const verdict = perfVerdict(snapshot);
  const s = snapshot.system;
  const app = snapshot.app;
  const loadRatio = s.cores > 0 ? s.load1 / s.cores : 0;
  const rangeLabel = rangeMin >= 60 ? `${rangeMin / 60} h` : `${rangeMin} min`;

  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines, '');

  push(
    '# Performance report — Peers Flow',
    '',
    `Captured **${stamp(snapshot.at)}** (local time) · window: **last ${rangeLabel}** · ${points.length} samples every ${Math.round(intervalMs / 1000)} s`,
    '',
    `**Verdict: ${verdict.severity.toUpperCase()}** — ${verdict.reason}`,
  );

  push(
    '> How to read the CPU numbers: machine CPU is 0–100% of ALL cores combined.',
    `> Per-agent and per-command CPU is the classic \`ps\` percentage — 100% = one core fully busy — so on this ${s.cores}-core machine a single agent can legitimately read 400%.`,
    '> Agent CPU is billed to the nearest agent ancestor, so a delegated peer session is its own row rather than folded into its parent.',
  );

  // ---- 1. machine now ----
  const procs = snapshot.processes;
  push('## 1 · Machine right now', '', table(['metric', 'value'], [
    ['CPU busy (all cores)', pct(s.cpuBusyPct)],
    ['Load 1 / 5 / 15', `${n1(s.load1)} / ${n1(s.load5)} / ${n1(s.load15)} on ${s.cores} cores (${n1(loadRatio)}× cores)`],
    ['Memory', `${fmtMB(s.memUsedMB)} of ${fmtMB(s.memTotalMB)} (${s.memUsedPct}%) · pressure ${s.memPressure ?? 'unknown'} · swap ${fmtMB(s.swapUsedMB)}`],
    ['Threads', s.threads ? `${s.threads.total.toLocaleString()} alive · ${s.threads.running.toLocaleString()} on CPU right now · ${s.threads.underAgents.toLocaleString()} under agents` : '–'],
    ['Processes', procs ? `${procs.total.toLocaleString()} total · ${procs.claude} claude (${fmtMB(procs.claudeRssMB)}) · ${procs.node} node · ${procs.vitest} vitest · ${procs.chrome} chrome` : '– (no census yet)'],
    ['Census taken', snapshot.censusAt ? stamp(snapshot.censusAt) : '–'],
  ]));

  // ---- 2. this app now ----
  const res = Object.entries(snapshot.resources).map(([k, v]) => `${k}=${v}`).join(' · ');
  push('## 2 · This app right now', '', table(['metric', 'value'], [
    ['Main-process CPU', pct(app.mainCpuPct)],
    ['Renderer + helpers CPU', `${pct(app.rendererCpuPct)} (gpu ${pct(app.gpuCpuPct)})`],
    ['Memory', `main ${fmtMB(app.mainRssMB)} · all processes ${fmtMB(app.totalRssMB)} · JS heap ${fmtMB(app.heapMB)}`],
    ['Event-loop lag', `now ${fmtMs(snapshot.loop.lagNowMs)} · worst in last 60 s ${fmtMs(snapshot.loop.lagMaxMs)} · mean ${fmtMs(snapshot.loop.lagAvgMs)}`],
    ['Stalls since launch', `${snapshot.loop.stalls}${snapshot.loop.lastStallAt ? ` · last ${fmtMs(snapshot.loop.lastStallMs)} at ${stamp(snapshot.loop.lastStallAt)}` : ''}`],
    ['Uptime', dur(app.uptimeS)],
  ]));
  if (res) push(`Health counters: \`${res}\``);
  if (snapshot.logPath) push(`Main log (the durable record of the same events): \`${snapshot.logPath}\``);

  // ---- 3. the window, series by series ----
  if (points.length >= 2) {
    const seriesRows: Array<[string, Array<number | null>, (v: number) => string]> = [
      ['Machine CPU busy %', points.map((p) => p.cpuBusyPct), (v) => pct(v)],
      ['Load (1 min)', points.map((p) => p.load1), (v) => n1(v)],
      ['Memory used %', points.map((p) => p.memUsedPct), (v) => pct(v)],
      ['Threads on CPU', points.map((p) => (p.threads ? p.threads.running : null)), (v) => n1(v)],
      ['Threads alive', points.map((p) => (p.threads ? p.threads.total : null)), (v) => n1(v)],
      ['Threads under agents', points.map((p) => (p.threads ? p.threads.underAgents : null)), (v) => n1(v)],
      ['App main CPU %', points.map((p) => p.mainCpuPct), (v) => pct(v)],
      ['App renderer CPU %', points.map((p) => p.rendererCpuPct), (v) => pct(v)],
      ['Event-loop lag (max/sample)', points.map((p) => p.lagMaxMs), (v) => fmtMs(v)],
      ['Agents CPU total %', points.map((p) => p.agentsCpu), (v) => pct(v)],
    ];
    const rows: string[][] = [];
    for (const [label, values, fmt] of seriesRows) {
      const st = seriesStats(values);
      if (!st) continue;
      rows.push([label, fmt(st.min), fmt(st.med), fmt(st.p95), fmt(st.max), `\`${sparkline(values)}\``]);
    }
    push(
      `## 3 · The last ${rangeLabel}, series by series`,
      '',
      table(['series', 'min', 'median', 'p95', 'max', 'shape (oldest → newest)'], rows),
    );

    // ---- 4. downsampled timeline ----
    const ds = downsamplePoints(points);
    push(
      '## 4 · Timeline (downsampled)',
      '',
      table(
        ['time', 'cpu %', 'load', 'mem %', 'worst lag', 'app cpu %', 'agents cpu %', 'thr on cpu'],
        ds.map((r) => [
          clock(r.from),
          n1(r.cpuBusyPct), n1(r.load1), n1(r.memUsedPct), fmtMs(r.lagMaxMs),
          n1(r.appCpuPct), n1(r.agentsCpu), n1(r.threadsRunning),
        ]),
      ),
    );

    // ---- 5. agents over the window ----
    const agents = rankOverRange(
      points,
      (p) => p.agents,
      (a) => String(a.pid),
      (a) => agentLabel(a.pid, names),
      (a) => a.cpu,
    ).slice(0, TOP_ROWS);
    if (agents.length > 0) {
      push(
        '## 5 · Which agents burned CPU in this window',
        '',
        table(['agent', 'mean cpu %', 'peak cpu %', 'samples seen'], agents.map((a) => [
          a.label, n1(a.meanCpu), n1(a.peakCpu), String(a.samples),
        ])),
      );
    }

    // ---- 6. actions over the window ----
    const actions = rankOverRange(
      points,
      (p) => p.topActions,
      (a) => actionKey(a),
      (a) => actionLabel(a),
      (a) => a.cpu,
      (a) => `${a.category} · ${agentLabel(a.pid, names)}`,
    ).slice(0, TOP_ROWS);
    if (actions.length > 0) {
      push(
        '## 6 · What those agents were actually running',
        '',
        table(['command', 'mean cpu %', 'peak cpu %', 'category · first-seen owner'], actions.map((a) => [
          `\`${a.label}\``, n1(a.meanCpu), n1(a.peakCpu), a.extra ?? '',
        ])),
      );
    }

    // ---- 7. category mix ----
    const catTotals = new Map<PerfToolCategory, { total: number; peak: number }>();
    let catPoints = 0;
    for (const p of points) {
      if (!p.byCategory) continue;
      catPoints++;
      for (const [k, v] of Object.entries(p.byCategory)) {
        const key = k as PerfToolCategory;
        const prev = catTotals.get(key) ?? { total: 0, peak: 0 };
        catTotals.set(key, { total: prev.total + (v ?? 0), peak: Math.max(prev.peak, v ?? 0) });
      }
    }
    if (catTotals.size > 0) {
      const rows = Array.from(catTotals.entries())
        .map(([k, v]) => ({ k, mean: v.total / Math.max(1, catPoints), peak: v.peak }))
        .sort((a, b) => b.mean - a.mean)
        .map((r) => [r.k, n1(r.mean), n1(r.peak)]);
      push('## 7 · Agent CPU by activity', '', table(['category', 'mean cpu %', 'peak cpu %'], rows));
    }

    // ---- 8. machine-wide commands over the window ----
    const topProcs = rankOverRange(
      points,
      (p) => p.topProcs,
      (r) => r.name,
      (r) => r.name,
      (r) => r.cpu,
    ).slice(0, TOP_ROWS);
    if (topProcs.length > 0) {
      push(
        '## 8 · Machine-wide top commands in this window (agents or not)',
        '',
        table(['command', 'mean cpu %', 'peak cpu %'], topProcs.map((r) => [r.label, n1(r.meanCpu), n1(r.peakCpu)])),
      );
    }
  } else {
    push(`## 3 · The last ${rangeLabel}`, '', `_Only ${points.length} history sample(s) fall in this window — the rolling history resets when the app restarts, so there is nothing to trend yet._`);
  }

  // ---- 9. live agent detail ----
  const live = snapshot.agents;
  if (live && live.rows.length > 0) {
    push(
      `## 9 · Live agent detail (at ${stamp(snapshot.at)})`,
      '',
      `${live.rows.length} agent process(es) · ${n1(live.totalCpu)}% CPU combined${typeof live.threads === 'number' ? ` · ${live.threads.toLocaleString()} threads` : ''}`,
      '',
      table(['agent', 'kind', 'cpu %', 'self cpu %', 'rss', 'procs', 'status', 'running now'], live.rows.slice(0, TOP_ROWS).map((r) => [
        r.title ? (r.peer ? `${r.peer} · ${r.title}` : r.title) : `pid ${r.pid}`,
        r.kind,
        n1(r.cpu),
        n1(r.selfCpu),
        fmtMB(r.rssMB),
        String(r.procs),
        r.status ?? '–',
        r.tools.slice(0, 3).map((t) => `${actionLabel(t)} (${n1(t.cpu)}%)`).join(', ') || '–',
      ])),
    );
  }

  // ---- 10. machine top processes now ----
  if (procs && procs.topCpu.length > 0) {
    push(
      '## 10 · Top processes right now (by command)',
      '',
      table(['command', 'cpu %', 'rss', 'count', 'under agents', 'biggest groups'], procs.topCpu.map((r) => [
        r.name,
        n1(r.cpu),
        fmtMB(r.rssMB),
        String(r.count),
        `${r.underAgents.count} proc · ${n1(r.underAgents.cpu)}%`,
        r.groups.slice(0, 3).map((g) => `${g.label} (${g.count}×, ${n1(g.cpu)}%)`).join(', ') || '–',
      ])),
    );
  }

  if (snapshot.docker && snapshot.docker.containers > 0) {
    push(
      '## 11 · Docker',
      '',
      `${snapshot.docker.containers} container(s) running`,
      '',
      table(['container', 'cpu %', 'memory'], snapshot.docker.top.map((c) => [c.name, n1(c.cpu), fmtMB(c.memMB)])),
    );
  }

  // ---- main-thread ops ----
  const ops = snapshot.ops;
  if (ops.rows.length > 0) {
    push(
      "## 12 · This app's own operations (IPC handlers, main thread)",
      '',
      `Window since ${stamp(ops.windowSince)}. An op that blocks here blocks the whole UI.`,
      '',
      table(['operation', 'count', 'avg', 'max', 'over slow threshold', 'slowest peer'], ops.rows.map((r) => [
        r.label, String(r.count), fmtMs(r.avgMs), fmtMs(r.maxMs), String(r.overCount), r.maxPeer ?? '–',
      ])),
    );
  }
  if (ops.recentSlow.length > 0) {
    push(
      '### Recent slow operations',
      '',
      table(['at', 'operation', 'duration', 'peer'], ops.recentSlow.map((r) => [
        stamp(r.at), r.label, fmtMs(r.ms), r.peer ?? '–',
      ])),
    );
  }

  push(
    '---',
    '',
    'Generated by the Peers Flow performance monitor. The raw samples behind every table above are in the `.json` file next to this one (same base name): `snapshot` is the live sample, `history.points` is the full 5-second series for this window.',
  );

  const markdown = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  return {
    markdown,
    data: {
      generatedAt: new Date(now).toISOString(),
      rangeMin,
      samples: points.length,
      intervalMs,
      verdict,
      snapshot,
      history: history ? { intervalMs, points, agentNames: names } : null,
    },
    summary: `${rangeLabel} · ${points.length} samples · ${verdict.severity}`,
  };
}

/**
 * JSON for the side-car file: pretty everywhere EXCEPT the history points,
 * which get one compact line each. A 1 h window is 720 samples — pretty-printed
 * that is a multi-megabyte file of two-token lines, and one long line is worse
 * still for anything reading it with a line-based tool. One point per line is
 * both greppable and cheap.
 */
export function serializeReportData(data: PerfReportData): string {
  const points = data.history?.points ?? [];
  const head = {
    generatedAt: data.generatedAt,
    rangeMin: data.rangeMin,
    samples: data.samples,
    intervalMs: data.intervalMs,
    verdict: data.verdict,
    snapshot: data.snapshot,
  };
  const body = JSON.stringify(head, null, 2).replace(/\n\}$/, '');
  if (!data.history) return `${body},\n  "history": null\n}\n`;
  return [
    body + ',',
    '  "history": {',
    `    "intervalMs": ${data.history.intervalMs},`,
    `    "agentNames": ${JSON.stringify(data.history.agentNames)},`,
    '    "points": [',
    points.map((p) => `    ${JSON.stringify(p)}`).join(',\n'),
    '    ]',
    '  }',
    '}',
    '',
  ].join('\n');
}

/** `perf-2026-08-27T15-04-11-15m` — sortable, collision-free enough, readable. */
export function reportBasename(rangeMin: number, now = new Date()): string {
  const p = (x: number) => String(x).padStart(2, '0');
  const ts = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  return `perf-${ts}-${rangeMin}m`;
}
