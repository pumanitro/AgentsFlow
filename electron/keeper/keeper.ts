// The Keeper: the loop that holds a chat to its run contract.
//
// A chat started "Until done" or "Forever" should not sit idle because its turn
// happened to end, its daemon died, a spawn was refused for memory, or the
// memory guard stopped something under it. Every KEEPER_TICK_MS this gathers
// the facts for each such chat, asks keeper-policy.ts what to do, and performs
// at most ONE nudge or relaunch per pass (the limit-watch rule: never a burst
// of attach PTYs).
//
// Why a loop in the main process, and not a "keep going" instruction inside the
// chat: every in-chat retry dies with the chat. A turn that ends, a daemon the
// reaper stopped, a machine that froze at 09:49 — whatever was supposed to
// retry is gone with it. This is the one owner of "retry" that outlives every
// chat, and so it is also the ONLY thing allowed to nudge (limit-watch aside,
// which owns rate limits because a nudge there is useless before an account
// switch). Two owners is how a chat gets "continue" typed into it twice.
//
// What it will not do matters as much:
//   - type into a chat that is waiting for the user (it badges it "stalled"
//     and notifies once per distinct stall instead);
//   - act while every account is at its limit (the snapshot says "paused";
//     stalled badges still update, because those cost nothing);
//   - call a daemon dead on a stale process list, or on a single listing;
//   - keep alive a chat the user has put away (unpinned and settled — in this
//     app unpinning means "done", the same line limit-watch draws).
//
// Everything it needs from the app arrives through KeeperDeps, wired in
// main.ts, so the loop can be driven by tests with no Electron in sight.

import type { Conversation, DeferredMarker, KeeperCause, KeeperConvState, KeeperDeferredItem, KeeperItem, KeeperRecent, KeeperSnapshot, KillLogEntry, MemLevel, RunContract } from '../../shared/types';
import type { ClaudeAgentJsonRow } from '../claude-cli';
import { findLiveRow } from '../derive-state';
import { inferContract } from './contract-infer';
import { consumeDeferredMarker, listDeferredMarkers } from './deferred-markers';
import {
  KEEPER_TICK_MS, LIVE_ROWS_FRESH_MS, MAX_NUDGES_PER_HOUR, NUDGE_COOLDOWN_MS,
  decide, hhmm, isIdle, lastNudgeMs, nudgesLeft,
  type ChatFacts, type KeeperDecision,
} from './keeper-policy';
import { DEFERRED_TTL_MS } from './paths';
import { forgetTranscriptSignals, readTranscriptSignals, type TranscriptSignals } from './transcript-signals';

export interface KeeperDeps {
  getConversations: () => Conversation[];
  getConversation: (id: string) => Conversation | null;
  updateConversation: (id: string, patch: Partial<Conversation>) => void;        // persists AND pushes 'conversations:patched'
  liveRows: () => { rows: ClaudeAgentJsonRow[]; at: number };
  jobQuietAt: (conv: Conversation) => number;                                   // jobStateMtimeMs(conv.daemonShort, conv.host), 0 unknown
  isWalled: (conv: Conversation) => boolean;                                    // limitWatch.readLimitHit(conv) !== null
  poolHasHeadroom: () => Promise<boolean>;                                       // false ⇒ snapshot.paused, no nudges
  memLevel: () => MemLevel;                                                      // guard.getMemLevel()
  readKillsSince: (offset: number) => { entries: KillLogEntry[]; offset: number }; // guard/kill-log.readKillLogSince
  nudge: (conv: Conversation, text: string) => Promise<{ ok: boolean; error?: string }>;
  relaunch: (conv: Conversation, prompt: string) => Promise<{ ok: boolean; daemonShort?: string; error?: string }>;
  notify: (title: string, body: string) => void;
  onSnapshot: (s: KeeperSnapshot) => void;
  now?: () => number;
  readSignals?: typeof readTranscriptSignals;                                    // injected in tests
  /** false ⇒ a chat is only ever held to a contract somebody declared (the /until-done and /forever skills); nothing is read off the transcript. Default true. */
  inferContracts?: boolean;
  deferredDir?: string;                                                          // defaults to DEFERRED_DIR; injected in tests
}

// What "paused" says while no account has room: nudging then only spends the
// attempt budget re-hitting the same wall.
export const PAUSED_NO_HEADROOM = 'every account is at its limit';

// A stopped workload nobody could be told about within this long is history.
const KILL_TTL_MS = DEFERRED_TTL_MS;
const HOUR_MS = 60 * 60_000;
const MAX_RECENT = 20;
// A chat this young may simply not be in the process list yet.
const SPAWN_GRACE_MS = 120_000;
// How long after a relaunch the card keeps saying "restarting" for a chat that
// has not shown up in the process list yet.
const RELAUNCH_SHOWN_MS = 2 * 60_000;

// In this app an unpinned conversation means done (see store.ts), so
// pinned-or-not-yet-settled is the line — the same one limit-watch draws.
const SETTLED_STATES = new Set(['done', 'completed', 'failed', 'error', 'stopped']);

let timer: NodeJS.Timeout | null = null;
let running = false;
let enabled = false;

// First tick a live row read idle; cleared the moment it is busy or gone.
const idleSince = new Map<string, number>();
// Consecutive FRESH listings without a row. `at` is the listing that was last
// counted, so two ticks over the same listing count once.
const deadTicks = new Map<string, { n: number; at: number }>();
// One notification per distinct stall text.
const notifiedStall = new Map<string, string>();

let killOffset = 0;
let killLogPrimed = false;
// Read from the kill log, not yet matched to a chat. `backlog` marks entries
// that predate this process (first read): those may already have been told.
let unattributedKills: Array<{ entry: KillLogEntry; backlog: boolean }> = [];
const pendingKills = new Map<string, KillLogEntry[]>();

let recent: KeeperRecent[] = [];
let snapshot: KeeperSnapshot = emptySnapshot();
let snapshotKey = '';

function emptySnapshot(): KeeperSnapshot {
  return { at: new Date().toISOString(), enabled, paused: null, items: [], deferred: [], recent: [] };
}

// ---------------------------------------------------------------------------
// Which chats the Keeper looks at
// ---------------------------------------------------------------------------

/** Local Claude chats the user has not put away. Codex and remote peers are excluded, as in limit-watch. */
export function isKeepable(conv: Conversation): boolean {
  if (conv.provider === 'codex' || conv.host || !conv.sessionId) return false;
  if (conv.pinned) return true;
  return !SETTLED_STATES.has((conv.state || '').toLowerCase());
}

function isArmed(contract: RunContract | undefined): boolean {
  return contract === 'until-done' || contract === 'forever';
}

// ---------------------------------------------------------------------------
// Kill attribution
// ---------------------------------------------------------------------------

function within(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const c = child.replace(/\/+$/, '');
  const p = parent.replace(/\/+$/, '');
  return c === p || c.startsWith(p + '/');
}

function ownsSession(conv: Conversation, sessionId: string): boolean {
  if (!sessionId) return false;
  if (conv.sessionId === sessionId) return true;
  return !!conv.daemonShort && sessionId.startsWith(conv.daemonShort);
}

/**
 * Which chat a stopped workload belonged to: the session the entry names; else
 * the session of the claude process it ran under; else the most recent
 * unsettled chat working in that directory. Null when nobody can be named.
 */
export function attributeKill(entry: KillLogEntry, convs: Conversation[], rows: ClaudeAgentJsonRow[]): Conversation | null {
  const local = convs.filter((c) => c.provider !== 'codex' && !c.host && !!c.sessionId);
  if (entry.sessionId) {
    const bySession = local.find((c) => ownsSession(c, entry.sessionId!));
    if (bySession) return bySession;
  }
  if (entry.claudePid) {
    const row = rows.find((r) => r.pid === entry.claudePid);
    if (row) {
      const byPid = local.find((c) => ownsSession(c, row.sessionId));
      if (byPid) return byPid;
    }
  }
  const dir = entry.projectDir || entry.cwd;
  if (dir) {
    const inDir = local
      .filter((c) => within(dir, c.worktreePath ?? c.directoryPath))
      .filter((c) => !SETTLED_STATES.has((c.state || '').toLowerCase()) || !!findLiveRow(c, rows));
    inDir.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
    if (inDir.length > 0) return inDir[0];
  }
  return null;
}

function ingestKills(deps: KeeperDeps, convs: Conversation[], rows: ClaudeAgentJsonRow[], now: number): void {
  try {
    const read = deps.readKillsSince(killOffset);
    // A log that shrank (rotated, truncated) is re-read from the top by the
    // reader, so what comes back is a replay — the same case as a first read.
    const replay = !killLogPrimed || read.offset < killOffset;
    killOffset = read.offset;
    for (const entry of read.entries) {
      // A dry-run entry is a WOULD-STOP: nothing was stopped, so there is
      // nothing to tell the chat to rerun.
      if (entry.dry) continue;
      unattributedKills.push({ entry, backlog: replay });
    }
    killLogPrimed = true;
  } catch {
    /* an unreadable kill log is not a reason to skip the pass */
  }
  const fresh = (e: KillLogEntry): boolean => {
    const at = Date.parse(e.at);
    return Number.isFinite(at) && now - at <= KILL_TTL_MS;
  };
  const still: typeof unattributedKills = [];
  for (const item of unattributedKills) {
    if (!fresh(item.entry)) continue;
    const conv = attributeKill(item.entry, convs, rows);
    if (!conv) { still.push(item); continue; }
    // The offset is not persisted, so the first read after a launch replays
    // the log. An entry older than this chat's last nudge was already handled
    // (or overtaken) by the process before us.
    if (item.backlog && lastNudgeMs(conv.keeper) >= Date.parse(item.entry.at)) continue;
    const list = pendingKills.get(conv.id) ?? [];
    list.push(item.entry);
    pendingKills.set(conv.id, list);
  }
  unattributedKills = still;
  for (const [id, list] of Array.from(pendingKills.entries())) {
    const kept = list.filter(fresh);
    if (kept.length === 0) pendingKills.delete(id);
    else if (kept.length !== list.length) pendingKills.set(id, kept);
  }
}

// ---------------------------------------------------------------------------
// conv.keeper: written only when it actually changes
// ---------------------------------------------------------------------------

function canon(k: KeeperConvState | undefined): string {
  return JSON.stringify({
    nudgesAt: k?.nudgesAt ?? [],
    lastNudgeAt: k?.lastNudgeAt ?? null,
    lastNudgeReason: k?.lastNudgeReason ?? null,
    stalled: k?.stalled ?? null,
    keptAlive: !!k?.keptAlive,
    completedAt: k?.completedAt ?? null,
  });
}

function pruned(k: KeeperConvState | undefined, now: number): KeeperConvState {
  return { ...(k ?? {}), nudgesAt: (k?.nudgesAt ?? []).filter((at) => Number.isFinite(at) && now - at < HOUR_MS) };
}

/** Returns the state now on the row (the new one if it was written, the old one otherwise). */
function persist(deps: KeeperDeps, id: string, prev: KeeperConvState | undefined, next: KeeperConvState): KeeperConvState | undefined {
  if (canon(prev) === canon(next)) return prev;
  try {
    deps.updateConversation(id, { keeper: next });
  } catch (err) {
    console.warn('[agentsflow][keeper] could not save a chat\'s keeper state', { id, error: (err as Error)?.message ?? err });
    return prev;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Words for the card
// ---------------------------------------------------------------------------

function stallText(why: string, liveRow: ClaudeAgentJsonRow | null, signals: TranscriptSignals | null): string {
  if (why === 'question') {
    return signals?.lastAssistantAt ? `asked you a question at ${hhmm(signals.lastAssistantAt)}` : 'asked you a question';
  }
  if (why === 'waiting') {
    const what = (liveRow?.waitingFor || '').trim();
    return what ? `waiting for you (${what})` : 'waiting for your input';
  }
  return 'needs your answer to carry on';
}

function detailFor(t: Tracked, memLevel: MemLevel, now: number, paused: string | null): string {
  const d = t.decision;
  if (d.action === 'stalled') return t.stall ?? 'waiting for you';
  if (d.action === 'completed') return 'said it has finished';
  if (paused && (d.action === 'relaunch' || d.action === 'nudge')) return `on hold — ${paused}`;
  if (d.action === 'relaunch') return 'not running — restarting it in the background';
  if (d.action === 'nudge') {
    if (d.cause === 'memory-deferred') return 'memory is free again — telling it to retry the step that was put off';
    if (d.cause === 'killed-workload') return 'something it was running got stopped to save memory — telling it to rerun';
    return 'stopped early — telling it to continue';
  }
  if (t.deferred.length > 0 && memLevel !== 'ok') return 'waiting for memory to free up before retrying a step';
  switch (d.why) {
    case 'busy': return 'working';
    case 'walled': return 'at the usage limit — the account switcher handles this one';
    case 'cap':
      return nudgesLeft(t.keeper, now) <= 0
        ? `nudged ${MAX_NUDGES_PER_HOUR} times in the last hour — giving it a rest`
        : `nudged at ${hhmm(lastNudgeMs(t.keeper))} — waiting ${Math.round(NUDGE_COOLDOWN_MS / 60_000)} minutes before another`;
    case 'rows-stale': return 'not running — waiting for a fresh process list before restarting it';
    case 'dead-unconfirmed': return 'not running — making sure before restarting it';
    case 'no-transcript': return 'not running — nothing to restart it from yet';
    case 'scheduled-wakeup': return 'asleep until its own timer wakes it';
    case 'idle-unconfirmed': return 'just went quiet — checking it has really stopped';
    case 'once': return t.deferred.length + t.kills.length > 0 ? 'will be told to retry when it goes quiet' : 'runs once';
    default: return 'running';
  }
}

function statusFor(t: Tracked, memLevel: MemLevel, now: number): KeeperItem['status'] {
  const d = t.decision;
  if (d.action === 'stalled') return 'stalled';
  if (t.deferred.length > 0 && memLevel !== 'ok') return 'waiting-memory';
  if (d.action === 'relaunch') return 'relaunching';
  if (!t.liveRow && isArmed(t.contract)) {
    if (d.action === 'none' && (d.why === 'rows-stale' || d.why === 'dead-unconfirmed')) return 'relaunching';
    if (t.keeper?.lastNudgeReason === 'daemon-dead' && now - lastNudgeMs(t.keeper) < RELAUNCH_SHOWN_MS) return 'relaunching';
  }
  if (!isArmed(t.contract)) return 'idle';
  if (d.action === 'none' && (d.why === 'scheduled-wakeup' || d.why === 'no-transcript')) return 'idle';
  return 'kept-alive';
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

interface Tracked {
  conv: Conversation;
  /** conv.keeper as it is on the row (before any re-arm in this pass). */
  stored: KeeperConvState | undefined;
  contract: RunContract | undefined;
  keeper: KeeperConvState | undefined;
  liveRow: ClaudeAgentJsonRow | null;
  signals: TranscriptSignals | null;
  deferred: Array<{ file: string; marker: DeferredMarker }>;
  kills: KillLogEntry[];
  decision: KeeperDecision;
  stall: string | null;
}

function pushRecent(entry: KeeperRecent): void {
  recent = [entry, ...recent].slice(0, MAX_RECENT);
}

/**
 * One pass. Never throws; at most one nudge/relaunch per pass.
 *
 * Exported so the guards — the cap, the cooldown, "never type over a question",
 * "one action per pass" — are testable without timers, which is the whole risk
 * surface of something that types into sessions unattended.
 */
export async function runKeeperOnce(deps: KeeperDeps): Promise<void> {
  if (running) return;
  running = true;
  enabled = true;
  try {
    await pass(deps);
  } catch (err) {
    console.warn('[agentsflow][keeper] pass failed', { error: (err as Error)?.message ?? err });
  } finally {
    running = false;
  }
}

async function pass(deps: KeeperDeps): Promise<void> {
  // Asked first: it is the only await before the decisions, and everything
  // read after it is then current for the whole synchronous part of the pass.
  let headroom = true;
  try { headroom = await deps.poolHasHeadroom(); } catch { headroom = true; }
  const paused = headroom ? null : PAUSED_NO_HEADROOM;

  const now = (deps.now ?? Date.now)();
  const all = deps.getConversations();
  const listing = deps.liveRows();
  const rows = listing.rows ?? [];
  // `at` is 0 until a first listing has been seen — never fresh.
  const rowsFresh = listing.at > 0 && now - listing.at <= LIVE_ROWS_FRESH_MS;
  const memLevel = deps.memLevel();
  const readSignals = deps.readSignals ?? readTranscriptSignals;

  ingestKills(deps, all, rows, now);
  const markers = listDeferredMarkers(deps.deferredDir, now);

  const tracked: Tracked[] = [];
  const followed = new Set<string>();
  for (const conv0 of all) {
    if (!isKeepable(conv0)) continue;
    let conv = conv0;
    const liveRow = findLiveRow(conv, rows) ?? null;
    const deferred = markers.filter((m) => ownsSession(conv, m.marker.sessionId));
    const kills = pendingKills.get(conv.id) ?? [];
    const hasPending = deferred.length > 0 || kills.length > 0;
    // Worth a transcript read: a chat under a contract, one owed a retry, or a
    // running chat nobody gave a contract to (it may be visibly looping).
    if (!isArmed(conv.contract) && !hasPending && !(conv.contract === undefined && liveRow)) continue;
    followed.add(conv.id);

    let signals: TranscriptSignals | null = null;
    try { signals = readSignals(conv); } catch { signals = null; }

    // A contract nobody picked, read off what the session is visibly doing.
    // Written once: from here on the row has a contract and is never inferred again.
    if (deps.inferContracts !== false && conv.contract === undefined && liveRow && signals) {
      const inferred = inferContract(signals);
      if (inferred) {
        console.log('[agentsflow][keeper] inferred a run contract', { title: conv.title, contract: inferred });
        try { deps.updateConversation(conv.id, { contract: inferred, contractSource: 'inferred' }); } catch { /* retried next tick */ }
        conv = { ...conv, contract: inferred, contractSource: 'inferred' };
      }
    }
    const armed = isArmed(conv.contract);
    if (!armed && !hasPending) continue;

    // --- bookkeeping -----------------------------------------------------
    if (liveRow && isIdle({ conv, liveRow })) {
      if (!idleSince.has(conv.id)) idleSince.set(conv.id, now);
    } else {
      idleSince.delete(conv.id);
    }
    if (liveRow) {
      deadTicks.delete(conv.id);
    } else if (rowsFresh) {
      const age = now - (Date.parse(conv.createdAt) || 0);
      const booting = (conv.state || '').toLowerCase() === 'starting' || age < SPAWN_GRACE_MS;
      const prior = deadTicks.get(conv.id);
      if (booting) deadTicks.delete(conv.id);
      else if (!prior) deadTicks.set(conv.id, { n: 1, at: listing.at });
      else if (prior.at !== listing.at) deadTicks.set(conv.id, { n: prior.n + 1, at: listing.at });
    }
    let idleSinceMs: number | null = idleSince.get(conv.id) ?? null;
    if (idleSinceMs !== null) {
      // The daemon's state.json mtime is when it last did anything. A short
      // turn that started and ended between two ticks never shows as busy;
      // this is what keeps it from being counted as one long idle stretch.
      let quietAt = 0;
      try { quietAt = deps.jobQuietAt(conv) || 0; } catch { quietAt = 0; }
      if (quietAt > idleSinceMs && quietAt <= now) idleSinceMs = quietAt;
    }

    // --- re-arm ----------------------------------------------------------
    // "Until done" stays finished until the chat does more work: an assistant
    // turn newer than completedAt means somebody started it again (the Keeper
    // itself never nudges a completed chat), so the finish line is ahead of it
    // once more. Forever has no finish line at all.
    let keeper = conv.keeper;
    if (keeper?.completedAt) {
      const doneAt = Date.parse(keeper.completedAt);
      const workedSince = !!signals && signals.lastAssistantAt > (Number.isFinite(doneAt) ? doneAt : 0);
      if (conv.contract !== 'until-done' || workedSince) {
        const { completedAt: _dropped, ...rest } = keeper;
        void _dropped;
        keeper = rest;
        conv = { ...conv, keeper };
      }
    }

    let walled = false;
    try { walled = deps.isWalled(conv); } catch { walled = false; }

    const facts: ChatFacts = {
      conv,
      liveRow,
      liveRowsFresh: rowsFresh,
      deadTicks: deadTicks.get(conv.id)?.n ?? 0,
      walled,
      lastAssistantText: signals?.lastAssistantText ?? null,
      declaredDone: !!signals?.declaredDone,
      hasScheduledWakeup: !!signals && (signals.hasCron || signals.hasLoopCommand),
      idleSinceMs,
      pendingDeferred: deferred.map((m) => m.marker),
      pendingKills: kills,
      memLevel,
      now,
    };
    let decision = decide(facts);
    // `--resume` needs a transcript to resume from; an unopened fork has none.
    if (decision.action === 'relaunch' && !signals) decision = { action: 'none', why: 'no-transcript' };

    tracked.push({
      conv, stored: conv0.keeper, contract: conv.contract, keeper, liveRow, signals, deferred, kills, decision,
      stall: decision.action === 'stalled' ? stallText(decision.why, liveRow, signals) : null,
    });
  }

  // --- badges: every tracked chat, paused or not (they cost nothing) -------
  for (const t of tracked) {
    const d = t.decision;
    const base = pruned(t.keeper, now);
    const armed = isArmed(t.contract);
    let next: KeeperConvState;
    if (d.action === 'stalled') {
      next = { ...base, stalled: t.stall, keptAlive: false };
    } else if (d.action === 'completed') {
      next = { ...base, stalled: null, keptAlive: false, completedAt: new Date(now).toISOString() };
    } else {
      next = { ...base, stalled: null, keptAlive: armed && !base.completedAt };
    }
    // Nothing to say about a chat that has no keeper state and earns none.
    const blank = !t.stored && next.nudgesAt.length === 0 && !next.stalled && !next.keptAlive && !next.completedAt;
    const stalledBefore = t.stored?.stalled ?? null;
    if (!blank) t.keeper = persist(deps, t.conv.id, t.stored, next) ?? next;

    if (d.action === 'stalled' && t.stall) {
      // Once per distinct stall. The persisted text covers a restart: a stall
      // already on the row was already announced by the process before us.
      if (notifiedStall.get(t.conv.id) !== t.stall && stalledBefore !== t.stall) {
        console.log('[agentsflow][keeper] stalled — not nudging', { title: t.conv.title, why: d.why, stall: t.stall });
        try { deps.notify(`“${t.conv.title}” is waiting for you`, `It ${t.stall}. It will not be nudged until you answer.`); } catch { /* a notification is a courtesy */ }
      }
      notifiedStall.set(t.conv.id, t.stall);
    } else {
      notifiedStall.delete(t.conv.id);
    }
    if (d.action === 'completed') {
      console.log('[agentsflow][keeper] until-done chat reached its finish line', { title: t.conv.title });
    }
  }

  // --- the one action ------------------------------------------------------
  // Least recently nudged first, so one chat that keeps stopping cannot starve
  // the others of their turn.
  const actionable = tracked
    .filter((t) => t.decision.action === 'nudge' || t.decision.action === 'relaunch')
    .sort((a, b) => lastNudgeMs(a.keeper) - lastNudgeMs(b.keeper));
  if (!paused && actionable.length > 0) await act(deps, actionable[0], now);

  // --- forget what is no longer followed -----------------------------------
  for (const id of Array.from(idleSince.keys())) if (!followed.has(id)) idleSince.delete(id);
  for (const id of Array.from(deadTicks.keys())) if (!followed.has(id)) deadTicks.delete(id);
  for (const id of Array.from(notifiedStall.keys())) if (!followed.has(id)) notifiedStall.delete(id);
  if (!deps.readSignals) forgetTranscriptSignals(followed);

  // --- snapshot ------------------------------------------------------------
  const items: KeeperItem[] = [];
  for (const t of tracked) {
    const armed = isArmed(t.contract);
    // A finished Until-done chat has left the Keeper's care.
    if (armed && t.contract === 'until-done' && t.keeper?.completedAt) continue;
    items.push({
      conversationId: t.conv.id,
      title: t.conv.title,
      peer: t.conv.displayName,
      contract: t.contract ?? 'once',
      contractSource: t.conv.contractSource ?? 'default',
      status: statusFor(t, memLevel, now),
      detail: detailFor(t, memLevel, now, paused),
      lastNudgeAt: t.keeper?.lastNudgeAt ?? null,
      lastNudgeReason: t.keeper?.lastNudgeReason ?? null,
      nudgesLeftThisHour: nudgesLeft(t.keeper, now),
    });
  }
  // Markers still on disk after the action (a consumed one is gone already).
  const deferredItems: KeeperDeferredItem[] = listDeferredMarkers(deps.deferredDir, now).map(({ file, marker }) => {
    const owner = all.find((c) => c.provider !== 'codex' && !c.host && ownsSession(c, marker.sessionId)) ?? null;
    return {
      file,
      sessionId: marker.sessionId,
      conversationId: owner?.id ?? null,
      title: owner?.title ?? null,
      cwd: marker.cwd,
      at: marker.at,
      what: marker.what,
      waitingFor: memLevel === 'ok' ? 'idle-chat' : 'memory',
    };
  });
  const body = { enabled, paused, items, deferred: deferredItems, recent };
  const key = JSON.stringify(body);
  if (key !== snapshotKey) {
    snapshotKey = key;
    snapshot = { at: new Date(now).toISOString(), ...body };
    try { deps.onSnapshot(snapshot); } catch { /* the window may be gone */ }
  }
}

async function act(deps: KeeperDeps, t: Tracked, now: number): Promise<void> {
  const d = t.decision;
  if (d.action !== 'nudge' && d.action !== 'relaunch') return;
  // The row as it is NOW: the user may have picked "Once" (the stop control)
  // while this pass was waiting on the usage meter.
  const live = deps.getConversation(t.conv.id);
  if (!live) return;
  const keepAlive = d.cause === 'stopped-short' || d.cause === 'daemon-dead';
  if (keepAlive && !isArmed(live.contract ?? t.contract)) return;
  if (keepAlive && live.contract !== undefined && live.contract !== t.contract) return;

  // Recorded BEFORE typing, like limit-watch: an attempt that hangs or throws
  // still counts against the cap and starts the cooldown.
  const cause: KeeperCause = d.cause;
  const base = pruned(t.keeper, now);
  const next: KeeperConvState = {
    ...base,
    nudgesAt: [...base.nudgesAt, now],
    lastNudgeAt: new Date(now).toISOString(),
    lastNudgeReason: cause,
    stalled: null,
    keptAlive: isArmed(t.contract) && !base.completedAt,
  };
  t.keeper = persist(deps, t.conv.id, t.keeper, next) ?? next;

  const text = d.action === 'nudge' ? d.text : d.prompt;
  let result: { ok: boolean; error?: string };
  try {
    result = d.action === 'nudge' ? await deps.nudge(live, text) : await deps.relaunch(live, text);
  } catch (err) {
    result = { ok: false, error: (err as Error)?.message ?? String(err) };
  }

  if (result.ok) {
    console.log(`[agentsflow][keeper] ${d.action}`, { title: t.conv.title, cause, left: nudgesLeft(t.keeper, now) });
    if (d.action === 'nudge') {
      // Consumed only once the message is actually in: a failed nudge leaves
      // the marker and the kill for the next attempt.
      const consume = new Set(d.consumeDeferred);
      for (const m of t.deferred) {
        if (!consume.has(m.marker.at)) continue;
        consumeDeferredMarker(m.file);
        console.log('[agentsflow][keeper] consume deferred marker', { title: t.conv.title, what: m.marker.what });
      }
      if (d.consumeKills > 0) {
        const rest = (pendingKills.get(t.conv.id) ?? []).slice(d.consumeKills);
        if (rest.length > 0) pendingKills.set(t.conv.id, rest);
        else pendingKills.delete(t.conv.id);
      }
    } else {
      deadTicks.delete(t.conv.id);
    }
  } else {
    console.warn(`[agentsflow][keeper] ${d.action} failed`, { title: t.conv.title, cause, error: result.error });
  }
  pushRecent({
    at: new Date(now).toISOString(),
    conversationId: t.conv.id,
    title: t.conv.title,
    cause,
    ok: result.ok,
    detail: result.ok
      ? (d.action === 'relaunch' ? 'restarted in the background' : `typed: ${text.slice(0, 140)}`)
      : `could not ${d.action === 'relaunch' ? 'restart it' : 'reach it'} (${result.error || 'unknown error'})`,
  });
}

export function startKeeper(deps: KeeperDeps): void {
  if (timer) return;
  enabled = true;
  timer = setInterval(() => { void runKeeperOnce(deps); }, KEEPER_TICK_MS);
  timer.unref?.();
}

export function stopKeeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function getKeeperSnapshot(): KeeperSnapshot {
  // Before the first pass there is nothing to show but whether it is on.
  return snapshotKey ? snapshot : { ...emptySnapshot(), enabled };
}

/** Test seam: reset the module's loop state between cases. */
export function __resetKeeperForTests(): void {
  stopKeeper();
  running = false;
  enabled = false;
  idleSince.clear();
  deadTicks.clear();
  notifiedStall.clear();
  killOffset = 0;
  killLogPrimed = false;
  unattributedKills = [];
  pendingKills.clear();
  recent = [];
  snapshot = emptySnapshot();
  snapshotKey = '';
}
