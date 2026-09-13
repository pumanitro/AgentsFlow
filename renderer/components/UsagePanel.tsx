import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import { worstMeter } from '../../shared/usage';
import { useAccountsSnapshot } from '../lib/use-accounts';
import ProviderIcon, { providerName } from './ProviderIcon';
import type { AgentProvider, UsageMeter, UsageResult } from '../../shared/types';

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

/**
 * A fold state that follows a computed default until the user decides for
 * themselves. `computed` is what the section should do when nobody has said
 * otherwise — here, "open only if this provider has saved accounts" — and it
 * keeps following that as the pool changes. The first toggle writes to
 * localStorage and from then on the stored choice wins.
 *
 * "Not stored" is deliberately distinct from "stored as closed", which is why
 * this cannot be `usePersistedBool(key, computed)`: that would freeze the
 * default at whatever the pool looked like on the first render. Nothing is read
 * during render, so SSR and first paint behave exactly as usePersistedBool does.
 * (Mirrors AccountsPanel.)
 */
function usePersistedFold(key: string, computed: boolean): [boolean, (v: boolean) => void] {
  const [stored, setStored] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) setStored(raw === '1');
    } catch { /* ignore */ }
  }, [key]);
  const set = useCallback((v: boolean) => {
    setStored(v);
    try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore */ }
  }, [key]);
  return [stored ?? computed, set];
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
 * One provider's meters, read on their own schedule.
 *
 * Each provider gets its own copy of this because the two are independent
 * licences with independent walls: Claude's come from the usage endpoint with
 * the pooled account's own token, Codex's from whatever sign-in the CLI is
 * currently holding. Nothing here is shared between them except the minute
 * timer's length — and every read is numbered, so a slow reply that lands after
 * a newer one (the ↻, or an account switch) is dropped rather than overwriting
 * fresher numbers with staler ones.
 */
function useProviderUsage(provider: AgentProvider) {
  const [result, setResult] = useState<UsageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  const seq = useRef(0);

  // Declared before the loading effects on purpose: effects run in source
  // order, so a remount (React strict mode unmounts and remounts) must flip
  // this back to true before anything that guards on it loads.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async (force: boolean) => {
    const mine = ++seq.current;
    setLoading(true);
    let next: UsageResult;
    try {
      next = provider === 'codex' ? (await api().getCodexAccount(force)).usage : await api().getUsage(force);
    } catch {
      next = { ok: false, reason: 'unknown', error: `Could not read ${providerName(provider)} usage.` };
    }
    if (!mounted.current || mine !== seq.current) return;
    setResult(next);
    setLoading(false);
  }, [provider]);

  useEffect(() => {
    void load(false);
    const timer = setInterval(() => load(false), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // An account switch changes the numbers immediately, so don't wait out the
  // minute timer. Both providers listen: one event can mean a Claude switch, a
  // Codex switch, or a sign-in being added to either pool.
  useEffect(() => {
    const off = api().onAccountsUpdated?.(() => { void load(true); });
    return () => off?.();
  }, [load]);

  return { result, loading, load };
}

/**
 * One provider's section inside the Usage pane: a banded header that is the
 * whole section when folded, and this provider's meters under it when not.
 *
 * Folded, the header still carries the two things worth a glance — the plan and
 * the percent of whichever window is closest to its wall — because that is the
 * number the pane exists to warn about; everything below is detail.
 */
function UsageSection({
  provider,
  open,
  onToggle,
  result,
  loading,
  onRefresh,
}: {
  provider: AgentProvider;
  open: boolean;
  onToggle: () => void;
  result: UsageResult | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const name = providerName(provider);
  const badge = worstMeter(result);
  // The plan rides in the header beside the provider name. It used to head the
  // body under a second copy of "⟨icon⟩ Claude", which spent a line of a narrow
  // sidebar repeating what the header had already said.
  const plan = result?.ok ? result.snapshot.plan : '';

  return (
    <div className="border-t border-border first:border-t-0">
      {/* A banded header over a full-strength divider: the two licences have to
          read as two zones at a glance rather than as one long list of meters.
          Same band, same paddings as the provider sections in the Accounts pane. */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-panel2/35 hover:bg-panel2/70">
        <button
          onClick={onToggle}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          title={open ? `Hide ${name} usage` : `Show ${name} plan usage limits`}
          aria-expanded={open}
        >
          <span className="text-muted text-[10px] w-3 shrink-0">{open ? '▼' : '▶'}</span>
          <ProviderIcon provider={provider} size={13} className="text-muted" />
          <span className="text-[11px] font-semibold text-text truncate">{name}</span>
          {plan && <span className="text-[10px] text-muted truncate">{plan}</span>}
          {badge && (
            <span className="ml-auto shrink-0 text-[10px] font-mono" style={{ color: SEVERITY_COLOR[badge.severity] }}>
              {badge.percent}%
            </span>
          )}
        </button>
        <button
          onClick={onRefresh}
          disabled={loading}
          className={`shrink-0 text-muted hover:text-text px-1.5 py-0.5 rounded disabled:opacity-40 ${loading ? 'animate-spin' : ''}`}
          title={`Refresh ${name} usage now`}
          aria-label={`Refresh ${name} usage`}
        >
          ↻
        </button>
      </div>
      {/* Folded means folded: the header line above is all that is left, so a
          provider you do not want to watch costs one row and no numbers. */}
      {open && (
        <div data-testid={`usage-${provider}`} className="border-t border-border/60 py-1">
          {!result ? <div className="px-3 py-2 text-[11px] text-muted">Loading usage…</div>
            : !result.ok ? <div className="px-3 py-2 text-[11px] text-muted">{result.error || `Sign in to ${name} to see usage.`}</div>
            : <>
              {result.snapshot.meters.length ? result.snapshot.meters.map(meter => <MeterRow key={meter.key} meter={meter} />)
                : <div className="px-3 py-2 text-[11px] text-muted">No usage limits reported.</div>}
              <div className="px-3 py-1 text-[10px] text-subtle">Updated {fetchedAgo(result.snapshot.fetchedAt)}</div>
            </>}
        </div>
      )}
    </div>
  );
}

/**
 * What is left of both licences.
 *
 * It used to follow one app-wide "active provider" and show that one's meters.
 * There is no such thing any more — a conversation is bound to the provider it
 * was started with — so both are shown, each foldable on its own, and the pane's
 * own badge is whichever of the two is closest to its wall.
 */
export default function UsagePanel() {
  const [open, setOpen] = usePersistedBool('agentsflow:usage:open', true);
  const { snapshot } = useAccountsSnapshot();
  const claude = useProviderUsage('claude');
  const codex = useProviderUsage('codex');
  // Same rule as the Accounts pane: a provider you have sign-ins saved for is
  // one you are watching, so its meters start visible; the first toggle settles
  // it for good.
  const [claudeOpen, setClaudeOpen] = usePersistedFold('agentsflow:usage:claudeOpen', snapshot.accounts.length > 0);
  const [codexOpen, setCodexOpen] = usePersistedFold('agentsflow:usage:codexOpen', snapshot.codexAccounts.length > 0);

  // The pane's badge is the worse of the two binding meters: with the pane
  // folded shut this number is the only warning there is, so it has to be the
  // nearest wall of either licence, not of one of them.
  const claudeBadge = worstMeter(claude.result);
  const codexBadge = worstMeter(codex.result);
  const badge = !claudeBadge ? codexBadge
    : !codexBadge ? claudeBadge
    : codexBadge.percent > claudeBadge.percent ? codexBadge : claudeBadge;

  return (
    <div data-open={open ? '1' : '0'} className="shrink-0 rounded-lg border border-border bg-panel overflow-hidden flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-2 py-2 bg-panel2/60 hover:bg-panel2">
        <span className="w-1 h-4 rounded-full bg-info shrink-0" aria-hidden="true" />
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left" title={open ? 'Hide usage' : 'Show plan usage limits'}>
          <span className="text-muted text-[10px] w-3 shrink-0">{open ? '▼' : '▶'}</span>
          <span className="text-[11px] uppercase tracking-wider text-text font-semibold">Usage</span>
          {badge && (
            <span
              className="ml-auto text-[10px] font-mono shrink-0"
              style={{ color: SEVERITY_COLOR[badge.severity] }}
              title="The nearest wall across both providers"
            >
              {badge.percent}%
            </span>
          )}
        </button>
        {/* No ↻ up here: refreshing is per licence now, and each section carries
            its own next to the numbers it reloads. */}
      </div>
      {/* The body keeps its own 30vh design cap AND obeys the docked cluster's
          measured budget when there is one (see DockedPanes). Outside a budgeted
          cluster --dock-body-max is unset, the 100vh fallback never bites, and
          the cap is exactly what it always was. */}
      {open && <div className="flex-1 min-h-0 overflow-y-auto border-t border-border/60" style={{ maxHeight: 'min(300px, 30vh, var(--dock-body-max, 100vh))' }}>
        <UsageSection
          provider="claude"
          open={claudeOpen}
          onToggle={() => setClaudeOpen(!claudeOpen)}
          result={claude.result}
          loading={claude.loading}
          onRefresh={() => void claude.load(true)}
        />
        <UsageSection
          provider="codex"
          open={codexOpen}
          onToggle={() => setCodexOpen(!codexOpen)}
          result={codex.result}
          loading={codex.loading}
          onRefresh={() => void codex.load(true)}
        />
      </div>}
    </div>
  );
}
