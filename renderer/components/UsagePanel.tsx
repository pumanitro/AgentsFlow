import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import { worstMeter } from '../../shared/usage';
import { useAccountsSnapshot } from '../lib/use-accounts';
import ProviderIcon, { providerName } from './ProviderIcon';
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

/**
 * The usage of the licence you are actually spending.
 *
 * It used to stack Claude and Codex one above the other, which asked the reader
 * to work out which half applied to the work they were about to start. The
 * panel now follows the selected provider: one set of meters, named and marked,
 * and switching provider switches what this shows.
 */
export default function UsagePanel() {
  const [open, setOpen] = usePersistedBool('agentsflow:usage:open', true);
  const { snapshot } = useAccountsSnapshot();
  const provider = snapshot.activeProvider;
  const name = providerName(provider);
  const [result, setResult] = useState<UsageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async (force: boolean) => {
    setLoading(true);
    let next: UsageResult;
    try {
      next = provider === 'codex' ? (await api().getCodexAccount(force)).usage : await api().getUsage(force);
    } catch {
      next = { ok: false, reason: 'unknown', error: `Could not read ${providerName(provider)} usage.` };
    }
    if (!mounted.current) return;
    setResult(next);
    setLoading(false);
  }, [provider]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Keyed on the provider: switching clears the old numbers rather than leaving
  // the other licence's meters on screen under the new name.
  useEffect(() => {
    setResult(null);
    void load(false);
    const timer = setInterval(() => load(false), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // An account switch changes the numbers immediately, so don't wait out the
  // minute timer.
  useEffect(() => {
    const off = api().onAccountsUpdated?.(() => { void load(true); });
    return () => off?.();
  }, [load]);

  const badge = worstMeter(result);

  return (
    <div className="shrink-0 rounded-lg border border-border bg-panel overflow-hidden flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-2 py-2 bg-panel2/60 hover:bg-panel2">
        <span className="w-1 h-4 rounded-full bg-info shrink-0" aria-hidden="true" />
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left" title={open ? 'Hide usage' : `Show ${name} plan usage limits`}>
          <span className="text-muted text-[10px] w-3 shrink-0">{open ? '▼' : '▶'}</span>
          <span className="text-[11px] uppercase tracking-wider text-text font-semibold">Usage</span>
          <span className="flex items-center gap-1 min-w-0 text-muted">
            <ProviderIcon provider={provider} size={12} />
            <span className="text-[11px] text-text truncate">{name}</span>
          </span>
          {badge && (
            <span className="ml-auto text-[10px] font-mono shrink-0" style={{ color: SEVERITY_COLOR[badge.severity] }}>
              {badge.percent}%
            </span>
          )}
        </button>
        <button onClick={() => void load(true)} disabled={loading} className={`shrink-0 text-muted hover:text-text px-1.5 py-0.5 rounded disabled:opacity-40 ${loading ? 'animate-spin' : ''}`} title={`Refresh ${name} usage now`} aria-label="Refresh usage">↻</button>
      </div>
      {open && <div className="flex-1 min-h-0 overflow-y-auto border-t border-border/60 py-1" style={{ maxHeight: 'min(300px, 30vh)' }}>
        <div data-testid={`usage-${provider}`} className="pb-1">
          <div className="px-3 pt-2 pb-1 flex items-center gap-2 text-[11px]">
            <ProviderIcon provider={provider} size={12} className="text-muted" />
            <strong className="text-text">{name}</strong>
            <span className="text-muted truncate">{result?.ok ? result.snapshot.plan : ''}</span>
          </div>
          {!result ? <div className="px-3 py-2 text-[11px] text-muted">Loading usage…</div>
            : !result.ok ? <div className="px-3 py-2 text-[11px] text-muted">{result.error || `Sign in to ${name} to see usage.`}</div>
            : <>
              {result.snapshot.meters.length ? result.snapshot.meters.map(meter => <MeterRow key={meter.key} meter={meter} />)
                : <div className="px-3 py-2 text-[11px] text-muted">No usage limits reported.</div>}
              <div className="px-3 py-1 text-[10px] text-subtle">Updated {fetchedAgo(result.snapshot.fetchedAt)}</div>
            </>}
        </div>
      </div>}
    </div>
  );
}
