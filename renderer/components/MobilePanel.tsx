import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import type { MobileDeviceRow, MobileScope, MobileStatus, PairingOffer } from '../../shared/mobile';

// Same persisted-bool helper as UsagePanel / NotesPanel.
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

const BTN = 'text-[11px] px-2 py-0.5 rounded border border-border hover:bg-panel2 disabled:opacity-40';
const BTN_DANGER = 'text-[11px] px-2 py-0.5 rounded border text-err border-err/50 hover:bg-panel2 disabled:opacity-40';
const INPUT = 'w-full text-[12px] text-text bg-bg border border-border rounded px-1.5 py-0.5 outline-none focus:border-accent';

function PairingCard({ pairing, onCancel }: { pairing: PairingOffer; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - now) / 1000));
  const expired = left <= 0;
  return (
    <div className="mt-1.5 rounded border border-border bg-panel2/40 p-2 flex flex-col items-center gap-1.5" data-testid="mobile-pairing">
      {!expired && (pairing.qrDataUrl
        ? <img src={pairing.qrDataUrl} width={160} height={160} alt="Pairing QR code" className="rounded bg-white" />
        : <code className="text-[10px] text-muted break-all">{pairing.qr}</code>)}
      <div className="font-mono text-[18px] tracking-widest text-text">{pairing.code}</div>
      <div className="text-[10px] text-muted break-all text-center">{pairing.url}</div>
      {expired
        ? <div className="text-[11px] text-warn">Code expired</div>
        : <div className="text-[10px] text-muted">Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</div>}
      <button onClick={onCancel} className={BTN}>Cancel</button>
    </div>
  );
}

function DeviceRow({ d, onScopes, onRevoke }: { d: MobileDeviceRow; onScopes: (s: MobileScope[]) => void; onRevoke: () => void }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);
  const isAdmin = d.scopes.includes('admin');
  return (
    <div className="px-3 py-1.5" data-testid="mobile-device">
      <div className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${d.connected ? 'bg-ok' : 'bg-subtle'}`}
          title={d.connected ? 'Connected now' : 'Not connected'}
        />
        <span className="text-[12px] text-text truncate flex-1">{d.name}</span>
        <button
          onClick={() => { if (confirm) { setConfirm(false); onRevoke(); } else setConfirm(true); }}
          className={BTN_DANGER}
          title="Sign this phone out for good"
        >
          {confirm ? 'Sure?' : 'Revoke'}
        </button>
      </div>
      <div className="mt-1 flex items-center gap-1 flex-wrap">
        {d.scopes.map((s) => (
          <span key={s} className="text-[10px] leading-none px-1 py-0.5 rounded border border-border text-muted">{s}</span>
        ))}
        <label className="ml-auto flex items-center gap-1 text-[10px] text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={isAdmin}
            onChange={(e) => onScopes(e.target.checked ? Array.from(new Set([...d.scopes, 'admin' as const])) : d.scopes.filter((s) => s !== 'admin'))}
          />
          admin
        </label>
      </div>
      <div className="mt-0.5 text-[10px] text-muted">last seen {fetchedAgo(d.lastSeenAt)}</div>
    </div>
  );
}

function SettingsForm({ status, run }: { status: MobileStatus; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const mobile = api().mobile!;
  const [owner, setOwner] = useState(status.settings.ownerLogin);
  const [key, setKey] = useState('');
  const [vocab, setVocab] = useState(status.settings.vocabulary.join('\n'));
  const focused = useRef<string | null>(null);
  // Follow server-side changes unless the user is typing in that field.
  useEffect(() => { if (focused.current !== 'owner') setOwner(status.settings.ownerLogin); }, [status.settings.ownerLogin]);
  useEffect(() => { if (focused.current !== 'vocab') setVocab(status.settings.vocabulary.join('\n')); }, [status.settings.vocabulary]);

  return (
    <div className="px-3 py-1.5 border-t border-border/60 flex flex-col gap-1.5">
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] text-muted">Owner login</span>
        <input
          className={INPUT} value={owner} placeholder="you@example.com" spellCheck={false}
          onFocus={() => { focused.current = 'owner'; }}
          onChange={(e) => setOwner(e.target.value)}
          onBlur={() => { focused.current = null; if (owner !== status.settings.ownerLogin) void run(() => mobile.updateSettings({ ownerLogin: owner.trim() })); }}
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] text-muted">Speech key <span className="text-subtle">({status.settings.sttKeySet ? 'set' : 'not set'})</span></span>
        <input
          className={INPUT} type="password" value={key} autoComplete="off" placeholder={status.settings.sttKeySet ? '••••••••' : 'sk-…'}
          onChange={(e) => setKey(e.target.value)}
          onBlur={() => { const k = key.trim(); setKey(''); if (k) void run(() => mobile.updateSettings({ sttKey: k })); }}
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] text-muted">Vocabulary (one word per line)</span>
        <textarea
          className={`${INPUT} resize-y`} rows={3} value={vocab} spellCheck={false}
          onFocus={() => { focused.current = 'vocab'; }}
          onChange={(e) => setVocab(e.target.value)}
          onBlur={() => {
            focused.current = null;
            const lines = vocab.split('\n').map((l) => l.trim()).filter(Boolean);
            if (lines.join('\n') !== status.settings.vocabulary.join('\n')) void run(() => mobile.updateSettings({ vocabulary: lines }));
          }}
        />
      </label>
    </div>
  );
}

export default function MobilePanel() {
  const [open, setOpen] = usePersistedBool('agentsflow:mobile:open', true);
  const mobile = api().mobile;
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!mobile) return;
    try {
      const s = await mobile.status();
      if (mounted.current) setStatus(s);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [mobile]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const off = mobile?.onUpdated((s) => { if (mounted.current) setStatus(s); });
    return () => { mounted.current = false; off?.(); };
  }, [mobile, refresh]);

  // Every action: run it, surface a failure inline, then re-read the status.
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    await refresh();
  }, [refresh]);

  const devices = (status?.devices ?? []).filter((d) => !(d as { revokedAt?: string }).revokedAt);
  const connected = status?.connectedSockets ?? 0;

  let badge: JSX.Element | null = null;
  if (status?.paused) badge = <span className="ml-auto text-[10px] font-mono shrink-0 text-err">paused</span>;
  else if (status?.devMode) badge = <span className="ml-auto text-[10px] font-mono shrink-0 text-muted">dev</span>;
  else if (status) badge = <span className="ml-auto text-[10px] font-mono shrink-0 text-muted">{devices.length} {devices.length === 1 ? 'phone' : 'phones'}</span>;

  const header = (
    <div className="shrink-0 flex items-center gap-2 px-2 py-2 bg-panel2/60 hover:bg-panel2">
      <span className="w-1 h-4 rounded-full bg-accent shrink-0" aria-hidden="true" />
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left" title={open ? 'Hide mobile access' : 'Show mobile access'}>
        <span className="text-muted text-[10px] w-3 shrink-0">{open ? '▼' : '▶'}</span>
        <span className="text-[11px] uppercase tracking-wider text-text font-semibold">Mobile</span>
        {badge}
      </button>
    </div>
  );

  const shell = (body: JSX.Element) => (
    <div data-open={open ? '1' : '0'} className="shrink-0 rounded-lg border border-border bg-panel overflow-hidden flex flex-col min-h-0">
      {header}
      {open && (
        <div className="flex-1 min-h-0 overflow-y-auto border-t border-border/60" style={{ maxHeight: status?.pairing ? 'min(480px, 70vh)' : 'min(300px, 30vh, var(--dock-body-max, 100vh))' }}>
          {body}
        </div>
      )}
    </div>
  );

  if (!mobile) {
    return shell(<div className="px-3 py-2 text-[11px] text-muted">Mobile gateway unavailable in this build</div>);
  }
  if (!status) {
    return shell(<div className="px-3 py-2 text-[11px] text-muted">{error ?? 'Loading…'}</div>);
  }

  const t = status.tailnet;
  return shell(
    <>
      {/* 1 · gateway status */}
      <div className="px-3 py-1.5 flex items-center gap-1.5 flex-wrap">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.running ? 'bg-ok' : 'bg-subtle'}`} />
        <span className="text-[12px] text-text">
          {status.running ? <>Gateway on <span className="font-mono">127.0.0.1:{status.port}</span></> : 'Gateway off'}
        </span>
        {status.devMode && <span className="text-[10px] leading-none px-1 py-0.5 rounded border border-warn/50 text-warn">dev mode</span>}
        <span className="text-[11px] text-muted ml-auto">{connected} connected</span>
      </div>

      {/* 2 · tailnet */}
      <div className="px-3 py-1.5 border-t border-border/60 text-[11px] text-muted">
        {t.available ? (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-text break-all">{t.dnsName}</span>
            {t.serveOn ? (
              <span className="text-ok break-all">serve on https://{t.dnsName}:{status.settings.httpsPort}</span>
            ) : (
              <>
                <span>serve off</span>
                <button className={BTN} onClick={() => void run(() => mobile.updateSettings({ httpsPort: status.settings.httpsPort }))}>Enable serve</button>
              </>
            )}
          </div>
        ) : t.error && !/no such file|not running|not found|connect/i.test(t.error) ? (
          // A real tailnet problem (logged out, expired key…) — short, full text on hover.
          <span className="text-warn line-clamp-2" title={t.error}>Personal tailnet problem: {t.error.split(/[.:]/)[0]}</span>
        ) : (
          // No home tailscaled at all yet (phase 0 not done): plain words, raw error on hover.
          <span title={t.error}>No personal tailnet yet — the gateway is reachable only from this Mac</span>
        )}
      </div>

      {/* 3 · pairing */}
      <div className="px-3 py-1.5 border-t border-border/60">
        {!status.pairing && (
          <button data-testid="mobile-pair" className={BTN} disabled={!status.running || status.paused} onClick={() => void run(() => mobile.startPairing())}>Pair a phone</button>
        )}
        {status.pairing && <PairingCard pairing={status.pairing} onCancel={() => void run(() => mobile.cancelPairing())} />}
      </div>

      {/* 4 · devices */}
      {devices.length > 0 && (
        <div className="border-t border-border/60 py-0.5">
          {devices.map((d) => (
            <DeviceRow
              key={d.id}
              d={d}
              onScopes={(s) => void run(() => mobile.setDeviceScopes(d.id, s))}
              onRevoke={() => void run(() => mobile.revokeDevice(d.id))}
            />
          ))}
          <div className="px-3 py-1">
            <RevokeAll onConfirm={() => void run(() => mobile.revokeAll())} />
          </div>
        </div>
      )}

      {/* 5 · pause */}
      <label className="px-3 py-1.5 border-t border-border/60 flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={status.paused} onChange={(e) => void run(() => mobile.setPaused(e.target.checked))} />
        <span className="text-[12px] text-text">Pause mobile access</span>
      </label>

      {/* 6 · settings */}
      <SettingsForm status={status} run={run} />

      {/* 7 · errors */}
      {(status.lastError || error) && (
        <div className="px-3 py-1.5 border-t border-border/60 text-[11px] text-err break-words">{error ?? status.lastError}</div>
      )}
    </>,
  );
}

function RevokeAll({ onConfirm }: { onConfirm: () => void }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);
  return (
    <button data-testid="mobile-revoke-all" className={BTN_DANGER} onClick={() => { if (confirm) { setConfirm(false); onConfirm(); } else setConfirm(true); }}>
      {confirm ? 'Sure? Revoke all' : 'Revoke all'}
    </button>
  );
}
