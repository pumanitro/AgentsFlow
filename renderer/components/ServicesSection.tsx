import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import type { ServiceLogEntry, ServiceRow, ServicesMode, ServicesSnapshot, ServiceState } from '../../shared/services';
import { SectionLabel } from './PerfBits';

// "Sleeping services" as the Performance monitor shows it: the background
// services Peers Flow puts to sleep when nobody uses them (a data service, the
// Docker projects, Docker Desktop itself) and wakes again on the first request
// or a click. Worded for someone who has never heard of ports or containers
// beyond "something asked for it".

export interface ServicesActions {
  wake(id: string): Promise<void>;
  sleep(id: string): Promise<void>;
  pin(id: string, pinned: boolean): Promise<void>;
  idle(id: string, minutes: number): Promise<void>;
  managed(id: string, on: boolean): Promise<void>;
  mode(m: ServicesMode): Promise<void>;
  rediscover(): Promise<void>;
}

/**
 * The services snapshot, polled every `pollMs` and refreshed by the main
 * process's own push — the same shape as `useGuardSnapshot`. `unavailable` =
 * this app's preload predates sleeping services (it needs a restart). Wake and
 * sleep reject with the main process's own error so the row can show it.
 */
export function useServicesSnapshot(pollMs: number): { snap: ServicesSnapshot | null; failed: boolean; unavailable: boolean; act: ServicesActions } {
  const [snap, setSnap] = useState<ServicesSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const unavailable = typeof api().getServicesSnapshot !== 'function';

  const load = useCallback(async () => {
    try {
      const s = await api().getServicesSnapshot?.();
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
      off = api().onServicesUpdated?.((s) => { if (mounted.current && s) setSnap(s); });
    } catch { /* an older preload: polling alone keeps it fresh */ }
    return () => {
      mounted.current = false;
      clearInterval(t);
      try { off?.(); } catch { /* ignore */ }
    };
  }, [load, pollMs, unavailable]);

  // Settings calls: whatever happens, the refetch shows what actually holds.
  const settle = useCallback(async (call: () => Promise<ServicesSnapshot | undefined> | undefined) => {
    try {
      const s = await call();
      if (s && mounted.current) setSnap(s);
    } catch { /* the refetch below shows what actually holds */ }
    await load();
  }, [load]);

  // Wake / sleep wait for the service itself (up to a few minutes), so the
  // push usually shows "Waking up…" long before this resolves.
  const run = useCallback(async (call: () => Promise<{ ok: boolean; error?: string; snapshot: ServicesSnapshot } | undefined> | undefined) => {
    let error: string | null = null;
    try {
      const r = await call();
      if (r?.snapshot && mounted.current) setSnap(r.snapshot);
      if (r && !r.ok) error = r.error || 'it did not answer in time';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await load();
    if (error) throw new Error(error);
  }, [load]);

  const [act] = useState<ServicesActions>(() => ({
    wake: (id) => run(() => api().wakeService?.(id)),
    sleep: (id) => run(() => api().sleepService?.(id)),
    pin: (id, pinned) => settle(() => api().setServicePin?.(id, pinned)),
    idle: (id, minutes) => settle(() => api().setServiceIdle?.(id, minutes)),
    managed: (id, on) => settle(() => api().setServiceManaged?.(id, on)),
    mode: (m) => settle(() => api().setServicesMode?.(m)),
    rediscover: () => settle(() => api().rediscoverServices?.()),
  }));
  // `run`/`settle` only close over `load` (stable) and the ref, so the actions
  // captured on the first render stay correct.

  return { snap, failed, unavailable, act };
}

const AWAKE_COLOR = '#4ade80';
const ASLEEP_COLOR = '#93c5fd';
const BUSY_COLOR = '#fbbf24';
const IDLE_COLOR = '#fbbf24';
const FAILED_COLOR = '#ff7847';

const STATE_TEXT: Record<ServiceState, string> = {
  awake: 'Awake',
  asleep: 'Asleep',
  waking: 'Waking up…',
  sleeping: 'Going to sleep…',
  unknown: 'Not checked yet',
};
const STATE_COLOR: Record<ServiceState, string> = {
  awake: AWAKE_COLOR,
  asleep: ASLEEP_COLOR,
  waking: BUSY_COLOR,
  sleeping: BUSY_COLOR,
  unknown: '#8c93a8',
};

// Sort order: things happening now, then what is about to sleep, then the rest.
function rank(r: ServiceRow): number {
  if (r.kind === 'docker-desktop') return 9;
  if (r.state === 'waking' || r.state === 'sleeping') return 0;
  switch (r.verdict) {
    case 'idle': return 1;
    case 'in-use': case 'too-new': case 'blocked': return 2;
    case 'asleep': return 3;
    case 'pinned': return 4;
    case 'unmanaged': return 5;
    default: return 6;
  }
}

function fmtDuration(min: number): string {
  const m = Math.max(0, Math.floor(min));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const rest = m % 60;
  return rest === 0 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 60)} h ${rest} min`;
}

function hhmm(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Time of day, with the date in front when it was not today.
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = hhmm(iso);
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

function minutesAgo(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, (now - t) / 60_000) : null;
}

function fmtMem(mb: number | null): string {
  if (mb === null) return '–';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function portList(ports: number[]): string {
  return ports.map((p) => `:${p}`).join(', ');
}

// The second line of a row: how it wakes, or why it stays on.
function wakeHint(r: ServiceRow): string | null {
  if (r.kind === 'docker-desktop') {
    if (r.state === 'asleep') return 'Docker Desktop is off — it starts by itself when a Docker project wakes up.';
    if (r.state === 'awake') return 'Turns itself off once every Docker project here is asleep.';
    return null;
  }
  if (r.state !== 'asleep') return null;
  return r.guardedPorts.length > 0
    ? `Wakes on the first request to ${portList(r.guardedPorts)} or when you click Wake.`
    : 'Wakes when you click Wake.';
}

const BY_TEXT: Record<string, string> = {
  idle: 'nobody used it',
  pressure: 'memory was tight',
  request: 'something asked for it',
  click: 'you clicked',
  startup: 'Peers Flow started',
  docker: 'Docker changed',
};

function logLine(e: ServiceLogEntry): { what: string; bad: boolean } {
  const n = e.name || e.id;
  switch (e.event) {
    case 'slept':
      if (e.by === 'pressure') return { what: `${n} was put to sleep early — memory was tight`, bad: false };
      return { what: `${n} went to sleep — ${BY_TEXT[e.by] ?? e.by}`, bad: false };
    case 'woke': return { what: `${n} woke up — ${BY_TEXT[e.by] ?? e.by}`, bad: false };
    case 'sleep-failed': return { what: `${n} could not be put to sleep`, bad: true };
    case 'wake-failed': return { what: `${n} could not be woken up`, bad: true };
    case 'proxy-armed': return { what: `${n} is waiting for its next request`, bad: false };
    case 'proxy-failed': return { what: `${n} cannot wake by itself — something else holds its address`, bad: true };
    case 'discovered': return { what: `Found a new Docker project: ${n}`, bad: false };
    case 'docker-started': return { what: 'Docker Desktop started', bad: false };
    case 'docker-stopped': return { what: 'Docker Desktop turned off — nothing needed it', bad: false };
    default: return { what: `${n}: ${String(e.event)}`, bad: false };
  }
}

const btn = 'shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed';

function IdleBox({ r, onSave }: { r: ServiceRow; onSave: (minutes: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(r.idleMinutes);
  const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= 10_080;
  const dirty = draft !== null && parsed !== r.idleMinutes;
  const save = () => {
    if (!valid || !dirty) return;
    onSave(parsed);
    setDraft(null);
  };
  const id = `svc-idle-${r.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[10px] text-muted">
      <label htmlFor={id}>sleeps after</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={10080}
        step={1}
        value={value}
        disabled={!r.managed || r.pinned}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape' && draft !== null) { e.stopPropagation(); setDraft(null); } }}
        className={`w-14 px-1 py-px rounded border bg-bg text-text font-mono text-[10px] outline-none focus:border-accent disabled:opacity-40 ${valid ? 'border-border' : 'border-err'}`}
        aria-invalid={!valid}
      />
      <span>min of no use{valid ? ` (${fmtDuration(parsed)})` : ''}</span>
      {dirty && (
        <button type="button" onClick={save} disabled={!valid} className={`${btn} border-accent text-text hover:bg-panel2`}>Save</button>
      )}
      {!valid && <span className="text-err">1 to 10080</span>}
    </span>
  );
}

function ServiceCard({ r, act, now }: { r: ServiceRow; act: ServicesActions; now: number }) {
  const [pending, setPending] = useState<'wake' | 'sleep' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = r.state === 'waking' || r.state === 'sleeping' || pending !== null;
  const usedAgo = minutesAgo(r.lastUsedAt, now);
  const sinceAt = hhmm(r.since);
  const hint = wakeHint(r);
  const stateColor = r.verdict === 'idle' && r.state === 'awake' ? IDLE_COLOR : STATE_COLOR[r.state] ?? STATE_COLOR.unknown;

  const go = (kind: 'wake' | 'sleep') => {
    setPending(kind);
    setError(null);
    (kind === 'wake' ? act.wake(r.id) : act.sleep(r.id))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setPending(null));
  };

  const facts: string[] = [];
  if (usedAgo !== null) facts.push(usedAgo < 1 ? 'used just now' : `used ${fmtDuration(usedAgo)} ago`);
  if (sinceAt) facts.push(`${STATE_TEXT[r.state].replace('…', '').toLowerCase()} since ${sinceAt}`);
  if (r.memMB !== null) facts.push(`memory ${fmtMem(r.memMB)}`);
  if (r.cpuPct !== null) facts.push(`CPU ${r.cpuPct}%`);
  if (r.state === 'awake' && r.establishedConns > 0) facts.push(`${r.establishedConns} open connection${r.establishedConns === 1 ? '' : 's'}`);

  return (
    <div className="px-3 py-1.5 border-t border-border/40 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <span className="min-w-0 text-[11px] leading-snug">
          <span className="font-semibold text-text">{r.name}</span>
          <span className="font-semibold" style={{ color: pending ? BUSY_COLOR : stateColor }}>
            {' · '}{pending === 'wake' ? 'Waking up…' : pending === 'sleep' ? 'Going to sleep…' : STATE_TEXT[r.state] ?? STATE_TEXT.unknown}
          </span>
          {r.pinned && <span className="text-ok"> · pinned</span>}
          {!r.managed && <span className="text-muted"> · left alone</span>}
        </span>
        <span className="flex flex-wrap items-center gap-1">
          {r.canWake && (
            <button type="button" disabled={busy} onClick={() => go('wake')} title={`Start ${r.name} now.`}
              className={`${btn} border-border text-text hover:border-accent hover:bg-panel2`}>Wake</button>
          )}
          {r.canSleep && (
            <button type="button" disabled={busy} onClick={() => go('sleep')} title={`Stop ${r.name} now; it wakes again when something asks for it.`}
              className={`${btn} border-border text-text hover:border-accent hover:bg-panel2`}>Put to sleep</button>
          )}
          <button
            type="button"
            disabled={busy || !r.managed}
            onClick={() => void act.pin(r.id, !r.pinned)}
            aria-pressed={r.pinned}
            title={r.pinned ? `${r.name} is pinned: it is never put to sleep for being idle. Click to unpin.` : `Pin ${r.name} so it is never put to sleep for being idle.`}
            className={`${btn} ${r.pinned ? 'border-ok bg-ok/15 text-ok hover:bg-ok/25' : 'border-border text-text hover:border-accent hover:bg-panel2'}`}
          >{r.pinned ? '✓ Pinned · unpin' : 'Pin'}</button>
        </span>
      </div>
      {r.note && <div className="text-[11px] leading-snug text-text mt-0.5">{r.note}</div>}
      {hint && <div className="text-[11px] leading-snug text-muted">{hint}</div>}
      {error && <div className="text-[11px] leading-snug mt-0.5" style={{ color: FAILED_COLOR }}>Did not work: {error}</div>}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
        {facts.length > 0 && <span className="text-[10px] font-mono text-muted">{facts.join(' · ')}</span>}
        {r.kind !== 'docker-desktop' && <IdleBox r={r} onSave={(m) => void act.idle(r.id, m)} />}
        <button
          type="button"
          onClick={() => void act.managed(r.id, !r.managed)}
          disabled={busy}
          title={r.managed ? 'Peers Flow will only list it — never stop or start it by itself.' : 'Let Peers Flow put it to sleep when idle and wake it on demand.'}
          className="text-[10px] text-subtle underline decoration-dotted hover:text-text disabled:opacity-40"
        >{r.managed ? 'leave it alone' : 'let Peers Flow manage it'}</button>
      </div>
    </div>
  );
}

export default function ServicesSection(p: {
  snap: ServicesSnapshot | null;
  act: ServicesActions;
  layout: 'sidebar' | 'wide';
  // True when this app's preload (or main process) predates sleeping services.
  unavailable?: boolean;
}) {
  const { snap, act, layout, unavailable } = p;
  const [now, setNow] = useState(() => Date.now());
  const [looking, setLooking] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!snap) {
    return (
      <div className="flex flex-col pb-1">
        <SectionLabel>Sleeping services</SectionLabel>
        <div className="px-3 py-1 text-[11px] text-muted italic">
          {unavailable ? 'Restart Peers Flow to turn on sleeping services.' : 'Checking services…'}
        </div>
      </div>
    );
  }

  const live = snap.mode === 'live';
  const services = snap.services ?? [];
  const recent = snap.recent ?? [];
  const rows = [...services].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const asleep = services.filter((s) => s.state === 'asleep').length;
  const awake = services.filter((s) => s.state === 'awake').length;
  const nameOf = (id: string) => services.find((s) => s.id === id)?.name ?? id;
  const queue = snap.memory?.pressure ? (snap.memory.queue ?? []) : [];
  const wide = layout === 'wide';

  const pressureLine = queue.length > 0 && (
    <div className="mx-3 mt-1 rounded-md border px-2.5 py-1.5 text-[11px] leading-snug" style={{ borderColor: BUSY_COLOR, backgroundColor: 'rgba(251,191,36,0.08)' }}>
      <span className="font-semibold" style={{ color: BUSY_COLOR }}>Memory is tight</span>
      <span className="text-text"> — sleeping the least-used services first: {queue.slice(0, 3).map(nameOf).join(', ')}</span>
    </div>
  );

  const controls = (
    <>
      <div className="px-3 pt-2 text-[10px] text-subtle mb-0.5">Peers Flow may stop idle services</div>
      <div className="px-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border overflow-hidden" role="radiogroup" aria-label="Sleeping services mode">
          <button
            type="button"
            role="radio"
            aria-checked={live}
            onClick={() => { if (!live) void act.mode('live'); }}
            title="On: services nobody uses are put to sleep and wake up again when needed."
            className={`px-2.5 py-1 text-[11px] font-medium whitespace-nowrap ${live ? 'bg-accent text-bg' : 'text-muted hover:text-text hover:bg-panel2'}`}
          >On</button>
          <button
            type="button"
            role="radio"
            aria-checked={!live}
            onClick={() => { if (live) void act.mode('watch'); }}
            title="Watch only: Peers Flow lists what it would do and never stops or starts anything by itself."
            className={`px-2.5 py-1 text-[11px] font-medium whitespace-nowrap border-l border-border ${!live ? 'bg-accent text-bg' : 'text-muted hover:text-text hover:bg-panel2'}`}
          >Watch only</button>
        </div>
        <button
          type="button"
          disabled={looking}
          onClick={() => { setLooking(true); void act.rediscover().finally(() => setLooking(false)); }}
          className={`${btn} border-border text-text hover:border-accent hover:bg-panel2`}
        >{looking ? 'Looking…' : 'Look for new Docker projects'}</button>
      </div>
      <div className="px-3 pt-1 text-[11px] leading-snug text-muted">
        {live
          ? 'A service nobody has used for a while goes to sleep and frees its memory. The next time something asks for it, it wakes up by itself — the first answer just takes a little longer. Nothing is deleted.'
          : 'Watch only: Peers Flow lists what it would put to sleep but never stops or starts anything by itself. Your Wake and Put to sleep clicks still work.'}
      </div>
    </>
  );

  const happened = (
    <>
      <SectionLabel>What happened</SectionLabel>
      {recent.length === 0 ? (
        <div className="px-3 py-1 text-[11px] text-muted italic">Nothing has been put to sleep or woken up yet.</div>
      ) : (
        <div className="px-3">
          {recent.slice(0, 6).map((e, i) => {
            const l = logLine(e);
            return (
              <div key={`${e.at}-${i}`} className="flex items-baseline gap-2 py-px text-[11px] leading-snug">
                <span className="font-mono text-subtle shrink-0">{when(e.at)}</span>
                <span className="min-w-0" title={e.detail || undefined}>
                  <span style={l.bad ? { color: FAILED_COLOR } : undefined} className={l.bad ? '' : 'text-text'}>{l.what}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {snap.files && (
        <details className="px-3 pt-1 text-[10px] text-subtle">
          <summary className="cursor-pointer select-none hover:text-text">Details</summary>
          <div className="pt-0.5 font-mono break-all leading-snug">
            <div>list of services: {snap.files.registry}</div>
            <div>clocks: {snap.files.state}</div>
            <div>history: {snap.files.log}</div>
          </div>
        </details>
      )}
    </>
  );

  const list = (
    <>
      <SectionLabel>
        Services · {services.length}{awake > 0 ? ` · ${awake} awake` : ''}{asleep > 0 ? ` · ${asleep} asleep` : ''}
      </SectionLabel>
      {rows.length === 0 ? (
        <div className="px-3 py-1 text-[11px] text-muted italic">No services found yet.</div>
      ) : (
        <div className="flex flex-col">
          {rows.map((r) => <ServiceCard key={r.id} r={r} act={act} now={now} />)}
        </div>
      )}
    </>
  );

  return (
    <div className="flex flex-col pb-1">
      <SectionLabel>
        Sleeping services · <span style={{ color: live ? AWAKE_COLOR : undefined }}>{live ? 'On' : 'Watch only (nothing is stopped)'}</span>
      </SectionLabel>
      {pressureLine}
      {wide ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-2 px-1">
          <div className="min-w-0 md:border-r md:border-border/40 pb-1">{controls}</div>
          <div className="min-w-0 pb-1">{happened}</div>
        </div>
      ) : controls}
      {list}
      {!wide && happened}
    </div>
  );
}
