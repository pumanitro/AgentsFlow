import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '../lib/ipc';
import type { Account, AccountsSnapshot, RotationPolicy, RotationStatus, UsageMeter, UsageResult } from '../../shared/types';

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

const SEVERITY_COLOR: Record<UsageMeter['severity'], string> = {
  normal: '#3b82f6',
  warning: '#fbbf24',
  danger: '#ef4444',
};

/** The percent that matters for an account at a glance: its binding limit. */
function bindingMeter(result: UsageResult | undefined): UsageMeter | null {
  if (!result?.ok) return null;
  const meters = result.snapshot.meters;
  if (meters.length === 0) return null;
  return meters.find((m) => m.isActive) ?? meters.reduce((a, b) => (b.percent > a.percent ? b : a));
}

function AccountRow({
  account,
  active,
  usage,
  busy,
  onSwitch,
  onRemove,
}: {
  account: Account;
  active: boolean;
  usage: UsageResult | undefined;
  busy: boolean;
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
        title={active ? 'This account is signed in' : `Switch to ${account.email}`}
      >
        <div className="flex items-baseline gap-1.5">
          <span className={`text-[12px] truncate ${active ? 'text-text font-semibold' : 'text-text'}`}>
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
        title={`Remove ${account.email} from the pool`}
        aria-label={`Remove ${account.email}`}
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
  const [snapshot, setSnapshot] = useState<AccountsSnapshot>({ accounts: [], activeId: null });
  const [usageById, setUsageById] = useState<Record<string, UsageResult>>({});
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ pendingId: string; shellId: string; email: string; cwd: string } | null>(null);
  const [policy, setPolicy] = useState<RotationPolicy>({ enabled: false, threshold: 95 });
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
          <span className="text-[10px] text-muted truncate">
            {activeAccount ? activeAccount.email : snapshot.accounts.length === 0 ? 'none yet' : 'current login'}
          </span>
        </button>
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
                  Add the Gmail accounts you want to rotate between. Each signs in once; switching
                  after that never opens a browser.
                </div>
              )}
              {snapshot.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  active={account.id === snapshot.activeId}
                  usage={usageById[account.id]}
                  busy={busy}
                  onSwitch={() => switchTo(account.id)}
                  onRemove={() => remove(account)}
                />
              ))}

              {error && (
                <div className="mx-3 my-1.5 px-2 py-1.5 rounded border border-danger/40 bg-danger/10 text-[11px] text-danger leading-relaxed">
                  {error}
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
                    <span className="text-[11px] text-text">Switch automatically at</span>
                    <input
                      type="number"
                      min={50}
                      max={99}
                      value={policy.threshold}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) void savePolicy({ ...policy, threshold: n });
                      }}
                      className="w-11 bg-panel2 border border-border rounded px-1 py-0.5 text-[11px] text-text text-right focus:outline-none focus:border-info"
                    />
                    <span className="text-[11px] text-muted">%</span>
                  </label>
                  <p className="mt-1 text-[10px] text-subtle leading-relaxed">
                    Runs in the background even with the window closed, so an overnight run rolls
                    onto a fresh account instead of hitting the wall.
                  </p>
                  {rotationStatus?.disabledReason && (
                    <p className="mt-1 text-[10px] text-danger leading-relaxed">{rotationStatus.disabledReason}</p>
                  )}
                  {!rotationStatus?.disabledReason && rotationStatus?.lastEvent && (
                    <p className="mt-1 text-[10px] text-muted leading-relaxed">{rotationStatus.lastEvent}</p>
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
                      placeholder="you@gmail.com"
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
                    + Add Gmail account
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
