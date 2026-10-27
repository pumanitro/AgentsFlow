import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import type { HookGuardRow, HookGuardState, HookGuardsSnapshot } from '../../shared/hookguards';

// Cyan — distinct from Usage blue, Notes green, Keeper teal and Perf pink.
export const HOOKGUARDS_TICK_COLOR = '#22d3ee';

const OK_COLOR = '#4ade80';
const ERR_COLOR = '#ef4444';
const WARN_COLOR = '#fbbf24';
const IDLE_COLOR = '#8c93a8'; // subtle

const STATE_COLOR: Record<HookGuardState, string> = {
  active: OK_COLOR,
  failed: ERR_COLOR,
  checking: WARN_COLOR,
  pending: IDLE_COLOR,
};

const STATE_TEXT: Record<HookGuardState, string> = {
  active: 'On — protecting every new chat',
  failed: 'Off — its check failed, so it is not switched on',
  checking: 'Being checked right now',
  pending: 'Not checked yet',
};

// A persisted boolean keyed in localStorage. Starts at `fallback` to avoid an
// SSR/first-paint flash, then hydrates on mount. (Mirrors KeeperPanel's helper.)
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

// "4 min ago" — whole words, since these lines are read, not scanned.
function ago(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const s = Math.round(ms / 1000);
  if (s < 45) return 'just now';
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function duration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `took ${ms} ms`;
  return `took ${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const busy = (s: HookGuardsSnapshot | null) => s?.phase === 'installing' || s?.phase === 'checking';

/**
 * The guards' latest picture: read on mount, every `pollMs`, and whenever the
 * main process pushes one — the push is what shows each row's live "checking".
 *
 * All three calls are optional on the api: a running app whose preload predates
 * the guards has none of them, and the card then says so instead of throwing.
 */
function useHookGuardsSnapshot(pollMs: number): {
  snap: HookGuardsSnapshot | null; failed: boolean; unavailable: boolean; recheck: () => Promise<void>; rechecking: boolean;
} {
  const [snap, setSnap] = useState<HookGuardsSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const mounted = useRef(true);
  const unavailable = typeof api().getHookGuardsSnapshot !== 'function';

  const load = useCallback(async () => {
    try {
      const s = await api().getHookGuardsSnapshot?.();
      if (!mounted.current || !s) return;
      setSnap(s);
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (unavailable) return () => { mounted.current = false; };
    void load();
    const t = setInterval(() => void load(), pollMs);
    let off: (() => void) | undefined;
    try {
      off = api().onHookGuardsUpdated?.((s) => { if (mounted.current && s) setSnap(s); });
    } catch { /* an older preload: polling alone keeps it fresh */ }
    return () => {
      mounted.current = false;
      clearInterval(t);
      try { off?.(); } catch { /* ignore */ }
    };
  }, [load, pollMs, unavailable]);

  // The re-check takes as long as the slowest guard's own test (up to ~20 s);
  // pushes show the rows moving meanwhile, the refetch shows what actually holds.
  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      const s = await api().recheckHookGuards?.();
      if (s && mounted.current) setSnap(s);
    } catch { /* the refetch below shows what actually holds */ }
    await load();
    if (mounted.current) setRechecking(false);
  }, [load]);

  return { snap, failed, unavailable, recheck, rechecking };
}

function GuardRow({ row, shimDir }: { row: HookGuardRow; shimDir: string | null }) {
  const color = STATE_COLOR[row.state];
  const checked = [ago(row.verifiedAt) && `checked ${ago(row.verifiedAt)}`, duration(row.checkMs)].filter(Boolean).join(' · ');
  return (
    <div className="px-3 py-1.5 flex items-start gap-2 min-w-0 border-t border-border/40 first:border-t-0" title={row.entry}>
      <span
        className={`mt-[5px] w-2 h-2 rounded-full shrink-0${row.state === 'failed' ? ' animate-pulse' : ''}`}
        style={{ backgroundColor: color }}
        title={STATE_TEXT[row.state]}
        aria-label={STATE_TEXT[row.state]}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-text">{row.title}</div>
        <div className="text-[11px] text-muted leading-snug">{row.what}</div>
        {row.id === 'kill-shims' && (
          <div className="text-[10px]" style={{ color: shimDir ? OK_COLOR : IDLE_COLOR }}>
            {shimDir ? "on every chat's PATH" : 'not on PATH'}
          </div>
        )}
        {row.state === 'failed' ? (
          <div className="mt-0.5 text-[10px] whitespace-pre-wrap font-mono break-words" style={{ color: ERR_COLOR }}>
            {row.detail || 'Its check failed.'}
          </div>
        ) : row.state === 'checking' ? (
          <div className="text-[10px]" style={{ color: WARN_COLOR }}>checking now…</div>
        ) : row.state === 'pending' ? (
          <div className="text-[10px] text-muted">waiting for its check</div>
        ) : checked ? (
          <div className="text-[10px] text-muted">{checked}</div>
        ) : null}
      </div>
    </div>
  );
}

// The Guards sidebar card, worded for someone who has never heard of a hook:
// are the safety checks Peers Flow puts in front of every chat switched on
// right now, and if one is off, why. Same docked-card shape as Usage / Keeper.
export default function HookGuardsPanel(): JSX.Element {
  const [open, setOpen] = usePersistedBool('agentsflow:hookguards:open', false);
  const { snap, unavailable, failed, recheck, rechecking } = useHookGuardsSnapshot(open ? 10_000 : 30_000);

  const guards = snap?.guards ?? [];
  const active = guards.filter((g) => g.state === 'active').length;
  const broken = guards.filter((g) => g.state === 'failed').length;
  const working = busy(snap) || rechecking;

  // With the card folded shut (the default) this is all there is, so it carries
  // the verdict; a failed guard wins over everything except a check in flight.
  const badge: Array<{ text: string; color: string }> = [];
  if (unavailable) badge.push({ text: 'restart app', color: IDLE_COLOR });
  else if (busy(snap)) badge.push({ text: 'checking…', color: WARN_COLOR });
  else if (broken) {
    badge.push({ text: `${broken} failed`, color: ERR_COLOR });
    if (active) badge.push({ text: `${active} active`, color: OK_COLOR });
  } else if (active) badge.push({ text: `${active} active`, color: OK_COLOR });
  else if (snap && (snap.phase === 'idle' || snap.phase === 'error')) badge.push({ text: 'not installed', color: IDLE_COLOR });

  const lastRun = snap?.lastRun ?? null;
  const moved = lastRun?.supersededMoved.length ?? 0;

  return (
    <div data-open={open ? '1' : '0'} className="shrink-0 rounded-lg border border-border bg-panel overflow-hidden flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-2 py-2 bg-panel2/60 hover:bg-panel2">
        <span className="w-1 h-4 rounded-full shrink-0" style={{ backgroundColor: HOOKGUARDS_TICK_COLOR }} aria-hidden="true" />
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left" title={open ? 'Hide the guards' : 'Show the safety checks Peers Flow puts in front of every chat'}>
          <span className="text-muted text-[10px] w-3 shrink-0">{open ? '▼' : '▶'}</span>
          <span className="text-[11px] uppercase tracking-wider text-text font-semibold">Guards</span>
          {badge.length > 0 && (
            <span className="ml-auto text-[10px] font-mono shrink-0" title="Safety checks that stop a chat from doing something it cannot undo">
              {badge.map((b, i) => (
                <span key={b.text}>
                  {i > 0 && <span className="text-subtle"> · </span>}
                  <span style={{ color: b.color }}>{b.text}</span>
                </span>
              ))}
            </span>
          )}
        </button>
      </div>
      {/* Same budget rule as Usage / Keeper: its own cap AND the docked cluster's
          measured budget when there is one (see DockedPanes). */}
      {open && <div className="flex-1 min-h-0 overflow-y-auto border-t border-border/60" style={{ maxHeight: 'min(300px, 30vh, var(--dock-body-max, 100vh))' }}>
        {unavailable ? <div className="px-3 py-2 text-[11px] text-muted italic">Restart Peers Flow to switch the guards on.</div>
          : !snap ? <div className="px-3 py-2 text-[11px] text-muted">{failed ? 'Could not reach the guards.' : 'Checking the guards…'}</div>
          : <>
            {guards.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-muted">No guards installed yet. Press Re-check to install them.</div>
            )}
            {guards.map((row) => <GuardRow key={row.id} row={row} shimDir={snap.shimDir} />)}
            <div className="px-3 py-1.5 flex items-center gap-2 flex-wrap border-t border-border/60">
              <button
                onClick={() => { void recheck(); }}
                disabled={working}
                className="shrink-0 text-[10px] font-semibold leading-none px-1.5 py-1 rounded border border-border text-text hover:bg-panel2 disabled:opacity-50 disabled:cursor-default"
                title="Run every guard's own test again and switch on the ones that pass"
              >
                {working ? 'Checking…' : 'Re-check'}
              </button>
              {typeof api().revealInFinder === 'function' && (
                <button
                  onClick={() => { void api().revealInFinder(snap.installDir); }}
                  className="shrink-0 text-[10px] text-muted hover:text-text underline-offset-2 hover:underline"
                  title={snap.installDir}
                >
                  Open folder
                </button>
              )}
              {lastRun && (
                <span className="min-w-0 text-[10px] text-muted">
                  {[
                    lastRun.backup ? <span key="b" title={snap.settingsPath}>settings backed up</span> : null,
                    moved ? <span key="m">{plural(moved, 'old copy', 'old copies')} moved aside</span> : null,
                    lastRun.error ? <span key="e" style={{ color: ERR_COLOR }}>{lastRun.error}</span> : null,
                  ].filter(Boolean).map((el, i) => <span key={i}>{i > 0 && ' · '}{el}</span>)}
                </span>
              )}
            </div>
          </>}
      </div>}
    </div>
  );
}
