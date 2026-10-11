import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import { GUARD_LEVEL_COLOR } from '../lib/contract';
import type { AgentsFlowApi, GuardContainerRow, GuardSnapshot, KillLogEntry, MemLevel } from '../../shared/types';
import type { PerfSeverity } from '../../shared/perf-severity';
import { Row, SectionLabel } from './PerfBits';

// The memory guard as the Performance monitor shows it: how tight memory is and
// why, what the guard would do to each container, and the three things the user
// can change (keep-pins, practice ⇄ live, the idle window). Everything here is
// worded for someone who has never heard of swap or a compressor.

export type GuardPinsPatch = Parameters<NonNullable<AgentsFlowApi['setGuardPins']>>[0];

// Short form for the header pill, long form for the monitor's own header.
export const GUARD_LEVEL_SHORT: Record<MemLevel, string> = {
  ok: 'mem fine',
  warn: 'mem tight',
  closed: 'mem closed',
  critical: 'mem critical',
  unknown: 'mem …',
};
export const GUARD_LEVEL_LONG: Record<MemLevel, string> = {
  ok: 'Memory is fine',
  warn: 'Memory under pressure',
  closed: 'Closed to new sub-agents',
  critical: 'Memory critical',
  unknown: 'Memory not measured yet',
};

const LADDER: Array<{ level: MemLevel; label: string }> = [
  { level: 'ok', label: 'Fine' },
  { level: 'warn', label: 'Under pressure' },
  { level: 'closed', label: 'Closed to new sub-agents' },
  { level: 'critical', label: 'Critical' },
];

// The same limits the guard itself uses (electron/guard/mem-level.ts); only
// used here to colour a number and to say where the line is.
const TIGHT_SQUEEZED_GB = 32;
const CRITICAL_SQUEEZED_GB = 60;
const TIGHT_SPILLED_GB = 8;
const CRITICAL_SPILL_GROWTH_GB = 2;

const KEPT_COLOR = '#4ade80';
const WOULD_STOP_COLOR = '#fbbf24';
const STOPPING_COLOR = '#ef4444';
const STOPPED_COLOR = '#ff7847';

/**
 * The guard's snapshot, polled every `pollMs` and refreshed by the main
 * process's own push. `unavailable` = this app's preload predates the guard
 * (it needs a restart); nothing here ever throws because of that.
 */
export function useGuardSnapshot(pollMs: number) {
  const [snap, setSnap] = useState<GuardSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const unavailable = typeof api().getGuardSnapshot !== 'function';

  const load = useCallback(async () => {
    try {
      const s = await api().getGuardSnapshot?.();
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
      off = api().onGuardUpdated?.((s) => { if (mounted.current && s) setSnap(s); });
    } catch { /* an older preload: polling alone keeps it fresh */ }
    return () => {
      mounted.current = false;
      clearInterval(t);
      try { off?.(); } catch { /* ignore */ }
    };
  }, [load, pollMs, unavailable]);

  const setPins = useCallback(async (patch: GuardPinsPatch) => {
    try {
      await api().setGuardPins?.(patch);
    } catch { /* the refetch below shows what actually holds */ }
    await load();
  }, [load]);

  return { snap, failed, unavailable, setPins };
}

function fmtDuration(min: number): string {
  const m = Math.max(0, Math.floor(min));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const rest = m % 60;
  return rest === 0 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 60)} h ${rest} min`;
}

// "2h13m" / "12m" as the guard writes them → "2 h 13 min" / "12 min".
function spellDurations(text: string): string {
  return text
    .replace(/(\d+)h(\d{1,2})m/g, (_m, h: string, mm: string) => (Number(mm) === 0 ? `${h} h` : `${h} h ${Number(mm)} min`))
    .replace(/(\d+)m\b/g, '$1 min');
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

function gb(n: number): string {
  return `${(Math.round(n * 10) / 10).toFixed(1)} GB`;
}

function fmtMem(mb: number | null): string {
  if (mb === null) return '–';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// The guard's own short reasons, said in plain words.
function plainReason(reason: string): string {
  let m: RegExpMatchArray | null;
  if (reason === 'kernel memory pressure critical') return 'macOS says memory is critically short';
  if (reason === 'kernel memory pressure warn') return 'macOS says memory is getting tight';
  if (reason === 'memory sample unreadable') return 'The memory numbers could not be read this time';
  if ((m = reason.match(/^compressed ([\d.]+) GB > ([\d.]+)/))) return `macOS is squeezing ${m[1]} GB of memory to make room (the line is ${m[2]} GB)`;
  if ((m = reason.match(/^swap growing ([\d.]+) GB \/ 5 min > ([\d.]+)/))) return `Memory is spilling onto disk fast: ${m[1]} GB more in 5 minutes (the line is ${m[2]} GB)`;
  if ((m = reason.match(/^swap ([\d.]+) GB > ([\d.]+)/))) return `${m[1]} GB of memory has spilled onto disk (the line is ${m[2]} GB)`;
  if ((m = reason.match(/^clearing \((\d+)\/(\d+)\)/))) return `Looks clear again — double-checking (${m[1]} of ${m[2]})`;
  if ((m = reason.match(/^confirming critical \((\d+)\/(\d+)\)/))) return `May be critical — double-checking (${m[1]} of ${m[2]})`;
  return reason;
}

function levelMeaning(level: MemLevel, live: boolean): string {
  switch (level) {
    case 'ok': return 'Plenty of room. Nothing is held back.';
    case 'warn': return 'Memory is getting tight. Nothing is held back yet — if it stays like this for 5 minutes, new sub-agents will be asked to wait.';
    case 'closed': return 'Memory has stayed tight. New sub-agents are asked to wait until it clears; chats that are already running carry on.';
    case 'critical': return live
      ? 'Memory is critically short. New sub-agents wait, and containers nobody is using are being stopped to free room.'
      : 'Memory is critically short. New sub-agents wait. Practice mode: nothing is stopped — the list below shows what would be.';
    default: return 'The guard has not measured memory yet.';
  }
}

interface VerdictView { color: string; text: React.ReactNode; sub?: string; rank: number }

function verdictView(c: GuardContainerRow, live: boolean, now: number, recent: KillLogEntry[]): VerdictView {
  const note = c.note ?? '';
  switch (c.verdict) {
    case 'keep-pinned':
      return { color: KEPT_COLOR, text: 'Kept — you pinned it', rank: 3 };
    case 'keep-live-chat':
      return { color: KEPT_COLOR, text: 'Kept — a chat is using this project', rank: 3 };
    case 'keep-autoremove':
      return { color: KEPT_COLOR, text: 'Kept — stopping it would delete it', rank: 3 };
    case 'keep-young': {
      const watched = note.match(/^watched for only (.+)$/);
      const text = watched
        ? `Kept — only watched for ${spellDurations(watched[1])} so far`
        : note.startsWith('started ') ? `Kept — ${spellDurations(note)}` : 'Kept — started recently';
      return { color: KEPT_COLOR, text, sub: 'too new to judge', rank: 3 };
    }
    case 'keep-active': {
      if (!c.lastActiveAt || c.idleMinutes === null) {
        return { color: KEPT_COLOR, text: 'Kept — it could not be checked, so it is left alone', rank: 3 };
      }
      const text = c.idleMinutes < 1 ? 'Kept — in use right now' : `Kept — used ${fmtDuration(c.idleMinutes)} ago`;
      const sub = c.establishedConns > 0 ? `${c.establishedConns} open connection${c.establishedConns === 1 ? '' : 's'}` : undefined;
      return { color: KEPT_COLOR, text, sub, rank: 3 };
    }
    case 'stop-candidate': {
      const idle = c.idleMinutes !== null ? `idle ${fmtDuration(c.idleMinutes)}` : 'idle';
      const parts: string[] = [live ? 'only when memory turns critical' : 'practice mode: nothing is stopped'];
      if (!c.project || !c.projectDir) parts.push('gets a 60-second warning first');
      if (note.includes('· already')) parts.push(live ? 'a stop was already tried' : 'already counted in this practice run');
      return { color: WOULD_STOP_COLOR, text: `Would be stopped — ${idle}`, sub: parts.join(' · '), rank: 1 };
    }
    case 'stopping': {
      const at = c.stoppingAt ? new Date(c.stoppingAt).getTime() : NaN;
      const secs = Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
      const inText = secs === null ? 'soon' : secs === 0 ? 'now' : `in ${secs} s`;
      return live
        ? { color: STOPPING_COLOR, text: `Stopping ${inText}`, sub: 'pin it to keep it running', rank: 0 }
        : { color: STOPPING_COLOR, text: `Would be stopped ${inText}`, sub: 'practice mode: nothing is stopped', rank: 0 };
    }
    case 'stopped-by-guard': {
      const fromNote = note.match(/at (\d{1,2}:\d{2})/)?.[1];
      const entry = recent.find((e) => e.kind === 'container' && e.name === c.name && !e.dry);
      const at = fromNote ?? (entry ? hhmm(entry.at) : '');
      return {
        color: STOPPED_COLOR,
        text: (
          <>
            Stopped by the guard{at ? ` at ${at}` : ''} — start it again with:{' '}
            <code className="font-mono text-text bg-bg border border-border rounded px-1 select-all">docker start {c.name}</code>
          </>
        ),
        rank: 2,
      };
    }
    default:
      return { color: KEPT_COLOR, text: 'Kept', rank: 3 };
  }
}

function KeepButton({ c, onPins }: { c: GuardContainerRow; onPins: (patch: GuardPinsPatch) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPins({ keep: { name: c.name, keep: !c.pinned } })}
      aria-pressed={c.pinned}
      title={c.pinned ? `${c.name} is pinned: the guard never stops it. Click to unpin.` : `Pin ${c.name} so the guard never stops it.`}
      className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap ${
        c.pinned ? 'border-ok bg-ok/15 text-ok hover:bg-ok/25' : 'border-border text-text hover:border-accent hover:bg-panel2'
      }`}
    >{c.pinned ? '✓ Pinned · unpin' : 'Pin to keep'}</button>
  );
}

function killLine(e: KillLogEntry): { what: string; why: string; dry: boolean } {
  const why = spellDurations((e.reason ?? '').replace(/^WOULD-STOP:\s*/, '').replace(/^memory critical — /, ''));
  if (e.kind === 'container') {
    return { what: e.dry ? `Practice run — would have stopped the container ${e.name}` : `Stopped the container ${e.name}`, why, dry: e.dry };
  }
  const folder = (e.projectDir ?? e.cwd ?? '').split('/').filter(Boolean).pop();
  const thing = `${e.family ?? e.name} run${folder ? ` in ${folder}` : ''}`;
  const who = e.by === 'memguard-system' ? 'The system memory watchdog' : 'The guard';
  return { what: e.dry ? `Practice run — ${who.toLowerCase()} would have stopped a ${thing}` : `${who} stopped a ${thing}`, why, dry: e.dry };
}

export default function GuardSection(p: {
  snap: GuardSnapshot | null;
  onPins: (patch: GuardPinsPatch) => void;
  layout: 'sidebar' | 'wide';
  // True when this app's preload (or main process) predates the guard.
  unavailable?: boolean;
}) {
  const { snap, onPins, layout, unavailable } = p;
  const [confirmLive, setConfirmLive] = useState(false);
  const [idleDraft, setIdleDraft] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const containers = snap?.containers ?? [];
  const counting = containers.some((c) => c.verdict === 'stopping');
  // A countdown needs a second hand; "since 09:38 (3 min)" does not.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), counting ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [counting]);
  const live = snap?.mode === 'live';
  useEffect(() => { if (live) setConfirmLive(false); }, [live]);

  if (!snap) {
    return (
      <div className="flex flex-col pb-1">
        <SectionLabel>Memory guard</SectionLabel>
        <div className="px-3 py-1 text-[11px] text-muted italic">
          {unavailable ? 'Restart Peers Flow to turn the memory guard on.' : 'Checking memory…'}
        </div>
      </div>
    );
  }

  const level: MemLevel = snap.level in GUARD_LEVEL_COLOR ? snap.level : 'unknown';
  const levelColor = GUARD_LEVEL_COLOR[level];
  const reasons = snap.reasons ?? [];
  const recent = snap.recent ?? [];
  const sample = snap.sample;
  const growth = snap.swapGrowthGBper5min;
  const sinceMin = Math.max(0, Math.floor((now - new Date(snap.levelSince).getTime()) / 60_000));
  const wide = layout === 'wide';

  const rows = containers
    .map((c) => ({ c, v: verdictView(c, live, now, recent) }))
    .sort((a, b) => a.v.rank - b.v.rank || a.c.name.localeCompare(b.c.name));
  const wouldStop = containers.filter((c) => c.verdict === 'stop-candidate' || c.verdict === 'stopping').length;
  const pinnedCount = containers.filter((c) => c.pinned).length;
  const stoppedCount = containers.filter((c) => c.verdict === 'stopped-by-guard').length;

  const idleValue = idleDraft ?? String(snap.idleMinutes);
  const idleParsed = /^\d+$/.test(idleValue.trim()) ? Number(idleValue.trim()) : NaN;
  const idleValid = Number.isFinite(idleParsed) && idleParsed >= 1 && idleParsed <= 10_080;
  const idleDirty = idleDraft !== null && idleParsed !== snap.idleMinutes;
  const saveIdle = () => {
    if (!idleValid || !idleDirty) return;
    onPins({ idleMinutes: idleParsed });
    setIdleDraft(null);
  };

  const sev = (v: number, warn: number, danger: number): PerfSeverity | undefined => (v > danger ? 'danger' : v > warn ? 'warning' : undefined);

  const status = (
    <>
      <div className="px-3 pt-1 flex flex-wrap items-center gap-1" role="list" aria-label="Memory level">
        {LADDER.map((s) => {
          const on = s.level === level;
          return (
            <span
              key={s.level}
              role="listitem"
              aria-current={on ? 'true' : undefined}
              className={`text-[10px] px-2 py-0.5 rounded border whitespace-nowrap ${on ? 'font-bold text-bg' : 'border-border text-subtle'}`}
              style={on ? { backgroundColor: GUARD_LEVEL_COLOR[s.level], borderColor: GUARD_LEVEL_COLOR[s.level] } : undefined}
            >{s.label}</span>
          );
        })}
        {level === 'unknown' && <span className="text-[10px] px-2 py-0.5 rounded border border-border text-muted whitespace-nowrap">Not measured yet</span>}
      </div>
      <div className="px-3 pt-1.5 text-[12px] leading-snug">
        <span className="font-semibold" style={{ color: levelColor }}>{GUARD_LEVEL_LONG[level]}</span>
        {hhmm(snap.levelSince) && <span className="text-muted"> · since {hhmm(snap.levelSince)} ({fmtDuration(sinceMin)})</span>}
      </div>
      <div className="px-3 pt-0.5 text-[11px] leading-snug text-text">{levelMeaning(level, live)}</div>
      {reasons.length > 0 && (
        <ul className="px-3 pt-1 flex flex-col gap-0.5">
          {reasons.map((r, i) => (
            <li key={i} className="text-[11px] leading-snug text-muted flex gap-1.5" title={r}>
              <span style={{ color: levelColor }} aria-hidden="true">•</span>
              <span>{plainReason(r)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="pt-1.5">
        <Row
          label="New sub-agents"
          value={snap.admissionClosed ? 'Asked to wait' : 'Allowed'}
          severity={snap.admissionClosed ? 'warning' : undefined}
          sub={snap.admissionClosed ? 'until memory clears' : undefined}
        />
        {sample ? (
          <>
            <Row
              label="Memory macOS is squeezing"
              value={gb(sample.compressedGB)}
              severity={sev(sample.compressedGB, TIGHT_SQUEEZED_GB, CRITICAL_SQUEEZED_GB)}
              sub={`tight above ${TIGHT_SQUEEZED_GB} · critical above ${CRITICAL_SQUEEZED_GB}`}
            />
            <Row
              label="Memory spilled onto disk"
              value={gb(sample.swapUsedGB)}
              severity={sample.swapUsedGB > TIGHT_SPILLED_GB ? 'warning' : undefined}
              sub={`tight above ${TIGHT_SPILLED_GB}`}
            />
            <Row
              label="Spill growth"
              value={growth === null || growth === undefined ? 'measuring…' : `${growth >= 0 ? '+' : '−'}${gb(Math.abs(growth))} / 5 min`}
              severity={typeof growth === 'number' && growth > CRITICAL_SPILL_GROWTH_GB ? 'danger' : undefined}
              sub={growth === null || growth === undefined ? 'needs 5 minutes of readings' : `critical above +${CRITICAL_SPILL_GROWTH_GB}`}
            />
            {sample.availGB !== null && <Row label="Free to use right now" value={gb(sample.availGB)} />}
          </>
        ) : (
          <div className="px-3 py-0.5 text-[11px] text-muted italic">No memory reading yet.</div>
        )}
      </div>
    </>
  );

  const controls = (
    <>
      <div className="px-3 pt-2 text-[10px] text-subtle mb-0.5">What the guard may do</div>
      <div className="px-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border overflow-hidden" role="radiogroup" aria-label="Guard mode">
          <button
            type="button"
            role="radio"
            aria-checked={!live}
            onClick={() => { setConfirmLive(false); if (live) onPins({ mode: 'dry-run' }); }}
            title="Practice mode: the guard only shows what it would stop."
            className={`px-2.5 py-1 text-[11px] font-medium whitespace-nowrap ${!live ? 'bg-accent text-bg' : 'text-muted hover:text-text hover:bg-panel2'}`}
          >Practice mode</button>
          <button
            type="button"
            role="radio"
            aria-checked={live}
            onClick={() => { if (!live) setConfirmLive(true); }}
            title="Live: the guard may stop idle containers when memory turns critical."
            className={`px-2.5 py-1 text-[11px] font-medium whitespace-nowrap border-l border-border ${live ? 'bg-accent text-bg' : 'text-muted hover:text-text hover:bg-panel2'}`}
          >Live</button>
        </div>
        <span className="text-[11px] font-semibold" style={{ color: live ? STOPPED_COLOR : KEPT_COLOR }}>
          {live ? 'Live — the guard may stop idle containers' : 'Practice mode (nothing is stopped)'}
        </span>
      </div>
      <div className="px-3 pt-1 text-[11px] leading-snug text-muted">
        {live
          ? 'When memory turns critical, the guard stops containers nobody has used for a while — never a pinned one, never one a chat is using. Nothing is deleted.'
          : 'The guard only watches and shows what it would stop. Switching to Live lets Peers Flow stop idle containers on its own when memory turns critical.'}
      </div>
      {confirmLive && !live && (
        <div className="mx-3 mt-1.5 rounded-md border-2 px-2.5 py-2" style={{ borderColor: STOPPED_COLOR, backgroundColor: 'rgba(255,120,71,0.10)' }} role="alertdialog" aria-label="Confirm Live mode">
          <div className="text-[11px] leading-snug text-text">
            <span className="font-semibold">Switch to Live?</span> From then on Peers Flow may stop idle containers by itself whenever memory turns critical
            {wouldStop > 0 ? ` — right now that would be ${wouldStop} of the ${containers.length} listed below` : ''}. Stopped containers are not deleted; each one comes back with <code className="font-mono">docker start</code>.
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => { setConfirmLive(false); onPins({ mode: 'live' }); }}
              className="text-[11px] font-semibold px-2.5 py-1 rounded border border-accent bg-accent text-bg hover:bg-accent2"
            >Yes, switch to Live</button>
            <button
              type="button"
              onClick={() => setConfirmLive(false)}
              className="text-[11px] font-semibold px-2.5 py-1 rounded border border-border text-text hover:border-accent hover:bg-panel2"
            >Stay in practice mode</button>
          </div>
        </div>
      )}
      <div className="px-3 pt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-text">
        <label htmlFor="guard-idle-minutes">A container counts as idle after</label>
        <input
          id="guard-idle-minutes"
          type="number"
          inputMode="numeric"
          min={1}
          max={10080}
          step={1}
          value={idleValue}
          onChange={(e) => setIdleDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveIdle(); else if (e.key === 'Escape' && idleDraft !== null) { e.stopPropagation(); setIdleDraft(null); } }}
          className={`w-16 px-1.5 py-0.5 rounded border bg-bg text-text font-mono text-[11px] outline-none focus:border-accent ${idleValid ? 'border-border' : 'border-err'}`}
          aria-invalid={!idleValid}
        />
        <span>minutes without use{idleValid ? ` (${fmtDuration(idleParsed)})` : ''}</span>
        {idleDirty && (
          <button
            type="button"
            onClick={saveIdle}
            disabled={!idleValid}
            className="text-[10px] font-semibold px-2 py-0.5 rounded border border-accent text-text hover:bg-panel2 disabled:opacity-40"
          >Save</button>
        )}
        {!idleValid && <span className="text-err">Enter whole minutes, 1 to 10080.</span>}
      </div>
    </>
  );

  const th = 'text-left font-normal text-[10px] uppercase tracking-wider text-subtle px-2 py-1 whitespace-nowrap';
  const containerList = (
    <>
      <SectionLabel>
        Containers · {containers.length}{wouldStop > 0 ? ` · ${wouldStop} would be stopped` : ''}{stoppedCount > 0 ? ` · ${stoppedCount} stopped by the guard` : ''}{pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}
      </SectionLabel>
      {rows.length === 0 ? (
        <div className="px-3 py-1 text-[11px] text-muted italic">No running containers found (or Docker is not running).</div>
      ) : (
        <>
          {/* A real table once there is room for nine columns; one block per
              container below that, so nothing scrolls sideways on a phone. */}
          {wide && (
            <div className="hidden md:block px-1">
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-border">
                    <th className={th}>Container</th>
                    <th className={th}>Project</th>
                    <th className={th}>State</th>
                    <th className={`${th} text-right`}>CPU</th>
                    <th className={`${th} text-right`}>Memory</th>
                    <th className={`${th} text-right`}>Connections</th>
                    <th className={`${th} text-right`}>Idle</th>
                    <th className={th}>What the guard does</th>
                    <th className={`${th} text-right`}>Keep</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ c, v }) => (
                    <tr key={c.name} className="border-b border-border/40 last:border-b-0 align-top">
                      <td className="px-2 py-1 font-mono text-text break-all">{c.name}</td>
                      <td className="px-2 py-1 text-muted break-all" title={c.projectDir ?? undefined}>{c.project ?? '–'}</td>
                      <td className="px-2 py-1 whitespace-nowrap" style={{ color: c.running ? KEPT_COLOR : STOPPED_COLOR }}>{c.running ? 'Running' : 'Stopped'}</td>
                      <td className="px-2 py-1 font-mono text-text text-right whitespace-nowrap">{c.cpuPct === null ? '–' : `${c.cpuPct}%`}</td>
                      <td className="px-2 py-1 font-mono text-text text-right whitespace-nowrap">{fmtMem(c.memMB)}</td>
                      <td className="px-2 py-1 font-mono text-text text-right whitespace-nowrap">{c.running ? c.establishedConns : '–'}</td>
                      <td className="px-2 py-1 font-mono text-text text-right whitespace-nowrap">{c.idleMinutes === null ? '–' : fmtDuration(c.idleMinutes)}</td>
                      <td className="px-2 py-1 leading-snug" title={c.note || undefined}>
                        <span className="font-semibold" style={{ color: v.color }}>{v.text}</span>
                        {v.sub && <span className="text-muted"> · {v.sub}</span>}
                      </td>
                      <td className="px-2 py-1 text-right"><KeepButton c={c} onPins={onPins} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className={`flex flex-col ${wide ? 'md:hidden' : ''}`}>
            {rows.map(({ c, v }) => (
              <div key={c.name} className="px-3 py-1.5 border-t border-border/40 first:border-t-0">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[11px] font-mono text-text break-all min-w-0">
                    {c.name}
                    {c.project && <span className="text-subtle font-sans" title={c.projectDir ?? undefined}> · {c.project}</span>}
                  </span>
                  <KeepButton c={c} onPins={onPins} />
                </div>
                <div className="text-[11px] leading-snug mt-0.5" title={c.note || undefined}>
                  <span className="font-semibold" style={{ color: v.color }}>{v.text}</span>
                  {v.sub && <span className="text-muted"> · {v.sub}</span>}
                </div>
                <div className="text-[10px] font-mono text-muted mt-0.5">
                  <span style={{ color: c.running ? KEPT_COLOR : STOPPED_COLOR }}>{c.running ? 'Running' : 'Stopped'}</span>
                  {c.cpuPct !== null && ` · CPU ${c.cpuPct}%`}
                  {c.memMB !== null && ` · ${fmtMem(c.memMB)}`}
                  {c.running && ` · ${c.establishedConns} connection${c.establishedConns === 1 ? '' : 's'}`}
                  {c.idleMinutes !== null && ` · idle ${fmtDuration(c.idleMinutes)}`}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );

  const stops = (
    <>
      <SectionLabel>Recent stops</SectionLabel>
      {recent.length === 0 ? (
        <div className="px-3 py-1 text-[11px] text-muted italic">Nothing has been stopped to free memory.</div>
      ) : (
        <div className="px-3">
          {recent.slice(0, 6).map((e, i) => {
            const k = killLine(e);
            return (
              <div key={`${e.at}-${i}`} className="flex items-baseline gap-2 py-px text-[11px] leading-snug">
                <span className="font-mono text-subtle shrink-0">{when(e.at)}</span>
                <span className="min-w-0">
                  <span className={k.dry ? 'text-muted' : 'text-text'}>{k.what}</span>
                  {k.why && <span className="text-subtle"> — {k.why}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  return (
    <div className="flex flex-col pb-1">
      <SectionLabel>
        Memory guard · <span style={{ color: live ? STOPPED_COLOR : undefined }}>{live ? 'Live' : 'Practice mode (nothing is stopped)'}</span>
      </SectionLabel>
      {wide ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-2 px-1">
          <div className="min-w-0 md:border-r md:border-border/40 pb-1">{status}</div>
          <div className="min-w-0 pb-1">{controls}{stops}</div>
        </div>
      ) : (
        <>
          {status}
          {controls}
        </>
      )}
      {containerList}
      {!wide && stops}
    </div>
  );
}
