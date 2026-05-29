import { useMemo, useState } from 'react';
import { Conversation, TrackedDirectory } from '../../shared/types';

interface Props {
  dirs: TrackedDirectory[];
  convs: Conversation[];
}

type PeriodKey = '7' | '30' | '90' | 'all';

const PERIODS: { key: PeriodKey; label: string; days: number | null }[] = [
  { key: '7', label: '7 days', days: 7 },
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: '90 days', days: 90 },
  { key: 'all', label: 'All time', days: null },
];

const DAY_MS = 86_400_000;

/** A conversation is "done" once it has been unpinned — that's AgentsFlow's completion signal. */
function isDone(c: Conversation): boolean {
  return !c.pinned;
}

function tsOf(iso: string | undefined): number {
  if (!iso) return NaN;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = ms / 60_000;
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)}d`;
}

function formatRelative(iso: string | undefined, now: number): string {
  const t = tsOf(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = now - t;
  if (diff < 60_000) return 'just now';
  if (diff < DAY_MS) return `${Math.round(diff / 3_600_000)}h ago`;
  const days = Math.round(diff / DAY_MS);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

interface DirStat {
  id: string;
  name: string;
  total: number;
  done: number;
  active: number;
  convs: Conversation[];
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-panel px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="text-2xl font-semibold text-text mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-subtle mt-0.5">{sub}</div>}
    </div>
  );
}

export default function StatsView({ dirs, convs }: Props) {
  const [period, setPeriod] = useState<PeriodKey>('30');
  // A fixed reference time captured per render — fine for a stats snapshot.
  const now = Date.now();

  // Conversations belong to a tracked directory iff their directoryId matches it —
  // the same binding the directory cards and the History modal use. Orphaned
  // conversations (directoryId pointing at a removed/re-added dir) are excluded
  // so the stats match the per-directory history previews exactly.
  const trackedIds = useMemo(() => new Set(dirs.map((d) => d.id)), [dirs]);

  const inPeriod = useMemo(() => {
    const days = PERIODS.find((p) => p.key === period)?.days ?? null;
    if (days === null) return convs;
    const cutoff = now - days * DAY_MS;
    return convs.filter((c) => {
      const t = tsOf(c.createdAt);
      return Number.isFinite(t) && t >= cutoff;
    });
  }, [convs, period, now]);

  const overview = useMemo(() => {
    const tracked = inPeriod.filter((c) => trackedIds.has(c.directoryId));
    const total = tracked.length;
    const done = tracked.filter(isDone).length;
    const active = total - done;
    const durations = tracked
      .filter(isDone)
      .map((c) => tsOf(c.unpinnedAt) - tsOf(c.createdAt))
      .filter((d) => Number.isFinite(d) && d >= 0);
    const avgMs = durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : NaN;
    return { total, done, active, avgMs, measured: durations.length };
  }, [inPeriod, trackedIds]);

  const dirStats = useMemo<DirStat[]>(() => {
    return dirs
      .map((d) => {
        const list = inPeriod.filter((c) => c.directoryId === d.id);
        const done = list.filter(isDone).length;
        return {
          id: d.id,
          name: d.displayName || d.path,
          total: list.length,
          done,
          active: list.length - done,
          convs: [...list].sort((a, b) => tsOf(b.createdAt) - tsOf(a.createdAt)),
        };
      })
      .filter((s) => s.total > 0)
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }, [dirs, inPeriod]);

  const maxTotal = Math.max(1, ...dirStats.map((d) => d.total));

  return (
    <div className="px-4 pt-4 pb-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text">Statistics</h2>
          <p className="text-[11px] text-muted">Conversations per directory and activity.</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-panel p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`text-[11px] px-2.5 py-1 rounded-md transition-colors ${
                period === p.key
                  ? 'bg-accent text-bg font-semibold'
                  : 'text-muted hover:text-text hover:bg-panel2'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Overview cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Card label="Conversations" value={String(overview.total)} sub={`across ${dirStats.length} director${dirStats.length === 1 ? 'y' : 'ies'}`} />
        <Card label="Done" value={String(overview.done)} sub="unpinned" />
        <Card label="In progress" value={String(overview.active)} sub="still pinned" />
        <Card
          label="Avg time to done"
          value={formatDuration(overview.avgMs)}
          sub={overview.measured > 0 ? `from ${overview.measured} measured` : 'no data yet'}
        />
      </div>

      {dirStats.length === 0 ? (
        <div className="rounded-lg border border-border bg-panel/50 px-4 py-10 text-center text-sm text-muted">
          No conversations in this period.
        </div>
      ) : (
        <>
          {/* Busiest directories */}
          <section className="mb-6">
            <h3 className="text-[11px] uppercase tracking-wider text-muted mb-2">Most active directories</h3>
            <div className="rounded-lg border border-border bg-panel/50 divide-y divide-border">
              {dirStats.map((d) => (
                <div key={d.id} className="px-4 py-2.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-text truncate">{d.name}</div>
                    <div className="mt-1 h-1.5 rounded-full bg-panel2 overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full"
                        style={{ width: `${(d.total / maxTotal) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div className="text-right tabular-nums">
                    <div className="text-sm font-semibold text-text">{d.total}</div>
                    <div className="text-[11px] text-subtle">{d.done} done</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Per directory → per agent breakdown */}
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-muted mb-2">Conversations by directory</h3>
            <div className="space-y-3">
              {dirStats.map((d) => (
                <div key={d.id} className="rounded-lg border border-border bg-panel/50 overflow-hidden">
                  <div className="px-4 py-2 flex items-center justify-between border-b border-border bg-panel">
                    <span className="text-sm font-medium text-text truncate">{d.name}</span>
                    <span className="text-[11px] text-subtle tabular-nums shrink-0 ml-3">
                      {d.total} total · {d.done} done · {d.active} active
                    </span>
                  </div>
                  <ul className="divide-y divide-border/60">
                    {d.convs.map((c) => {
                      const done = isDone(c);
                      return (
                        <li key={c.id} className="px-4 py-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                          <div className="min-w-0">
                            <div className="text-sm text-text/90 truncate">{c.title || c.description || c.lastPrompt || 'Untitled'}</div>
                            <div className="text-[11px] text-subtle">created {formatRelative(c.createdAt, now)}</div>
                          </div>
                          <div className="text-right shrink-0">
                            {done ? (
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-ok">
                                Done{c.unpinnedAt ? ` · ${formatRelative(c.unpinnedAt, now)}` : ''}
                              </span>
                            ) : (
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-accent">
                                {c.state || 'Active'}
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
