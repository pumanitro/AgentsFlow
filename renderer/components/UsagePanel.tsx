import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import type { UsageMeter, UsageResult } from '../../shared/types';

// A persisted boolean keyed in localStorage. Starts at `fallback` to avoid an
// SSR/first-paint flash, then hydrates on mount. (Mirrors NotesPanel's helper.)
function usePersistedBool(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [value, setRaw] = useState(fallback);
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) setRaw(raw === '1');
    } catch { /* ignore */ }
  }, [key]);
  const set = useCallback((v: boolean) => {
    setRaw(v);
    try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore */ }
  }, [key]);
  return [value, set];
}

const REFRESH_MS = 60_000;

const SEVERITY_COLOR: Record<UsageMeter['severity'], string> = {
  normal: '#3b82f6', // info blue
  warning: '#fbbf24', // amber
  danger: '#ef4444', // red
};

// "Resets in 4 min" when the window is close; otherwise an absolute weekday +
// time like "Resets Wed 10:00 PM", matching Claude's own Usage screen.
function formatReset(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const ms = t - Date.now();
  if (ms <= 0) return 'Resetting…';
  const mins = Math.round(ms / 60_000);
  if (mins < 90) {
    if (mins < 60) return `Resets in ${Math.max(1, mins)} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `Resets in ${h}h ${m}m` : `Resets in ${h}h`;
  }
  const d = new Date(t);
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `Resets ${weekday} ${time}`;
}

function fetchedAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

// One meter row: label + percent, a severity-coloured bar, and the reset line.
// Inactive weekly windows are dimmed slightly so the binding limit stands out.
function MeterRow({ meter }: { meter: UsageMeter }) {
  const color = SEVERITY_COLOR[meter.severity];
  const dim = meter.group === 'weekly' && !meter.isActive;
  return (
    <div className={`px-3 py-1.5 ${dim ? 'opacity-70' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-text truncate">{meter.label}</span>
        <span className="text-[11px] font-mono shrink-0" style={{ color }}>{meter.percent}%</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${meter.percent}%`,
            // A gentle left→right fade on the filled portion.
            background: `linear-gradient(90deg, ${color} 0%, ${color}cc 100%)`,
          }}
        />
      </div>
      {meter.resetsAt && (
        <div className="mt-0.5 text-[10px] text-muted">{formatReset(meter.resetsAt)}</div>
      )}
    </div>
  );
}

export default function UsagePanel() {
  const [open, setOpen] = usePersistedBool('agentsflow:usage:open', true);
  const [result, setResult] = useState<UsageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async (force: boolean) => {
    const a = api();
    if (typeof a.getUsage !== 'function') return;
    setLoading(true);
    try {
      const r = await a.getUsage(force);
      if (mounted.current) setResult(r);
    } catch {
      if (mounted.current) {
        setResult({ ok: false, reason: 'unknown', error: 'Could not reach the usage service.' });
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  // Poll on a light cadence. We keep polling even while collapsed so the header
  // badge stays fresh, but only once the panel has mounted.
  useEffect(() => {
    mounted.current = true;
    load(false);
    const t = setInterval(() => load(false), REFRESH_MS);
    return () => { mounted.current = false; clearInterval(t); };
  }, [load]);

  const unavailable = typeof api().getUsage !== 'function';
  const snapshot = result?.ok ? result.snapshot : null;
  const meters = snapshot?.meters ?? [];
  const sessionMeters = meters.filter((m) => m.group === 'session');
  const weeklyMeters = meters.filter((m) => m.group === 'weekly');

  // Header badge: the binding weekly limit's percent, else the highest of all.
  const badge = (() => {
    if (!snapshot || meters.length === 0) return null;
    const active = meters.find((m) => m.isActive) ?? meters.reduce((a, b) => (b.percent > a.percent ? b : a));
    return active ? { percent: active.percent, color: SEVERITY_COLOR[active.severity] } : null;
  })();

  return (
    <div className="shrink-0 rounded-lg border border-border bg-panel overflow-hidden flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-2 py-2 bg-panel2/60 hover:bg-panel2">
        {/* Section identity: a blue accent tick marks this as the Usage zone. */}
        <span className="w-1 h-4 rounded-full bg-info shrink-0" aria-hidden="true" />
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          title={open ? 'Hide usage' : 'Show plan usage limits'}
        >
          <span className="text-muted text-[10px] w-3 shrink-0">{open ? '▼' : '▶'}</span>
          <span className="text-[11px] uppercase tracking-wider text-text font-semibold">Usage</span>
          {snapshot?.plan && (
            <span className="text-[10px] text-muted truncate">{snapshot.plan}</span>
          )}
          {badge && (
            <span className="ml-auto text-[10px] font-mono shrink-0" style={{ color: badge.color }}>{badge.percent}%</span>
          )}
        </button>
        <button
          onClick={() => load(true)}
          disabled={unavailable || loading}
          className={`shrink-0 text-muted hover:text-text px-1.5 py-0.5 rounded hover:bg-panel disabled:opacity-40 ${loading ? 'animate-spin' : ''}`}
          title="Refresh usage now"
          aria-label="Refresh usage"
        >↻</button>
      </div>

      {open && (
        <div className="flex-1 min-h-0 overflow-y-auto border-t border-border/60 py-1" style={{ maxHeight: 240 }}>
          {unavailable ? (
            <div className="px-3 py-3 text-xs text-muted italic">
              Restart the app to enable Usage (preload needs to refresh).
            </div>
          ) : !result ? (
            <div className="px-3 py-3 text-xs text-muted italic">Loading usage…</div>
          ) : !result.ok ? (
            <div className="px-3 py-3 text-xs text-muted">
              {result.reason === 'no-auth' && 'Sign in to Claude Code to see plan usage.'}
              {result.reason === 'expired' && 'Sign-in expired — open a Claude Code session to refresh, then hit ↻.'}
              {result.reason === 'network' && 'Offline — usage will update when the connection returns.'}
              {result.reason === 'unknown' && (result.error || 'Usage unavailable right now.')}
            </div>
          ) : meters.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted italic">No usage limits reported.</div>
          ) : (
            <div className="flex flex-col">
              {sessionMeters.map((m) => <MeterRow key={m.key} meter={m} />)}
              {weeklyMeters.length > 0 && (
                <>
                  {sessionMeters.length > 0 && <div className="mx-3 my-1 border-t border-border/50" />}
                  <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-subtle">Weekly limits</div>
                  {weeklyMeters.map((m) => <MeterRow key={m.key} meter={m} />)}
                </>
              )}
              <div className="px-3 pt-1.5 pb-0.5 flex items-center justify-between text-[10px] text-subtle">
                <span>Updated {fetchedAgo(snapshot!.fetchedAt)}</span>
                {loading && <span className="text-muted">refreshing…</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
