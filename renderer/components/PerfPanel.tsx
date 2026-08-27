import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import type { PerfActionRow, PerfAgentRow, PerfHistory, PerfHistoryPoint, PerfSnapshot, PerfToolCategory, TrackedDirectory } from '../../shared/types';
import PerfAsk from './PerfAsk';
import { LineChart, OTHER_COLOR, PALETTE, type Series } from './PerfCharts';
import {
  CPU_DANGER, CPU_WARN, LAG_DANGER_MS, LAG_WARN_MS,
  fmtMB, fmtMs, memorySeverity, perfVerdict, severityFor, type PerfSeverity,
} from '../../shared/perf-severity';

// Open: fast enough to watch a spike happen. Closed: only the header pill
// needs feeding, and the census behind it spawns `ps`, so go slow.
// Section identity colour, shared with the old sidebar card.
const ZONE_COLOR = '#f472b6';
const OPEN_REFRESH_MS = 3000;
const CLOSED_REFRESH_MS = 20_000;

const SEV_COLOR: Record<PerfSeverity, string> = {
  normal: '#4ade80',
  warning: '#fbbf24',
  danger: '#ef4444',
};

function ago(iso: string | null): string {
  if (!iso) return '–';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Bar({ pct, severity }: { pct: number; severity: PerfSeverity }) {
  const color = SEV_COLOR[severity];
  return (
    <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}>
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-wider text-subtle">{children}</div>;
}

// One "label ....... value" line with an optional coloured value and sub-note.
function Row({ label, value, severity, sub }: { label: string; value: string; severity?: PerfSeverity; sub?: string }) {
  return (
    <div className="px-3 py-0.5 flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-muted truncate">{label}</span>
      <span className="text-[11px] font-mono shrink-0 text-right" style={{ color: severity ? SEV_COLOR[severity] : undefined }}>
        <span className={severity ? '' : 'text-text'}>{value}</span>
        {sub && <span className="text-subtle ml-1.5">{sub}</span>}
      </span>
    </div>
  );
}

function MeterRow({ label, pct, severity, right }: { label: string; pct: number; severity: PerfSeverity; right: string }) {
  return (
    <div className="px-3 py-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-text truncate">{label}</span>
        <span className="text-[11px] font-mono shrink-0" style={{ color: SEV_COLOR[severity] }}>{right}</span>
      </div>
      <Bar pct={pct} severity={severity} />
    </div>
  );
}

// Polls the main process. `fast` while the monitor is open; slow otherwise so
// the header pill stays live without spawning `ps` every few seconds.
function usePerfSnapshot(fast: boolean) {
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  const unavailable = typeof api().getPerfSnapshot !== 'function';

  const load = useCallback(async () => {
    const a = api();
    if (typeof a.getPerfSnapshot !== 'function') return;
    setLoading(true);
    try {
      const s = await a.getPerfSnapshot();
      if (!mounted.current) return;
      setSnap(s);
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (unavailable) return () => { mounted.current = false; };
    void load();
    const t = setInterval(() => void load(), fast ? OPEN_REFRESH_MS : CLOSED_REFRESH_MS);
    return () => { mounted.current = false; clearInterval(t); };
  }, [load, fast, unavailable]);

  return { snap, failed, loading, unavailable, load };
}

// Polls the rolling history while the Timeline view is visible.
function usePerfHistory(active: boolean) {
  const [history, setHistory] = useState<PerfHistory | null>(null);
  const mounted = useRef(true);
  const unavailable = typeof api().getPerfHistory !== 'function';
  useEffect(() => {
    mounted.current = true;
    if (!active || unavailable) return () => { mounted.current = false; };
    const load = async () => {
      try {
        const h = await api().getPerfHistory();
        if (mounted.current) setHistory(h);
      } catch { /* keep the previous frame */ }
    };
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => { mounted.current = false; clearInterval(t); };
  }, [active, unavailable]);
  return { history, unavailable };
}

// A persisted string preference (view / range), hydrated after mount.
function usePersisted<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setRaw] = useState<T>(fallback);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) setRaw(raw as T);
    } catch { /* ignore */ }
  }, [key]);
  const set = useCallback((v: T) => {
    setRaw(v);
    try { localStorage.setItem(key, v); } catch { /* ignore */ }
  }, [key]);
  return [value, set];
}

type PerfView = 'timeline' | 'now';
// `label` is the button; `spoken` is how the same window reads in a sentence
// (the Ask composer puts it in the prompt it hands the spawned session).
const RANGES: Array<{ key: string; min: number; label: string; spoken: string }> = [
  { key: '5', min: 5, label: '5m', spoken: '5 minutes' },
  { key: '15', min: 15, label: '15m', spoken: '15 minutes' },
  { key: '30', min: 30, label: '30m', spoken: '30 minutes' },
  { key: '60', min: 60, label: '1h', spoken: 'hour' },
];

export interface PerfLauncherProps {
  // Everything the "Ask about this" composer needs to spawn a session: where
  // it can spawn, and the same handler the main SpawnBar uses (so a session
  // started from here lands and focuses exactly like any other).
  dirs?: TrackedDirectory[];
  targetDir?: TrackedDirectory | null;
  onSend?: (prompt: string, attachments: string[], model: string, directoryId: string) => Promise<void>;
}

/**
 * The header pill next to ☰: live severity dot + "54% · 66ms". Click opens
 * the full monitor as an overlay.
 */
export default function PerfLauncher({ dirs = [], targetDir = null, onSend }: PerfLauncherProps) {
  const [open, setOpen] = useState(false);
  const { snap, unavailable } = usePerfSnapshot(false);
  const verdict = snap ? perfVerdict(snap) : null;
  const color = verdict ? SEV_COLOR[verdict.severity] : undefined;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="shrink-0 h-6 px-2 rounded-full border border-border bg-panel hover:bg-panel2 hover:border-accent flex items-center gap-1.5 text-[10px] font-mono"
        style={{ color: color ?? undefined }}
        title={verdict ? `Performance: ${verdict.badgeLong} — ${verdict.reason}` : unavailable ? 'Performance monitor (restart the app to enable)' : 'Performance monitor'}
        aria-label="Open performance monitor"
      >
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${verdict?.severity === 'danger' ? 'animate-pulse' : ''}`}
          style={{ backgroundColor: color ?? '#8c93a8' }}
          aria-hidden="true"
        />
        <span className={verdict ? '' : 'text-muted'}>{verdict ? verdict.badge : 'perf'}</span>
      </button>
      {open && <PerfModal onClose={() => setOpen(false)} dirs={dirs} targetDir={targetDir} onSend={onSend} />}
    </>
  );
}

function PerfModal({ onClose, dirs, targetDir, onSend }: { onClose: () => void } & PerfLauncherProps) {
  const [view, setView] = usePersisted<PerfView>('agentsflow:perf:view', 'timeline');
  const [rangeKey, setRangeKey] = usePersisted<string>('agentsflow:perf:range', '15');
  const range = RANGES.find((r) => r.key === rangeKey);
  const rangeMin = range?.min ?? 15;
  const { snap, failed, loading, unavailable, load } = usePerfSnapshot(true);
  const { history } = usePerfHistory(view === 'timeline');
  // The renderer's own jank, measured here rather than in main: the longest
  // gap between animation frames since the previous sample. Main can be
  // perfectly responsive while this window is starved, and vice versa.
  const frameGapMax = useRef(0);
  const [uiFrameGapMs, setUiFrameGapMs] = useState(0);
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const gap = now - last;
      if (gap > frameGapMax.current) frameGapMax.current = gap;
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    if (!snap) return;
    setUiFrameGapMs(Math.round(frameGapMax.current));
    frameGapMax.current = 0;
  }, [snap]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const verdict = snap ? perfVerdict(snap) : null;
  const color = verdict ? SEV_COLOR[verdict.severity] : undefined;
  const openLog = () => {
    const a = api();
    if (snap?.logPath && typeof a.revealInFinder === 'function') void a.revealInFinder(snap.logPath);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-6xl max-h-[88vh] bg-panel border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        <header className="shrink-0 px-4 py-2.5 border-b border-border flex items-center gap-3 bg-panel2/60">
          <span className="w-1 h-4 rounded-full shrink-0" style={{ backgroundColor: ZONE_COLOR }} aria-hidden="true" />
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[11px] uppercase tracking-wider text-text font-semibold">Performance</span>
            {verdict && (
              <span className="text-[10px] font-mono flex items-center gap-1.5" style={{ color }}>
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${verdict.severity === 'danger' ? 'animate-pulse' : ''}`} style={{ backgroundColor: color }} aria-hidden="true" />
                {verdict.badgeLong}
              </span>
            )}
          </div>
          {/* View switch + (Timeline only) the time range. One row, scoping
              everything below it. */}
          <div className="flex items-center gap-1 ml-2">
            {(['timeline', 'now'] as PerfView[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${view === v ? 'border-accent text-text bg-panel' : 'border-border text-muted hover:text-text hover:bg-panel'}`}
                aria-pressed={view === v}
              >{v === 'timeline' ? 'Timeline' : 'Now'}</button>
            ))}
          </div>
          {view === 'timeline' && (
            <div className="flex items-center gap-1 ml-1">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRangeKey(r.key)}
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${rangeKey === r.key ? 'text-text bg-panel border border-border' : 'text-muted hover:text-text'}`}
                  aria-pressed={rangeKey === r.key}
                >{r.label}</button>
              ))}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => void load()}
              disabled={unavailable || loading}
              className={`text-muted hover:text-text px-1.5 py-0.5 rounded hover:bg-panel disabled:opacity-40 ${loading ? 'animate-spin' : ''}`}
              title="Sample now"
              aria-label="Refresh performance sample"
            >↻</button>
            <button
              onClick={onClose}
              className="text-muted hover:text-text px-1.5 py-0.5 rounded hover:bg-panel"
              title="Close (Esc)"
              aria-label="Close performance monitor"
            >✕</button>
          </div>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto pb-1">
          {unavailable ? (
            <div className="px-4 py-6 text-sm text-muted italic">
              Restart the app to enable the performance monitor (preload needs to refresh).
            </div>
          ) : !snap ? (
            <div className="px-4 py-6 text-sm text-muted italic">{failed ? 'Could not sample the main process.' : 'Sampling…'}</div>
          ) : view === 'timeline' ? (
            <PerfTimeline history={history} rangeMin={rangeMin} cores={snap.system.cores} verdict={verdict} />
          ) : (
            <PerfBody snap={snap} uiFrameGapMs={uiFrameGapMs} onOpenLog={openLog} loading={loading} layout="wide" />
          )}
        </div>
        {/* Ask about what is on screen: freezes this window's samples into a
            report and starts a session that already has them. Outside the
            scroll area so it is reachable without scrolling to the bottom. */}
        {onSend && (
          <PerfAsk
            dirs={dirs ?? []}
            defaultDir={targetDir ?? null}
            rangeMin={rangeMin}
            rangeLabel={range?.spoken ?? `${rangeMin} minutes`}
            onSend={onSend}
            onSpawned={onClose}
          />
        )}
      </div>
    </div>
  );
}

// Tool-category colours: what an agent's subprocesses are doing. Fixed slots
// of the validated categorical palette (identity never comes from rank), so
// the Now view's bars and the Timeline's stacked areas agree.
const CATEGORY_COLOR: Record<PerfToolCategory, string> = {
  test: PALETTE[0],
  build: PALETTE[1],
  search: PALETTE[2],
  git: PALETTE[3],
  claude: PALETTE[4],
  browser: PALETTE[5],
  mcp: PALETTE[6],
  shell: PALETTE[7],
  other: OTHER_COLOR,
};
const CATEGORY_LABEL: Record<PerfToolCategory, string> = {
  claude: 'claude itself',
  search: 'search',
  git: 'git',
  test: 'tests',
  build: 'build',
  shell: 'shell',
  mcp: 'mcp',
  browser: 'browser',
  other: 'other',
};
const CATEGORY_ORDER: PerfToolCategory[] = ['test', 'build', 'search', 'git', 'claude', 'browser', 'mcp', 'shell', 'other'];

function cpuSeverity(cpu: number): PerfSeverity {
  return severityFor(cpu, 50, 150);
}

function agentLabel(a: PerfAgentRow): string {
  if (a.title) return a.title;
  if (a.kind === 'spare') return a.sessionId ? `bg agent ${a.sessionId.slice(0, 8)}` : `idle spare (pid ${a.pid})`;
  if (a.sessionId) return `session ${a.sessionId.slice(0, 8)}`;
  return `claude (pid ${a.pid})`;
}

// One agent: title line with its subtree CPU, then its top tool subprocesses
// (what it is doing right now) and its own in-process share.
function AgentRow({ a }: { a: PerfAgentRow }) {
  const sev = cpuSeverity(a.cpu);
  const untitled = !a.title;
  return (
    <div className="px-3 py-1 border-t border-border/40 first:border-t-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[11px] truncate min-w-0 ${untitled ? 'text-muted italic' : 'text-text'}`} title={`${agentLabel(a)} · pid ${a.pid}${a.sessionId ? ` · session ${a.sessionId}` : ''}`}>
          {a.peer && <span className="text-subtle not-italic">{a.peer} · </span>}
          {agentLabel(a)}
        </span>
        <span className="text-[11px] font-mono shrink-0" style={{ color: SEV_COLOR[sev] }}>
          {a.cpu}%<span className="text-subtle ml-1.5">{fmtMB(a.rssMB)}</span>
          {typeof a.threads === 'number' && <span className="text-subtle ml-1.5" title={`${a.threads} threads across ${a.procs + 1} processes`}>{a.threads} thr</span>}
        </span>
      </div>
      <div className="mt-0.5 h-1 rounded-full overflow-hidden flex" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
        {/* Stacked by category, scaled so 100% of a core fills the bar. */}
        {[{ category: 'claude' as PerfToolCategory, cpu: a.selfCpu }, ...a.tools].map((t, i) => (
          <div key={i} style={{ width: `${Math.min(100, t.cpu)}%`, backgroundColor: CATEGORY_COLOR[t.category] }} />
        ))}
      </div>
      {(a.tools.length > 0 || a.selfCpu >= 0.5) && (
        <div className="mt-0.5 pl-2">
          {a.tools.map((t, i) => (
            <div key={i} className="flex items-baseline justify-between gap-2 text-[10px] font-mono">
              <span className="truncate min-w-0">
                <span style={{ color: CATEGORY_COLOR[t.category] }}>{t.name}</span>
                {t.count > 1 && <span className="text-subtle"> ×{t.count}</span>}
                {t.cmd && <span className="text-muted"> {t.cmd}</span>}
              </span>
              <span className="shrink-0 text-muted">{t.cpu}%</span>
            </div>
          ))}
          {a.selfCpu >= 0.5 && (
            <div className="flex items-baseline justify-between gap-2 text-[10px] font-mono">
              <span className="truncate min-w-0" title="The agent process itself: Read/Write/Edit, transcript, model I/O — file work happens in-process, not in a child.">
                <span style={{ color: CATEGORY_COLOR.claude }}>claude itself</span>
                <span className="text-subtle"> reads · writes · model I/O</span>
              </span>
              <span className="shrink-0 text-muted">{a.selfCpu}%</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function agentSeriesLabel(pid: number, names: PerfHistory['agentNames']): string {
  const n = names[String(pid)];
  if (!n) return `claude (pid ${pid})`;
  if (n.title) return n.peer ? `${n.peer} · ${n.title}` : n.title;
  return n.kind === 'spare' ? `bg agent (pid ${pid})` : `session (pid ${pid})`;
}

// An action is a command as the agent ran it (name + short args), regardless
// of which agent ran it — the same grep from three agents is one thing.
function actionKey(a: PerfActionRow): string {
  return `${a.name}|${a.cmd}`;
}
function actionLabel(a: PerfActionRow): string {
  return a.cmd ? `${a.name} ${a.cmd}` : a.name;
}

/**
 * Change over time: machine, app, event loop, and what the agents were doing.
 * Every chart shares the one time range chosen in the header; each has one
 * axis (two measures of different units are two charts, never a dual axis).
 */
function PerfTimeline({ history, rangeMin, cores, verdict }: { history: PerfHistory | null; rangeMin: number; cores: number; verdict: ReturnType<typeof perfVerdict> | null }) {
  const points = useMemo(() => {
    if (!history) return [];
    const since = Date.now() - rangeMin * 60_000;
    return history.points.filter((p) => p.t >= since);
  }, [history, rangeMin]);
  const names = history?.agentNames ?? {};
  const times = points.map((p) => p.t);

  const machine: Series[] = [
    { key: 'cpu', label: 'CPU busy', color: PALETTE[0], values: points.map((p) => p.cpuBusyPct) },
    { key: 'mem', label: 'Memory used', color: PALETTE[1], values: points.map((p) => p.memUsedPct) },
  ];
  // Load = runnable threads, smoothed; the thread census adds the instantaneous
  // on-CPU count next to it, both against the core count.
  const load: Series[] = [
    { key: 'load', label: 'Load (1 min)', color: PALETTE[1], values: points.map((p) => p.load1) },
    ...(points.some((p) => p.threads) ? [{ key: 'running', label: 'Threads on CPU (sample)', color: PALETTE[0], values: points.map((p) => (p.threads ? p.threads.running : null)) }] : []),
  ];
  // Thread population: everything alive vs what the agents' subtrees hold.
  const threads: Series[] = points.some((p) => p.threads)
    ? [
      { key: 'total', label: 'All threads', color: PALETTE[6], values: points.map((p) => (p.threads ? p.threads.total : null)) },
      { key: 'agents', label: 'Under agents', color: PALETTE[4], values: points.map((p) => (p.threads ? p.threads.underAgents : null)) },
    ]
    : [];
  const appCpu: Series[] = [
    { key: 'main', label: 'Main process', color: PALETTE[0], values: points.map((p) => p.mainCpuPct) },
    { key: 'renderer', label: 'Renderer + helpers', color: PALETTE[1], values: points.map((p) => p.rendererCpuPct) },
  ];
  const lag: Series[] = [{ key: 'lag', label: 'Event-loop lag (max)', color: PALETTE[6], values: points.map((p) => p.lagMaxMs) }];

  // Agents by activity: stacked areas in the fixed category order/colours.
  const activity: Series[] = CATEGORY_ORDER
    .filter((c) => points.some((p) => (p.byCategory?.[c] ?? 0) > 0))
    .map((c) => ({ key: c, label: CATEGORY_LABEL[c], color: CATEGORY_COLOR[c], values: points.map((p) => (p.byCategory ? p.byCategory[c] ?? 0 : null)) }));

  // By action: the concrete commands behind the categories. The hottest
  // (name + args) keys across the range get palette slots, the rest fold into
  // "other actions". The same command run by several agents is one series.
  const actions: Series[] = useMemo(() => {
    const peak = new Map<string, { label: string; cpu: number }>();
    for (const p of points) {
      for (const a of p.topActions ?? []) {
        const key = actionKey(a);
        const prev = peak.get(key);
        if (!prev || a.cpu > prev.cpu) peak.set(key, { label: actionLabel(a), cpu: a.cpu });
      }
    }
    const ranked = Array.from(peak.entries()).sort((a, b) => b[1].cpu - a[1].cpu).map(([k]) => k);
    const top = ranked.slice(0, 7).sort();
    const topSet = new Set(top);
    const sumAt = (p: PerfHistoryPoint, pick: (k: string) => boolean): number | null =>
      p.topActions ? p.topActions.filter((a) => pick(actionKey(a))).reduce((s, a) => s + a.cpu, 0) : null;
    const out: Series[] = top.map((key, i) => ({
      key,
      label: peak.get(key)!.label,
      color: PALETTE[i],
      values: points.map((p) => sumAt(p, (k) => k === key)),
    }));
    if (ranked.length > top.length) {
      out.push({ key: '__other', label: `other actions (${ranked.length - top.length})`, color: OTHER_COLOR, values: points.map((p) => sumAt(p, (k) => !topSet.has(k))) });
    }
    return out;
  }, [points]);

  // Tooltip drill-down for the category chart: the commands (and whose agent)
  // behind the hovered sample, so a spike names its cause.
  const actionsAt = (i: number) => {
    const rows = points[i]?.topActions;
    if (!rows || rows.length === 0) return null;
    return (
      <div className="mt-1 pt-1 border-t border-border/60">
        <div className="text-subtle mb-0.5">what was running</div>
        {rows.slice(0, 6).map((a, j) => (
          <div key={j} className="flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: CATEGORY_COLOR[a.category] ?? OTHER_COLOR }} aria-hidden="true" />
            <span className="text-text w-12 text-right shrink-0">{Math.round(a.cpu)}%</span>
            <span className="text-text truncate max-w-[260px]">{actionLabel(a)}</span>
            {typeof a.threads === 'number' && a.threads > 0 && <span className="text-subtle shrink-0">{a.threads} thr</span>}
            <span className="text-subtle truncate max-w-[160px]">· {agentSeriesLabel(a.pid, names)}</span>
          </div>
        ))}
      </div>
    );
  };

  // Per agent: the busiest pids across the range get palette slots — assigned
  // in pid order so an agent keeps its colour as others come and go — and the
  // rest fold into "other agents".
  const perAgent: Series[] = useMemo(() => {
    const peak = new Map<number, number>();
    for (const p of points) for (const a of p.agents ?? []) peak.set(a.pid, Math.max(peak.get(a.pid) ?? 0, a.cpu));
    const ranked = Array.from(peak.entries()).sort((a, b) => b[1] - a[1]).map(([pid]) => pid);
    const top = ranked.slice(0, 7).sort((a, b) => a - b);
    const topSet = new Set(top);
    const out: Series[] = top.map((pid, i) => ({
      key: String(pid),
      label: agentSeriesLabel(pid, names),
      color: PALETTE[i],
      values: points.map((p) => (p.agents ? p.agents.find((a) => a.pid === pid)?.cpu ?? 0 : null)),
    }));
    if (ranked.length > top.length) {
      out.push({
        key: 'other',
        label: `other agents (${ranked.length - top.length})`,
        color: OTHER_COLOR,
        values: points.map((p) => (p.agents ? p.agents.filter((a) => !topSet.has(a.pid)).reduce((s, a) => s + a.cpu, 0) : null)),
      });
    }
    return out;
  }, [points, names]);

  // Top machine-wide commands, same treatment (slots by name for stability).
  const procs: Series[] = useMemo(() => {
    const peak = new Map<string, number>();
    for (const p of points) for (const r of p.topProcs ?? []) peak.set(r.name, Math.max(peak.get(r.name) ?? 0, r.cpu));
    const ranked = Array.from(peak.entries()).sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const top = ranked.slice(0, 7).sort();
    return top.map((name, i) => ({
      key: name,
      label: name,
      color: PALETTE[i],
      values: points.map((p) => (p.topProcs ? p.topProcs.find((r) => r.name === name)?.cpu ?? 0 : null)),
    }));
  }, [points]);

  if (!history) {
    return <div className="px-4 py-6 text-sm text-muted italic">Loading history…</div>;
  }
  if (points.length < 2) {
    return (
      <div className="px-4 py-6 text-sm text-muted italic">
        Collecting samples — the first points arrive within ~10 s of launch. {history.points.length > 0 ? `${history.points.length} older point(s) fall outside the ${rangeMin} min range.` : ''}
      </div>
    );
  }

  const pct = (v: number) => (v >= 100 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString());
  const cell = 'rounded-lg border border-border/60 bg-bg/40 p-2';

  return (
    <div className="flex flex-col gap-2 px-3 pt-2 pb-1">
      {verdict && (
        <div className="text-[11px] leading-snug" style={{ color: SEV_COLOR[verdict.severity] }}>{verdict.reason}</div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div className={cell}><LineChart title="Machine · CPU & memory" unit="%" times={times} series={machine} yMax={100} format={pct} /></div>
        <div className={cell}><LineChart title="Machine · load & threads on CPU" unit="" times={times} series={load} reference={{ value: cores, label: `${cores} cores` }} format={pct} /></div>
        {threads.length > 0 && (
          <div className={`${cell} md:col-span-2`}>
            <LineChart title="Machine · threads alive (all vs under agents)" unit="" times={times} series={threads} height={110} format={(v) => Math.round(v).toLocaleString()} />
          </div>
        )}
        <div className={cell}><LineChart title="This app · CPU" unit="%" times={times} series={appCpu} format={pct} /></div>
        <div className={cell}><LineChart title="This app · event-loop lag" unit="" times={times} series={lag} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`)} /></div>
        <div className={cell}>
          {activity.length > 0
            ? <LineChart title="Agents · CPU by activity (stacked)" unit="%" times={times} series={activity} stacked height={150} format={pct} detail={actionsAt} />
            : <div className="text-[11px] text-muted italic px-1 py-6">No agent census in this range yet.</div>}
        </div>
        <div className={cell}>
          {perAgent.length > 0
            ? <LineChart title="Agents · CPU per agent" unit="%" times={times} series={perAgent} height={150} format={pct} detail={actionsAt} />
            : <div className="text-[11px] text-muted italic px-1 py-6">No agent census in this range yet.</div>}
        </div>
        <div className={`${cell} md:col-span-2`}>
          {actions.length > 0
            ? <LineChart title="Agents · CPU by action — the commands behind the spikes (stacked)" unit="%" times={times} series={actions} stacked height={170} format={pct} detail={actionsAt} />
            : <div className="text-[11px] text-muted italic px-1 py-6">No agent actions recorded in this range yet (needs a main-process restart after this update).</div>}
        </div>
        <div className={`${cell} md:col-span-2`}>
          {procs.length > 0
            ? <LineChart title="Machine · top processes by command" unit="%" times={times} series={procs} height={150} format={pct} />
            : <div className="text-[11px] text-muted italic px-1 py-6">No process census in this range yet.</div>}
        </div>
      </div>
      <div className="flex items-center justify-between text-[10px] text-subtle pt-1">
        <span>{points.length} samples · every {Math.round((history.intervalMs || 5000) / 1000)} s · hover for values</span>
        <span>History resets when the app restarts.</span>
      </div>
    </div>
  );
}

function PerfBody({ snap, uiFrameGapMs, onOpenLog, loading, layout }: { snap: PerfSnapshot; uiFrameGapMs: number; onOpenLog: () => void; loading: boolean; layout: 'sidebar' | 'wide' }) {
  const verdict = perfVerdict(snap);
  const { system, app, loop, resources, processes, ops } = snap;
  const loadRatio = system.cores > 0 ? system.load1 / system.cores : 0;
  const cpuPct = system.cpuBusyPct ?? Math.min(100, Math.round(loadRatio * 100));
  const cpuSev = severityFor(cpuPct, CPU_WARN, CPU_DANGER);
  const memSev = memorySeverity(system);
  const lagSev = severityFor(loop.lagMaxMs, LAG_WARN_MS, LAG_DANGER_MS);
  const uiSev = severityFor(uiFrameGapMs, LAG_WARN_MS, LAG_DANGER_MS);
  const num = (k: string): number | null => (typeof resources[k] === 'number' ? (resources[k] as number) : null);
  const ptys = ['attachPtys', 'resumePtys', 'shellPtys', 'nudgePtys', 'systemPtys'].reduce((s, k) => s + (num(k) ?? 0), 0);

  const machine = (
    <>
      <SectionLabel>Machine</SectionLabel>
      <MeterRow
        label="CPU"
        pct={cpuPct}
        severity={cpuSev}
        right={`${cpuPct}% · load ${system.load1} / ${system.cores} cores`}
      />
      {/* Until the first vm_stat census lands, the only number available is
          total − free, which on macOS counts file cache as used and reads ~99%
          on a healthy box. Say "measuring" rather than show that. */}
      <MeterRow
        label="Memory"
        pct={snap.censusAt ? system.memUsedPct : 0}
        severity={snap.censusAt ? memSev : 'normal'}
        right={snap.censusAt
          ? `${system.memUsedPct}% · ${fmtMB(system.memUsedMB)} / ${fmtMB(system.memTotalMB)}${system.swapUsedMB > 0 ? ` · swap ${fmtMB(system.swapUsedMB)}` : ''}${system.memPressure && system.memPressure !== 'normal' ? ` · pressure ${system.memPressure}` : ''}`
          : 'measuring…'}
      />
      {/* Threads: how many exist, how many are on a CPU right now (vs cores),
          and how many belong to agent subtrees. Absent from an older main. */}
      {system.threads && (
        <Row
          label="Threads"
          value={`${system.threads.running} on CPU / ${system.cores} cores`}
          severity={severityFor(system.threads.running, system.cores, system.cores * 2)}
          sub={`${system.threads.total.toLocaleString()} total · ${system.threads.underAgents.toLocaleString()} under agents`}
        />
      )}
    </>
  );

  const thisApp = (
    <>
      <SectionLabel>This app</SectionLabel>
      <Row label="Main process" value={`${app.mainCpuPct}% CPU`} sub={`${fmtMB(app.mainRssMB)} · heap ${fmtMB(app.heapMB)}`} />
      <Row label="Renderer + helpers" value={`${app.rendererCpuPct}% CPU`} sub={`${fmtMB(app.rendererRssMB)} · GPU ${app.gpuCpuPct}%`} />
      <Row label="Event-loop lag (1 min max)" value={fmtMs(loop.lagMaxMs)} severity={lagSev} sub={`now ${fmtMs(loop.lagNowMs)} · avg ${fmtMs(loop.lagAvgMs)}`} />
      <Row label="UI frame gap (max)" value={fmtMs(uiFrameGapMs)} severity={uiSev} />
      <Row
        label="Stalls since launch"
        value={String(loop.stalls)}
        severity={loop.stalls > 0 && loop.lastStallAt && Date.now() - new Date(loop.lastStallAt).getTime() < 10 * 60_000 ? 'warning' : undefined}
        sub={loop.lastStallAt ? `last ${ago(loop.lastStallAt)} (${fmtMs(loop.lastStallMs)})` : undefined}
      />
      <Row
        label="PTYs · watchers · convs"
        value={`${ptys} · ${num('convWatchers') ?? '–'} · ${num('convs') ?? '–'}`}
        sub={resources.bridgeOk === false ? 'bridge down' : undefined}
        severity={resources.bridgeOk === false ? 'danger' : undefined}
      />
    </>
  );

  const agents = (
    <>
      <SectionLabel>
        Agents{snap.agents ? ` · ${snap.agents.rows.length} · ${Math.round(snap.agents.totalCpu)}% CPU` : ''}
      </SectionLabel>
      {!snap.agents ? (
        <div className="px-3 py-1 text-[11px] text-muted italic">
          {snap.censusAt ? 'Agent census unavailable (ps failed).' : 'Mapping agents… (ps itself is slow when the machine is saturated)'}
        </div>
      ) : snap.agents.rows.length === 0 ? (
        <div className="px-3 py-1 text-[11px] text-muted italic">No claude processes running.</div>
      ) : (
        <>
          {/* What the agents are doing, as a whole: CPU by tool category. */}
          <div className="px-3 pb-1">
            <div className="h-1.5 rounded-full overflow-hidden flex" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
              {CATEGORY_ORDER.filter((c) => (snap.agents!.byCategory[c] ?? 0) > 0).map((c) => (
                <div
                  key={c}
                  title={`${CATEGORY_LABEL[c]} ${snap.agents!.byCategory[c]}%`}
                  style={{ width: `${(100 * (snap.agents!.byCategory[c] ?? 0)) / Math.max(1, snap.agents!.totalCpu)}%`, backgroundColor: CATEGORY_COLOR[c] }}
                />
              ))}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] font-mono">
              {CATEGORY_ORDER.filter((c) => (snap.agents!.byCategory[c] ?? 0) >= 0.5).map((c) => (
                <span key={c} className="flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: CATEGORY_COLOR[c] }} aria-hidden="true" />
                  <span className="text-muted">{CATEGORY_LABEL[c]}</span>
                  <span className="text-text">{Math.round(snap.agents!.byCategory[c] ?? 0)}%</span>
                </span>
              ))}
            </div>
          </div>
          {/* The commands burning CPU right now, across every agent — the
              flat answer before scanning agent by agent. Field-level default:
              an older main process may still send summaries without it. */}
          {(snap.agents.topActions ?? []).length > 0 && (
            <div className="px-3 pb-1">
              <div className="text-[10px] text-subtle mb-0.5">Hottest actions</div>
              {(snap.agents.topActions ?? []).slice(0, 6).map((t, i) => {
                const owner = snap.agents!.rows.find((r) => r.pid === t.pid);
                const sev = severityFor(t.cpu, 100, 200);
                return (
                  <div key={i} className="flex items-baseline gap-1.5 text-[10px] font-mono">
                    <span className="shrink-0 w-10 text-right" style={{ color: SEV_COLOR[sev] }}>{Math.round(t.cpu)}%</span>
                    <span className="truncate min-w-0" title={`${actionLabel(t)} · ${owner ? agentLabel(owner) : `pid ${t.pid}`}`}>
                      <span style={{ color: CATEGORY_COLOR[t.category] ?? OTHER_COLOR }}>{t.name}</span>
                      {t.count > 1 && <span className="text-subtle"> ×{t.count}</span>}
                      {t.cmd && <span className="text-text"> {t.cmd}</span>}
                      {typeof t.threads === 'number' && t.threads > 0 && <span className="text-subtle"> · {t.threads} thr</span>}
                      <span className="text-subtle"> · {owner ? `${owner.peer ? `${owner.peer} · ` : ''}${agentLabel(owner)}` : `pid ${t.pid}`}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex flex-col">
            {snap.agents.rows.map((a) => <AgentRow key={a.pid} a={a} />)}
          </div>
        </>
      )}
    </>
  );

  const procs = (
    <>
      <SectionLabel>Processes{processes ? ` · ${processes.total} total` : ''}</SectionLabel>
      {processes ? (
        <>
          <Row label="claude" value={String(processes.claude)} sub={fmtMB(processes.claudeRssMB)} />
          <Row label="node · vitest · chrome" value={`${processes.node} · ${processes.vitest} · ${processes.chrome}`} />
          {processes.topCpu.length > 0 && (
            <div className="px-3 pt-1">
              <div className="text-[10px] text-subtle mb-0.5">Top CPU by command</div>
              {processes.topCpu.map((r) => {
                const sev = severityFor(r.cpu, 100, 200);
                const isDocker = r.name === 'Docker VM';
                // Field-level defaults: the renderer hot-reloads ahead of the
                // main process, so an older main may still send rows without
                // the origin/ownership fields.
                const allGroups = r.groups ?? [];
                const underAgents = r.underAgents ?? { count: 0, cpu: 0 };
                const docker = snap.docker ?? null;
                const groups = allGroups.filter((g) => !(allGroups.length === 1 && g.label === r.name));
                return (
                  <div key={r.name} className="py-px">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] text-text truncate">
                        {r.name}
                        {r.count > 1 && <span className="text-subtle ml-1">×{r.count}</span>}
                      </span>
                      <span className="text-[11px] font-mono shrink-0" style={{ color: SEV_COLOR[sev] }}>
                        {r.cpu}%<span className="text-subtle ml-1.5">{fmtMB(r.rssMB)}</span>
                      </span>
                    </div>
                    {/* Who runs them: origin groups (Chrome profile, node project,
                        containers) and how many sit under a running agent. */}
                    {(groups.length > 0 || underAgents.count > 0 || (isDocker && docker)) && (
                      <div className="pl-2 text-[10px] font-mono text-subtle truncate">
                        {isDocker && docker ? (
                          <span title={docker.top.map((c) => `${c.name} ${c.cpu}% ${fmtMB(c.memMB)}`).join('\n')}>
                            {docker.containers} containers · {docker.top.slice(0, 3).map((c, i) => (
                              <span key={c.name}>{i > 0 && ' · '}<span className="text-muted">{c.name}</span> {c.cpu}%</span>
                            ))}
                          </span>
                        ) : (
                          groups.map((g, i) => (
                            <span key={g.label}>{i > 0 && ' · '}<span className="text-muted">{g.label}</span>{g.count > 1 ? ` ×${g.count}` : ''}{g.cpu > 0 ? ` ${g.cpu}%` : ''}</span>
                          ))
                        )}
                        {underAgents.count > 0 && (
                          <span style={{ color: CATEGORY_COLOR.claude }}> · {underAgents.count} under agents{underAgents.cpu > 0 ? ` ${underAgents.cpu}%` : ''}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div className="px-3 py-1 text-[11px] text-muted italic">
          {snap.censusAt ? 'Process census unavailable (ps failed).' : 'Counting processes… (ps itself is slow when the machine is saturated)'}
        </div>
      )}
    </>
  );

  const slowOps = (
    <>
      <SectionLabel>Slow main-thread ops{ops.windowSince ? ` · since ${clock(ops.windowSince)}` : ''}</SectionLabel>
      {ops.rows.length === 0 ? (
        <div className="px-3 py-1 text-[11px] text-muted italic">Nothing recorded in this window yet.</div>
      ) : (
        <div className="px-3">
          {ops.rows.map((r) => {
            const sev = severityFor(r.maxMs, 1000, 4000);
            return (
              <div key={r.label} className="flex items-baseline justify-between gap-2 py-px">
                <span className="text-[11px] font-mono text-text truncate">
                  {r.label}
                  {r.maxPeer && <span className="text-subtle ml-1">@{r.maxPeer}</span>}
                </span>
                <span className="text-[11px] font-mono shrink-0 text-right">
                  <span className="text-subtle">n={r.count} avg </span>
                  <span style={{ color: SEV_COLOR[severityFor(r.avgMs, 500, 2000)] }}>{fmtMs(r.avgMs)}</span>
                  <span className="text-subtle"> max </span>
                  <span style={{ color: SEV_COLOR[sev] }}>{fmtMs(r.maxMs)}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {ops.recentSlow.length > 0 && (
        <div className="px-3 pt-1.5">
          <div className="text-[10px] text-subtle mb-0.5">Most recent slow ops</div>
          {ops.recentSlow.map((o, i) => (
            <div key={`${o.at}-${i}`} className="flex items-baseline justify-between gap-2 py-px text-[11px] font-mono">
              <span className="text-muted truncate">
                <span className="text-subtle">{clock(o.at)}</span> {o.label}
                {o.peer && <span className="text-subtle"> @{o.peer}</span>}
              </span>
              <span className="shrink-0" style={{ color: SEV_COLOR[severityFor(o.ms, 1000, 4000)] }}>{fmtMs(o.ms)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );

  const footer = (
    <div className="px-3 pt-2 pb-1 flex items-center justify-between text-[10px] text-subtle">
      <span>Sampled {ago(snap.at)}{loading ? ' · refreshing…' : ''}</span>
      {snap.logPath && (
        <button onClick={onOpenLog} className="text-muted hover:text-text underline-offset-2 hover:underline" title={snap.logPath}>
          Open main.log
        </button>
      )}
    </div>
  );

  // The one-line verdict first: what is wrong, in words.
  const verdictLine = (
    <div className="px-3 pt-2 pb-1 text-[11px] leading-snug" style={{ color: SEV_COLOR[verdict.severity] }}>
      {verdict.reason}
    </div>
  );

  if (layout === 'wide') {
    return (
      <div className="flex flex-col">
        {verdictLine}
        {/* Three columns at desktop width: machine + app | agents | processes + ops.
            Column dividers keep each group's label/value pairs reading as a unit. */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-2 px-1">
          <div className="min-w-0 md:border-r md:border-border/40">{machine}{thisApp}</div>
          <div className="min-w-0 xl:border-r xl:border-border/40">{agents}</div>
          <div className="min-w-0">{procs}{slowOps}</div>
        </div>
        {footer}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {verdictLine}
      {machine}
      {thisApp}
      {agents}
      {procs}
      {slowOps}
      {footer}
    </div>
  );
}
