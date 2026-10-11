import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import { CONTRACT_COLOR, CONTRACT_GLYPH, CONTRACT_LABEL, CONTRACT_STOP_HINT, CONTRACT_STOP_LABEL, KEEPER_TICK_COLOR } from '../lib/contract';
import type { ContractSource, KeeperCause, KeeperDeferredItem, KeeperItem, KeeperRecent, KeeperSnapshot } from '../../shared/types';

// A persisted boolean keyed in localStorage. Starts at `fallback` to avoid an
// SSR/first-paint flash, then hydrates on mount. (Mirrors UsagePanel's helper.)
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

const REFRESH_MS = 15_000;
// The card is a glance, not a log: the last few actions only.
const RECENT_SHOWN = 5;

// One colour per kind of row, the same ones the header badge uses.
const KEPT_COLOR = KEEPER_TICK_COLOR; // teal
const STALLED_COLOR = '#fbbf24'; // warn
const MEMORY_COLOR = '#ff7847'; // accent
const IDLE_COLOR = '#8c93a8'; // subtle
const OK_COLOR = '#4ade80';
const ERR_COLOR = '#ef4444';

const CAUSE_LABEL: Record<KeeperCause, string> = {
  'stopped-short': 'stopped short',
  'daemon-dead': 'had died',
  'memory-deferred': 'memory freed up',
  'killed-workload': 'its work was stopped to save memory',
  'rate-limit': 'hit a usage limit',
};

const SOURCE_LABEL: Record<ContractSource, string> = {
  chip: 'you picked it',
  skill: 'set by the skill it runs',
  inferred: 'worked out from what the chat is doing',
  default: 'the default',
};

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

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function folderName(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

/**
 * The Keeper's latest picture, read on mount, every 15 s while the card is
 * open, and whenever the main process pushes a new one.
 *
 * Both calls are optional on the api: a running app whose preload predates the
 * Keeper has neither, and the card then says so instead of throwing. Reads are
 * numbered so a slow reply cannot overwrite a newer push.
 */
function useKeeperSnapshot(open: boolean) {
  const [snap, setSnap] = useState<KeeperSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const seq = useRef(0);

  // Declared before the loading effects on purpose: effects run in source
  // order, so a remount (React strict mode unmounts and remounts) must flip
  // this back to true before anything that guards on it loads.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    let pending: Promise<KeeperSnapshot> | undefined;
    try {
      pending = api().getKeeperSnapshot?.();
    } catch {
      pending = undefined;
    }
    if (!pending) {
      if (mounted.current) setUnavailable(true);
      return;
    }
    try {
      const next = await pending;
      if (!mounted.current || mine !== seq.current) return;
      setSnap(next);
      setUnavailable(false);
      setFailed(false);
    } catch {
      if (!mounted.current || mine !== seq.current) return;
      setFailed(true);
    }
  }, []);

  // Once on mount whatever the fold state: the header badge is the whole card
  // when it is closed.
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!open || unavailable) return;
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, unavailable, load]);

  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = api().onKeeperUpdated?.((next) => {
        if (!mounted.current || !next) return;
        seq.current++;
        setSnap(next);
        setUnavailable(false);
        setFailed(false);
      });
    } catch { /* an older preload: the timer above is all there is */ }
    return () => off?.();
  }, []);

  return { snap, unavailable, failed };
}

// A banded sub-header over a full-strength divider, the same band the provider
// sections inside Usage and Accounts use, so each kind of row reads as its own
// zone.
function Section({ label, color, count, children }: { label: string; color: string; count: number; children: ReactNode }) {
  return (
    <div className="border-t border-border first:border-t-0">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-panel2/35">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden="true" />
        <span className="text-[11px] font-semibold text-text truncate">{label}</span>
        <span className="ml-auto shrink-0 text-[10px] font-mono" style={{ color }}>{count}</span>
      </div>
      <div className="border-t border-border/60 py-1">{children}</div>
    </div>
  );
}

function ContractGlyph({ item }: { item: Pick<KeeperItem, 'contract' | 'contractSource'> }) {
  return (
    <span
      className="shrink-0 w-4 text-center text-[12px] font-semibold"
      style={{ color: CONTRACT_COLOR[item.contract] }}
      title={`${CONTRACT_LABEL[item.contract]} — ${SOURCE_LABEL[item.contractSource] ?? ''}`}
    >
      {CONTRACT_GLYPH[item.contract]}
    </span>
  );
}

// One chat: what it is, whose it is, what the Keeper last did about it.
function ItemRow({ item, color }: { item: KeeperItem; color: string }) {
  const nudged = ago(item.lastNudgeAt);
  const cause = item.lastNudgeReason ? CAUSE_LABEL[item.lastNudgeReason] : '';
  const stalled = item.status === 'stalled';
  return (
    <div className="px-3 py-1.5">
      <div className="flex items-baseline gap-1.5 min-w-0">
        <ContractGlyph item={item} />
        <span className="text-[12px] text-text truncate flex-1 min-w-0" title={item.title}>{item.title || 'Untitled chat'}</span>
        {/* The one control the app keeps: letting go. Starting is done from
            inside the chat with /until-done or /forever. */}
        <button
          onClick={() => { void api().setConversationContract?.(item.conversationId, 'once'); }}
          className="shrink-0 text-[10px] font-semibold leading-none px-1.5 py-1 rounded border border-border text-text hover:border-err hover:text-err hover:bg-err/10"
          title={CONTRACT_STOP_HINT}
          aria-label={`${CONTRACT_STOP_LABEL}: ${item.title}`}
        >
          Stop
        </button>
      </div>
      <div className="pl-[22px] text-[11px] leading-snug">
        <span className="font-medium text-text">{item.peer}</span>
        {item.status === 'relaunching' && <span style={{ color }}> · starting it again</span>}
        {item.detail && (
          <span style={{ color: stalled ? color : undefined }} className={stalled ? '' : 'text-muted'}>
            {' · '}{stalled ? `Needs you: ${item.detail}` : item.detail}
          </span>
        )}
      </div>
      {/* A chat the Keeper is leaving alone has no nudges to count. */}
      {!stalled && (
        <div className="pl-[22px] mt-0.5 text-[10px] text-muted">
          {nudged ? `last nudged ${nudged}${cause ? ` (${cause})` : ''} · ` : ''}
          <span className={item.nudgesLeftThisHour <= 1 ? 'text-warn' : ''}>
            {plural(Math.max(0, item.nudgesLeftThisHour), 'nudge', 'nudges')} left this hour
          </span>
        </div>
      )}
    </div>
  );
}

// A step that was held back because the machine was short on memory. The
// Keeper tells the chat to retry it once there is room again.
function DeferredRow({ item }: { item: KeeperDeferredItem }) {
  return (
    <div className="px-3 py-1.5">
      <div className="text-[12px] text-text truncate" title={item.title ?? undefined}>
        {item.title || `A chat in ${folderName(item.cwd)}`}
      </div>
      <div className="text-[11px] leading-snug text-muted">
        <span className="font-medium text-text">{item.what}</span>
        {' · held back '}{ago(item.at)}
      </div>
      <div className="mt-0.5 text-[10px]" style={{ color: MEMORY_COLOR }}>
        {item.waitingFor === 'memory' ? 'Retries when memory frees up' : 'Retries when the chat is idle'}
      </div>
    </div>
  );
}

function RecentRow({ entry }: { entry: KeeperRecent }) {
  return (
    <div className="px-3 py-1 flex items-baseline gap-1.5 min-w-0">
      <span className="shrink-0 w-4 text-center text-[11px] font-semibold" style={{ color: entry.ok ? OK_COLOR : ERR_COLOR }} title={entry.ok ? 'Worked' : 'Did not work'}>
        {entry.ok ? '✓' : '✕'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-text truncate" title={entry.title}>{entry.title || 'Untitled chat'}</div>
        <div className="text-[10px] text-muted leading-snug">{ago(entry.at)} — {entry.detail || CAUSE_LABEL[entry.cause]}</div>
      </div>
    </div>
  );
}

// The Keeper's sidebar card: which chats are being kept alive, which the Keeper
// is deliberately leaving alone, and what is waiting on memory. Same docked-card
// shape as Usage / Accounts / Notes so the sidebar's sections read alike.
export default function KeeperPanel(): JSX.Element {
  const [open, setOpen] = usePersistedBool('agentsflow:keeper:open', true);
  const { snap, unavailable, failed } = useKeeperSnapshot(open);

  const items = snap?.items ?? [];
  const kept = items.filter((i) => i.status === 'kept-alive' || i.status === 'relaunching');
  const stalled = items.filter((i) => i.status === 'stalled');
  const waiting = items.filter((i) => i.status === 'waiting-memory');
  const idle = items.filter((i) => i.status === 'idle');
  const deferred = snap?.deferred ?? [];
  const recent = (snap?.recent ?? []).slice(0, RECENT_SHOWN);
  const waitingCount = waiting.length + deferred.length;

  // With the card folded shut this is all there is, so it carries the counts
  // that matter, each in its own colour; stalled is the one that needs the user.
  const badge: Array<{ text: string; color: string }> = [];
  if (snap?.paused) badge.push({ text: 'paused', color: STALLED_COLOR });
  else if (snap && !snap.enabled) badge.push({ text: 'off', color: IDLE_COLOR });
  if (kept.length) badge.push({ text: `${kept.length} kept`, color: KEPT_COLOR });
  if (stalled.length) badge.push({ text: `${stalled.length} stalled`, color: STALLED_COLOR });
  if (waitingCount) badge.push({ text: `${waitingCount} waiting`, color: MEMORY_COLOR });

  const nothing = !items.length && !deferred.length && !recent.length;

  return (
    <div data-open={open ? '1' : '0'} className="shrink-0 rounded-lg border border-border bg-panel overflow-hidden flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-2 py-2 bg-panel2/60 hover:bg-panel2">
        <span className="w-1 h-4 rounded-full shrink-0" style={{ backgroundColor: KEEPER_TICK_COLOR }} aria-hidden="true" />
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left" title={open ? 'Hide the Keeper' : 'Show the chats the Keeper is keeping alive'}>
          <span className="text-muted text-[10px] w-3 shrink-0">{open ? '▼' : '▶'}</span>
          <span className="text-[11px] uppercase tracking-wider text-text font-semibold">Keeper</span>
          {badge.length > 0 && (
            <span className="ml-auto text-[10px] font-mono shrink-0" title={snap?.paused ? `Paused — ${snap.paused}` : 'Chats the Keeper is looking after'}>
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
      {/* Same budget rule as Usage: its own cap AND the docked cluster's measured
          budget when there is one (see DockedPanes). */}
      {open && <div className="flex-1 min-h-0 overflow-y-auto border-t border-border/60" style={{ maxHeight: 'min(300px, 30vh, var(--dock-body-max, 100vh))' }}>
        {unavailable ? <div className="px-3 py-2 text-[11px] text-muted italic">Restart Peers Flow to turn the Keeper on.</div>
          : !snap ? <div className="px-3 py-2 text-[11px] text-muted">{failed ? 'Could not reach the Keeper.' : 'Checking on your chats…'}</div>
          : <>
            {snap.paused && (
              <div className="px-3 py-1.5 text-[11px] font-medium border-b border-border" style={{ color: STALLED_COLOR }}>
                Paused — {snap.paused}
              </div>
            )}
            {nothing && (
              <div className="px-3 py-2 text-[11px] text-muted">
                {snap.enabled
                  ? 'Nothing to keep alive. Type /until-done or /forever in a chat and it shows up here.'
                  : 'The Keeper is off.'}
              </div>
            )}
            {kept.length > 0 && (
              <Section label="Keeping alive" color={KEPT_COLOR} count={kept.length}>
                {kept.map((item) => <ItemRow key={item.conversationId} item={item} color={KEPT_COLOR} />)}
              </Section>
            )}
            {stalled.length > 0 && (
              <Section label="Waiting for you" color={STALLED_COLOR} count={stalled.length}>
                {stalled.map((item) => <ItemRow key={item.conversationId} item={item} color={STALLED_COLOR} />)}
              </Section>
            )}
            {waitingCount > 0 && (
              <Section label="Waiting for memory" color={MEMORY_COLOR} count={waitingCount}>
                {waiting.map((item) => <ItemRow key={item.conversationId} item={item} color={MEMORY_COLOR} />)}
                {deferred.map((item) => <DeferredRow key={item.file} item={item} />)}
              </Section>
            )}
            {idle.length > 0 && (
              <Section label="Watching" color={IDLE_COLOR} count={idle.length}>
                {idle.map((item) => <ItemRow key={item.conversationId} item={item} color={IDLE_COLOR} />)}
              </Section>
            )}
            {recent.length > 0 && (
              <Section label="Recently" color={IDLE_COLOR} count={recent.length}>
                {recent.map((entry, i) => <RecentRow key={`${entry.at}-${entry.conversationId}-${i}`} entry={entry} />)}
              </Section>
            )}
          </>}
      </div>}
    </div>
  );
}
