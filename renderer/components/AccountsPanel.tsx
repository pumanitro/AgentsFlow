import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { api } from '../lib/ipc';
import type { CSSProperties, ReactNode } from 'react';
import type { Account, AccountsSnapshot, RotationPolicy, RotationStatus, UsageMeter, UsageResult } from '../../shared/types';
import { worstMeter } from '../../shared/usage';

const Terminal = dynamic(() => import('./Terminal'), { ssr: false });

// A persisted boolean keyed in localStorage. Starts at `fallback` to avoid an
// SSR/first-paint flash, then hydrates on mount. (Mirrors UsagePanel/NotesPanel.)
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

const USAGE_REFRESH_MS = 60_000;
// How often we ask whether the browser login has landed while the modal is open.
const PROBE_MS = 2500;

const HINT_WIDTH = 250;

/**
 * A `ⓘ` affordance for prose that is worth having but not worth three permanent
 * lines of a narrow sidebar. Opens on hover, and a click pins it open so it can
 * be read without keeping the pointer parked on the icon.
 *
 * The bubble renders into `document.body`: every ancestor here is either a
 * clipping scroll container or `overflow-hidden`, so an in-flow popover would be
 * cropped to a sliver.
 */
function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const shown = pinned || hovering;

  // The bubble sits a few pixels below the icon, so closing on `mouseleave`
  // alone would slam it shut in the gap on the way to reading it.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enter = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setHovering(true);
  }, []);
  const leave = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHovering(false), 150);
  }, []);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  // The bubble lives on <body>, so it has to be told where its anchor ended up —
  // and re-told whenever the sidebar scrolls out from under it.
  useEffect(() => {
    if (!shown) { setAt(null); return; }
    const measure = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      setAt({
        top: r.bottom + 6,
        left: Math.max(8, Math.min(r.left - 4, window.innerWidth - HINT_WIDTH - 8)),
      });
    };
    measure();
    // `true` so it also follows scrolling of the panel itself, not just the window.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [shown]);

  // A pinned bubble is dismissed the two ways anything pinned should be:
  // clicking away from it, or Escape.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchor.current?.contains(t) || bubble.current?.contains(t)) return;
      setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setPinned(false); }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [pinned]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={(e) => { e.preventDefault(); setPinned((p) => !p); }}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={enter}
        onBlur={leave}
        aria-label={label}
        aria-expanded={shown}
        className={`shrink-0 w-3.5 h-3.5 rounded-full border text-[9px] leading-none flex items-center justify-center ${
          shown ? 'border-info text-info' : 'border-subtle text-subtle hover:border-info hover:text-info'
        }`}
      >
        i
      </button>
      {shown && at && typeof document !== 'undefined' && createPortal(
        <div
          ref={bubble}
          role="tooltip"
          // Hovering the bubble itself counts as hovering the hint, so reading
          // it (or selecting its text) does not dismiss it mid-sentence.
          onMouseEnter={enter}
          onMouseLeave={leave}
          className="fixed z-[60] rounded-md border border-border bg-panel2 px-2.5 py-2 text-[10px] text-text leading-relaxed shadow-lg shadow-black/40"
          style={{ top: at.top, left: at.left, width: HINT_WIDTH }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

// Blur, not redaction: the layout stays byte-for-byte identical, so toggling it
// never reflows the panel out from under you.
const MASK: CSSProperties = { filter: 'blur(4.5px)' };

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@,;)]+/g;

/**
 * Blurs any address inside a sentence, so status lines can go on naming the
 * account they switched to without putting it on screen.
 */
function maskEmails(text: string, masked: boolean): ReactNode {
  if (!masked || !text.includes('@')) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(EMAIL_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push(<span key={i} style={MASK} className="select-none">{m[0]}</span>);
    last = i + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

const SEVERITY_COLOR: Record<UsageMeter['severity'], string> = {
  normal: '#3b82f6',
  warning: '#fbbf24',
  danger: '#ef4444',
};

/** The percent that matters for an account at a glance: its binding limit. */
// The number shown here has to be the number rotation switches on, or the panel
// reads "43%" next to an account whose agents are being refused. Both sides now
// come from one place — see shared/usage.ts for why `isActive` is not it.
function bindingMeter(result: UsageResult | undefined): UsageMeter | null {
  return worstMeter(result);
}

function AccountRow({
  account,
  active,
  usage,
  busy,
  masked,
  onSwitch,
  onRemove,
}: {
  account: Account;
  active: boolean;
  usage: UsageResult | undefined;
  busy: boolean;
  masked: boolean;
  onSwitch: () => void;
  onRemove: () => void;
}) {
  const meter = bindingMeter(usage);
  const color = meter ? SEVERITY_COLOR[meter.severity] : '#6b7280';
  return (
    <div
      className={`group flex items-center gap-2 px-3 py-1.5 ${
        active ? 'bg-info/10 border-l-2 border-info' : 'border-l-2 border-transparent hover:bg-panel2/60'
      }`}
    >
      <button
        onClick={onSwitch}
        disabled={active || busy}
        className="flex-1 min-w-0 text-left disabled:cursor-default"
        // Hover tooltips are a leak of their own: with emails hidden, they say
        // what the button does without saying whose account it is.
        title={active ? 'This account is signed in' : masked ? 'Switch to this account' : `Switch to ${account.email}`}
      >
        <div className="flex items-baseline gap-1.5">
          <span
            className={`text-[12px] truncate ${active ? 'text-text font-semibold' : 'text-text'} ${masked ? 'select-none' : ''}`}
            style={masked ? MASK : undefined}
          >
            {account.email}
          </span>
          {active && (
            <span className="text-[9px] uppercase tracking-wider text-info shrink-0">active</span>
          )}
          {meter && (
            <span className="ml-auto text-[11px] font-mono shrink-0" style={{ color }}>
              {meter.percent}%
            </span>
          )}
        </div>
        <div className="mt-1 h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}>
          <div
            className="h-full rounded-full"
            style={{ width: `${meter?.percent ?? 0}%`, background: color }}
          />
        </div>
      </button>
      <button
        onClick={onRemove}
        disabled={busy}
        className="shrink-0 opacity-0 group-hover:opacity-100 text-subtle hover:text-danger px-1 rounded disabled:opacity-30"
        title={masked ? 'Remove this account from the pool' : `Remove ${account.email} from the pool`}
        aria-label={masked ? 'Remove this account' : `Remove ${account.email}`}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * The one-time browser login for a new account, shown in a real terminal so the
 * user can complete the OAuth flow (and paste the code back) exactly as they
 * would in a CLI. Polls until the login lands, then hands back the Account.
 */
function AddAccountModal({
  pendingId,
  shellId,
  email,
  cwd,
  onDone,
  onCancel,
}: {
  pendingId: string;
  shellId: string;
  email: string;
  cwd: string;
  onDone: () => void;
  onCancel: (reason?: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  // Success is shown, not silently acted on: the login finishes in a browser
  // tab, so without an explicit "this worked" the user is left staring at a
  // terminal wondering whether anything happened.
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop || settled.current) return;
      try {
        const r = await api().probeAccount(pendingId);
        if (stop) return;
        if (r.status === 'ok') {
          settled.current = true;
          setSignedIn(r.account.email);
        } else if (r.status === 'mismatch' || r.status === 'duplicate') {
          settled.current = true;
          setError(r.error);
        }
      } catch { /* keep polling */ }
    };
    const t = setInterval(tick, PROBE_MS);
    return () => { stop = true; clearInterval(t); };
  }, [pendingId]);

  // Escape always gets you out. The terminal owns the keyboard while it has
  // focus, so this listens at the window level in the capture phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (signedIn) onDone();
      else onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [signedIn, onDone, onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      {/* A definite height, not just a max: the terminal below is `flex-1`, and
          in a content-sized column that resolves to zero — an invisible pane. */}
      <div className="w-full max-w-3xl h-[70vh] flex flex-col rounded-lg border border-border bg-panel overflow-hidden">
        <div className="shrink-0 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="w-1 h-4 rounded-full bg-accent shrink-0" aria-hidden="true" />
            <span className="text-[13px] text-text font-semibold">Sign in as {email}</span>
            <button
              onClick={() => (signedIn ? onDone() : onCancel())}
              className="ml-auto text-subtle hover:text-text px-2 py-0.5 rounded hover:bg-panel2"
            >
              {signedIn ? 'Close' : 'Cancel (Esc)'}
            </button>
          </div>
          {signedIn ? (
            <p className="mt-2 text-[11px] text-muted leading-relaxed">
              Done — nothing else is needed here.
            </p>
          ) : (
            <>
              <p className="mt-2 text-[11px] text-muted leading-relaxed">
                A browser tab is opening — authorise there, and paste the code back into the
                terminal below if it asks. This happens <strong className="text-text">once</strong>{' '}
                for this account; switching to it later never opens a browser.
              </p>
              <p className="mt-1 text-[11px] text-warning leading-relaxed">
                Your browser can only hold one claude.ai session, so if you are already signed in as
                another account, use an incognito window or a separate Chrome profile — otherwise
                this will authorise the account you are already signed in as.
              </p>
            </>
          )}
        </div>

        {error ? (
          <div className="p-4 flex-1 min-h-0 overflow-y-auto">
            <div className="text-[12px] text-danger leading-relaxed">{error}</div>
            <button
              onClick={() => onCancel(error)}
              className="mt-3 text-[12px] px-3 py-1 rounded border border-border text-text hover:bg-panel2"
            >
              Close
            </button>
          </div>
        ) : signedIn ? (
          <div className="p-6 flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-center">
            <span className="text-[28px] leading-none" aria-hidden="true">✓</span>
            <div className="text-[13px] text-text font-semibold">Signed in as {signedIn}</div>
            <div className="text-[11px] text-muted max-w-sm leading-relaxed">
              Added to your pool. It stays signed in from now on — switching to it is a click, and
              never opens a browser again.
            </div>
            <button
              onClick={onDone}
              className="mt-1 text-[12px] px-3 py-1 rounded border border-border text-text hover:bg-panel2"
            >
              Done
            </button>
          </div>
        ) : (
          // `relative` is load-bearing: Terminal renders `absolute inset-0`, so
          // without a positioned ancestor here it resolves against the fixed
          // overlay and paints over this modal's own frame — including the
          // button you would use to get out of it.
          <div className="flex-1 min-h-0 relative bg-black">
            {/* Focus stays here on purpose — the terminal is the primary
                content, and pasting the code back into it is the one thing the
                user may still have to do. Escape is captured above regardless. */}
            <Terminal shellId={shellId} shellCwd={cwd} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function AccountsPanel() {
  const [open, setOpen] = usePersistedBool('agentsflow:accounts:open', true);
  // Screen-sharing privacy: the pool is a list of the user's personal and work
  // addresses sitting permanently in the sidebar. Persisted, so it stays hidden
  // across restarts once you have decided you want it hidden.
  const [masked, setMasked] = usePersistedBool('agentsflow:accounts:maskEmails', false);
  const [snapshot, setSnapshot] = useState<AccountsSnapshot>({ accounts: [], activeId: null });
  const [usageById, setUsageById] = useState<Record<string, UsageResult>>({});
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [pending, setPending] = useState<{ pendingId: string; shellId: string; email: string; cwd: string } | null>(null);
  const [policy, setPolicy] = useState<RotationPolicy>({ enabled: false, threshold: 95, resumeOnLimit: true });
  const [rotationStatus, setRotationStatus] = useState<RotationStatus | null>(null);
  const mounted = useRef(true);

  const unavailable = typeof api().listAccounts !== 'function';

  const loadAccounts = useCallback(async () => {
    const a = api();
    if (typeof a.listAccounts !== 'function') return;
    try {
      const s = await a.listAccounts();
      if (mounted.current) setSnapshot(s);
    } catch { /* ignore */ }
  }, []);

  // Meters are fetched per account with that account's own token, so the pool
  // shows real headroom for accounts you are not currently signed in as.
  const loadUsage = useCallback(async (accounts: Account[], force: boolean) => {
    const a = api();
    if (typeof a.getAccountUsage !== 'function') return;
    await Promise.all(
      accounts.map(async (acct) => {
        try {
          const r = await a.getAccountUsage(acct.id, force);
          if (mounted.current) setUsageById((prev) => ({ ...prev, [acct.id]: r }));
        } catch { /* leave the previous value */ }
      }),
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadAccounts();
    const a = api();
    if (typeof a.getRotationPolicy === 'function') {
      void a.getRotationPolicy().then((r) => {
        if (!mounted.current) return;
        setPolicy(r.policy);
        setRotationStatus(r.status);
      }).catch(() => {});
    }
    const off = typeof a.onAccountsUpdated === 'function' ? a.onAccountsUpdated((s) => {
      if (mounted.current) setSnapshot(s);
    }) : undefined;
    const offRotation = typeof a.onRotationStatus === 'function' ? a.onRotationStatus((s) => {
      if (mounted.current) setRotationStatus(s);
    }) : undefined;
    return () => { mounted.current = false; off?.(); offRotation?.(); };
  }, [loadAccounts]);

  const savePolicy = useCallback(async (next: RotationPolicy) => {
    setPolicy(next);
    try {
      const r = await api().setRotationPolicy(next);
      if (mounted.current) {
        setPolicy(r.policy);
        setRotationStatus(r.status);
      }
    } catch { /* keep the optimistic value */ }
  }, []);

  useEffect(() => {
    void loadUsage(snapshot.accounts, false);
    const t = setInterval(() => loadUsage(snapshot.accounts, false), USAGE_REFRESH_MS);
    return () => clearInterval(t);
  }, [snapshot.accounts, loadUsage]);

  const startAdd = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api().addAccount(email);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setPending({ pendingId: r.pendingId, shellId: r.shellId, email: r.email, cwd: r.cwd });
      setEmail('');
      setAdding(false);
    } catch (err) {
      setError((err as Error)?.message ?? 'Could not start the sign-in.');
    } finally {
      setBusy(false);
    }
  }, [email]);

  const switchTo = useCallback(async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      const r = await api().switchAccount(id);
      if (!r.ok) setError(r.error);
      else await loadUsage(snapshot.accounts, true);
    } catch (err) {
      setError((err as Error)?.message ?? 'Switch failed.');
    } finally {
      setBusy(false);
      void loadAccounts();
    }
  }, [loadAccounts, loadUsage, snapshot.accounts]);

  const repair = useCallback(async () => {
    setRepairing(true);
    try {
      const s = await api().repairAccounts();
      if (mounted.current) setSnapshot(s);
      // A successful repair leaves the meters reading "signed out" until they
      // are re-fetched, which would look like the repair had not worked.
      if (mounted.current && !s.authIssue) await loadUsage(s.accounts, true);
    } catch { /* the banner stays up; the loop retries every minute anyway */ } finally {
      if (mounted.current) setRepairing(false);
    }
  }, [loadUsage]);

  const remove = useCallback(async (account: Account) => {
    setBusy(true);
    try {
      await api().removeAccount(account.id);
    } catch { /* ignore */ } finally {
      setBusy(false);
      void loadAccounts();
    }
  }, [loadAccounts]);

  const activeAccount = snapshot.accounts.find((a) => a.id === snapshot.activeId) ?? null;

  return (
    <div className="shrink-0 rounded-lg border border-border bg-panel overflow-hidden flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-2 py-2 bg-panel2/60 hover:bg-panel2">
        {/* Section identity: a violet accent tick marks this as the Accounts zone. */}
        <span className="w-1 h-4 rounded-full shrink-0" style={{ backgroundColor: '#a78bfa' }} aria-hidden="true" />
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          title={open ? 'Hide accounts' : 'Show the account pool'}
        >
          <span className="text-muted text-[10px] w-3 shrink-0">{open ? '▼' : '▶'}</span>
          <span className="text-[11px] uppercase tracking-wider text-text font-semibold">Accounts</span>
          <span
            className={`text-[10px] text-muted truncate ${masked && activeAccount ? 'select-none' : ''}`}
            style={masked && activeAccount ? MASK : undefined}
          >
            {activeAccount ? activeAccount.email : snapshot.accounts.length === 0 ? 'none yet' : 'current login'}
          </span>
        </button>
        {snapshot.accounts.length > 0 && (
          <button
            onClick={() => setMasked(!masked)}
            className={`shrink-0 p-0.5 rounded ${masked ? 'text-info' : 'text-subtle hover:text-text'}`}
            title={masked ? 'Show email addresses' : 'Hide email addresses (for screen sharing)'}
            aria-label={masked ? 'Show email addresses' : 'Hide email addresses'}
            aria-pressed={masked}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {masked ? (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </>
              ) : (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
          </button>
        )}
      </div>

      {open && (
        <div className="flex-1 min-h-0 overflow-y-auto border-t border-border/60 py-1" style={{ maxHeight: 'min(240px, 28vh)' }}>
          {unavailable ? (
            <div className="px-3 py-3 text-xs text-muted italic">
              Restart the app to enable Accounts (preload needs to refresh).
            </div>
          ) : (
            <div className="flex flex-col">
              {snapshot.accounts.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-muted leading-relaxed">
                  Add the accounts you want to rotate between — personal or work domain. Each signs
                  in once; switching after that never opens a browser.
                </div>
              )}
              {snapshot.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  active={account.id === snapshot.activeId}
                  usage={usageById[account.id]}
                  busy={busy}
                  masked={masked}
                  onSwitch={() => switchTo(account.id)}
                  onRemove={() => remove(account)}
                />
              ))}

              {/* Divergence between the two stored copies of a token is repaired
                  silently on a timer; this banner is only for the residue that
                  needs a human, so it stays absent essentially always. */}
              {snapshot.authIssue && (
                <div className="mx-3 my-1.5 px-2 py-1.5 rounded border border-warning/40 bg-warning/10 text-[11px] text-warning leading-relaxed">
                  <div>{maskEmails(snapshot.authIssue, masked)}</div>
                  <button
                    onClick={() => void repair()}
                    disabled={repairing}
                    className="mt-1 text-[11px] px-2 py-0.5 rounded border border-warning/50 text-warning hover:bg-warning/15 disabled:opacity-40"
                  >
                    {repairing ? 'Checking…' : 'Check again'}
                  </button>
                </div>
              )}

              {error && (
                <div className="mx-3 my-1.5 px-2 py-1.5 rounded border border-danger/40 bg-danger/10 text-[11px] text-danger leading-relaxed">
                  {maskEmails(error, masked)}
                </div>
              )}

              {/* Auto-rotation. Needs two accounts to mean anything, so it only
                  appears once there is somewhere to rotate to. */}
              {snapshot.accounts.length >= 2 && (
                <div className="mx-3 my-1 pt-1.5 border-t border-border/50">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={policy.enabled}
                      onChange={(e) => void savePolicy({ ...policy, enabled: e.target.checked })}
                      className="accent-info"
                    />
                    {/* The label is the only part allowed to give up room: a
                        narrow sidebar should clip the sentence, not shove the
                        threshold or the ⓘ off the edge. */}
                    <span className="text-[11px] text-text min-w-0 truncate">Switch automatically at</span>
                    <input
                      type="number"
                      min={50}
                      max={99}
                      value={policy.threshold}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) void savePolicy({ ...policy, threshold: n });
                      }}
                      className="shrink-0 w-11 bg-panel2 border border-border rounded px-1 py-0.5 text-[11px] text-text text-right focus:outline-none focus:border-info"
                    />
                    <span className="shrink-0 text-[11px] text-muted">%</span>
                    {/* The explainer is one-time knowledge, so it lives behind
                        the ⓘ rather than costing three lines of sidebar forever. */}
                    <span className="ml-auto flex items-center" onClick={(e) => e.preventDefault()}>
                      <InfoHint label="About automatic switching">
                        Runs in the background even with the window closed, so an overnight run rolls
                        onto a fresh account instead of hitting the wall.
                      </InfoHint>
                    </span>
                  </label>
                  {/* The backstop, indented under the threshold it backs up:
                      thresholds are a forecast, and a chat that hits the wall
                      anyway would otherwise sit dead until someone looks. */}
                  <label className="mt-1 flex items-center gap-2 cursor-pointer pl-5">
                    <input
                      type="checkbox"
                      checked={policy.resumeOnLimit}
                      disabled={!policy.enabled}
                      onChange={(e) => void savePolicy({ ...policy, resumeOnLimit: e.target.checked })}
                      className="accent-info disabled:opacity-40"
                    />
                    <span className={`text-[11px] min-w-0 truncate ${policy.enabled ? 'text-text' : 'text-subtle'}`}>
                      Resume chats that hit the limit
                    </span>
                    <span className="ml-auto flex items-center" onClick={(e) => e.preventDefault()}>
                      <InfoHint label="About resuming after a limit">
                        If a chat is refused with “You’ve hit your session limit”, switch account
                        straight away and send it “continue”, so it picks up where it stopped instead
                        of waiting for the window to reset.
                      </InfoHint>
                    </span>
                  </label>
                  {rotationStatus?.disabledReason && (
                    <p className="mt-1 text-[10px] text-danger leading-relaxed">
                      {maskEmails(rotationStatus.disabledReason, masked)}
                    </p>
                  )}
                  {/* The whole line goes behind the eye, not just the address in
                      it: "switched to X at 96%" is a readout of the account and
                      its headroom, which is the thing you are hiding. */}
                  {!rotationStatus?.disabledReason && rotationStatus?.lastEvent && (
                    <p
                      className={`mt-1 text-[10px] text-muted leading-relaxed ${masked ? 'select-none' : ''}`}
                      style={masked ? MASK : undefined}
                      title={masked ? 'Hidden — use the eye icon to show' : undefined}
                    >
                      {rotationStatus.lastEvent}
                    </p>
                  )}
                </div>
              )}

              <div className="px-3 pt-1.5 pb-1">
                {adding ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void startAdd();
                        if (e.key === 'Escape') { setAdding(false); setError(null); }
                      }}
                      placeholder="you@gmail.com or you@company.com"
                      className="flex-1 min-w-0 bg-panel2 border border-border rounded px-2 py-1 text-[12px] text-text placeholder:text-subtle focus:outline-none focus:border-info"
                    />
                    <button
                      onClick={() => void startAdd()}
                      disabled={busy || !email.trim()}
                      className="shrink-0 text-[11px] px-2 py-1 rounded border border-border text-text hover:bg-panel2 disabled:opacity-40"
                    >
                      Sign in
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setAdding(true); setError(null); }}
                    className="w-full text-left text-[11px] text-muted hover:text-text py-0.5"
                  >
                    + Add account
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {pending && (
        <AddAccountModal
          pendingId={pending.pendingId}
          shellId={pending.shellId}
          email={pending.email}
          cwd={pending.cwd}
          // Either way the login shell has done its job — leaving it running
          // would leak a PTY per account added.
          onDone={() => {
            const { shellId } = pending;
            setPending(null);
            void api().killShell(shellId).catch(() => {});
            void loadAccounts();
          }}
          onCancel={(reason) => {
            const { pendingId, shellId } = pending;
            setPending(null);
            if (reason) setError(reason);
            void api().killShell(shellId).catch(() => {});
            void api().cancelAddAccount(pendingId).catch(() => {});
            void loadAccounts();
          }}
        />
      )}
    </div>
  );
}
