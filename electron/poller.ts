import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listAgentsResult, readJobState, stopAgent, type ClaudeAgentJsonRow } from './claude-cli';
import { hasLiveViewer } from './pty-manager';
import { store } from './store';
import { Conversation } from '../shared/types';
import { effectiveState, deriveDescription, reconcileLiveState, deriveLiveDescription, findLiveRow } from './derive-state';

let fallbackTimer: NodeJS.Timeout | null = null;
const watchers = new Map<string, fs.FSWatcher>();
let getWindowRef: (() => BrowserWindow | null) | null = null;
let pushScheduled = false;

const ACTIVE_STATES = new Set(['working', 'active', 'blocked', 'needs-input', 'starting']);
const TERMINAL_STATES = new Set(['done', 'completed', 'failed', 'error']);
function hasActiveConversation(convs: Conversation[]): boolean {
  for (const c of convs) {
    if (ACTIVE_STATES.has((c.state || '').toLowerCase())) return true;
  }
  return false;
}

// Reconciliation: count consecutive successful `listAgents` responses where a
// conversation's daemonShort was absent. After MISS_THRESHOLD misses we
// transition the conversation to a terminal state — the daemon has been
// confirmed gone, so any "working" still showing in state.json is stale.
// Failed `listAgents` calls do NOT advance the counter (Kubernetes-style:
// unknown != absent).
const MISS_THRESHOLD = 2;
const missCount = new Map<string, number>();

function markTerminalIfMissing(c: Conversation): Conversation | null {
  if (!c.daemonShort) return null;
  if (TERMINAL_STATES.has((c.state || '').toLowerCase())) return null;
  // Prefer a terminal state recorded by the daemon's own state.json if the
  // daemon happened to write one before dying.
  const job = readJobState(c.daemonShort);
  const recorded = (job?.state || '').toLowerCase();
  const nextState = TERMINAL_STATES.has(recorded) ? recorded : 'done';
  return { ...c, state: nextState };
}

function jobStatePath(daemonShort: string): string {
  return path.join(os.homedir(), '.claude', 'jobs', daemonShort, 'state.json');
}

// ---------- Background-daemon reaper ----------
// A `claude --bg` daemon lingers as a live process instead of exiting — and every
// peer-aware one also holds a `bg-pty-host` (which owns a real PTY) plus an
// `agentsflow-mcp-server` child. Left alone these stragglers accumulate over a
// long session and across app restarts, draining the OS process/PTY budget until
// node-pty's forkpty() fails and aborts the whole app (SIGABRT). `claude stop`
// ends the daemon, which tears down its pty-host and closes its mcp-server
// child's stdin so those exit too. The transcript stays on disk, so the
// conversation is still fully resumable — we free the process, not the data.
//
// There are TWO reap classes, because a daemon leaks in two ways:
//
//  1. TERMINAL — the daemon reported it finished (done/completed/failed/error).
//     Reaped after a short grace (REAP_GRACE_MS).
//
//  2. ABANDONED — the far more common leak in practice: a background daemon ends
//     its turn on a permission prompt / AskUserQuestion (→ `blocked`/`waiting`)
//     or simply goes `idle`, and then sits there *indefinitely*. It never reaches
//     a terminal state, so a terminal-only reaper never touches it, and it piles
//     up as a live PTY-holding process forever. We reap such a daemon once it has
//     been non-terminal but quiescent for a much longer "abandoned" grace
//     (ABANDON_GRACE_MS). A later open of the conversation re-dispatches it, so
//     this stays non-destructive.
//
// Pinned, on-screen (viewed), and actively-working (busy / working / starting)
// sessions are ALWAYS spared, in both classes.
const REAP_GRACE_MS = Number(process.env.AGENTSFLOW_DAEMON_REAP_GRACE_MS) || 15 * 60 * 1000;
const ABANDON_GRACE_MS = Number(process.env.AGENTSFLOW_DAEMON_ABANDON_GRACE_MS) || 6 * 60 * 60 * 1000;
const MAX_REAPS_PER_TICK = 4;
let reapInFlight = false;

async function reapStaleDaemons(convs: Conversation[], liveRows: ClaudeAgentJsonRow[]): Promise<void> {
  if (reapInFlight || liveRows.length === 0) return;
  reapInFlight = true;
  try {
    const now = Date.now();
    let reaped = 0;
    for (const c of convs) {
      if (reaped >= MAX_REAPS_PER_TICK) break;
      if (!c.daemonShort || c.pinned) continue;
      // Only a daemon that's actually still running is worth (and possible) to reap.
      const row = liveRows.find((r) => r.sessionId.startsWith(c.daemonShort));
      if (!row) continue;
      if (hasLiveViewer(c.sessionId || row.sessionId)) continue;
      // Never interrupt an in-progress turn or a session still booting.
      const status = (row.status || '').toLowerCase();
      const state = (c.state || '').toLowerCase();
      if (status === 'busy' || state === 'working' || state === 'starting') continue;
      // Classify: terminal (short grace) vs abandoned/quiescent (long grace).
      const terminal = TERMINAL_STATES.has(state);
      const abandoned = status === 'idle' || status === 'waiting' || state === 'blocked' || state === 'needs-input';
      if (!terminal && !abandoned) continue;
      const grace = terminal ? REAP_GRACE_MS : ABANDON_GRACE_MS;
      // state.json mtime is when the daemon last did anything; fall back to the
      // process start time if the file is missing. A daemon that just blocked /
      // went idle has a fresh mtime and is kept until the grace elapses.
      let quietAt = 0;
      try { quietAt = fs.statSync(jobStatePath(c.daemonShort)).mtimeMs; } catch { /* no file */ }
      if (!quietAt && row.startedAt) quietAt = row.startedAt;
      if (quietAt && now - quietAt < grace) continue;
      reaped++;
      console.log('[agentsflow][reaper] stopping lingering daemon', { short: c.daemonShort, reason: terminal ? 'terminal' : 'abandoned', state, status, title: c.title });
      try { await stopAgent(c.daemonShort); } catch { /* best-effort; next tick retries */ }
    }
  } finally {
    reapInFlight = false;
  }
}

function schedulePush(): void {
  if (pushScheduled) return;
  pushScheduled = true;
  setImmediate(() => {
    pushScheduled = false;
    const win = getWindowRef?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send('conversations:updated', store.getConversations());
    }
  });
}

// `liveRow` is the matching `claude agents --json` row when the poller's tick
// has one. Its real-time `state`/`status`/`waitingFor` reconcile against — and
// override — a possibly-stale state.json (see `reconcileLiveState`). The
// file-watcher path has no row and falls back to the state.json alone.
function applyJobToConversation(
  c: Conversation,
  liveRow?: ClaudeAgentJsonRow,
): { next: Conversation; changed: boolean } {
  const job = readJobState(c.daemonShort);
  if (!job && !liveRow) return { next: c, changed: false };

  let changed = false;
  const next: Conversation = { ...c };
  const eff = liveRow ? reconcileLiveState(liveRow, job) : (job ? effectiveState(job) : undefined);
  if (eff && eff !== c.state) { next.state = eff; changed = true; }
  const live = liveRow ? deriveLiveDescription(liveRow, job) : (job ? deriveDescription(job) : '');
  if (live && live !== c.description) { next.description = live; changed = true; }
  if (job?.intent && job.intent !== c.intent) { next.intent = job.intent; changed = true; }

  return { next, changed };
}

function refreshOneFromFile(conversationId: string): void {
  const conv = store.getConversations().find((c) => c.id === conversationId);
  if (!conv) return;
  const { next, changed } = applyJobToConversation(conv);
  if (changed) {
    store.updateConversation(conversationId, next);
    schedulePush();
  }
}

export function watchConversation(c: Conversation): void {
  if (!c.daemonShort) return;
  if (watchers.has(c.id)) return;
  const stateFile = jobStatePath(c.daemonShort);
  const jobDir = path.dirname(stateFile);
  const stateFilename = path.basename(stateFile);
  try {
    let lastFire = 0;
    const handler = () => {
      const now = Date.now();
      if (now - lastFire < 30) return;
      lastFire = now;
      refreshOneFromFile(c.id);
    };
    // Watch the parent directory: macOS atomic-write patterns (write tmp + rename)
    // don't reliably fire a file-level fs.watch, but the dir-level watcher catches them.
    const w = fs.watch(jobDir, { persistent: false }, (_event, changedName) => {
      if (!changedName || changedName === stateFilename) handler();
    });
    w.on('error', () => {
      try { w.close(); } catch {}
      watchers.delete(c.id);
    });
    watchers.set(c.id, w);
    refreshOneFromFile(c.id);
  } catch {
    // dir may not exist yet; the fallback poll will catch it
  }
}

export function unwatchConversation(conversationId: string): void {
  const w = watchers.get(conversationId);
  if (!w) return;
  try { w.close(); } catch {}
  watchers.delete(conversationId);
}

export function syncWatchers(): void {
  const convs = store.getConversations();
  const live = new Set(convs.map((c) => c.id));
  for (const id of Array.from(watchers.keys())) {
    if (!live.has(id)) unwatchConversation(id);
  }
  for (const c of convs) {
    if (!watchers.has(c.id)) watchConversation(c);
  }
}

async function fallbackTick(): Promise<void> {
  syncWatchers();
  const convs = store.getConversations();
  if (convs.length === 0) return;

  const result = await listAgentsResult();
  // On transient CLI failure: don't touch state, don't advance miss counters.
  // The next tick will re-attempt; meanwhile the UI keeps the last good state
  // rather than oscillating to "done" on every flaky list call.
  if (!result.ok) {
    return;
  }
  const rows: ClaudeAgentJsonRow[] = result.rows;

  // Drop miss counters for conversations that no longer exist.
  const liveIds = new Set(convs.map((c) => c.id));
  for (const id of Array.from(missCount.keys())) {
    if (!liveIds.has(id)) missCount.delete(id);
  }

  let anyChange = false;
  const updated = convs.map((c) => {
    let next = c;
    let changed = false;
    const row = findLiveRow(c, rows);
    if (row) {
      missCount.delete(c.id);
      // `status` mirrors the live row's real-time process status (busy/idle/
      // waiting); normalize absent to '' so it never lingers stale.
      const liveStatus = row.status || '';
      if (liveStatus !== c.status) { next = { ...next, status: liveStatus }; changed = true; }
      if (row.sessionId && row.sessionId !== c.sessionId) { next = { ...next, sessionId: row.sessionId }; changed = true; }
      // Daemon is present: reconcile the live row against state.json — the row's
      // real-time state/status wins over a frozen state.json (e.g. a session
      // re-opened interactively via --resume still reporting "busy").
      const merged = applyJobToConversation(next, row);
      if (merged.changed) { next = merged.next; changed = true; }
    } else if (c.daemonShort) {
      // No live row → no live process → the real-time `status` is meaningless,
      // so clear it (otherwise a stale "busy" would keep the dot blue forever).
      if (c.status) { next = { ...next, status: '' }; changed = true; }
      // Conversation expects a daemon but listAgents (which succeeded) doesn't
      // see it. After MISS_THRESHOLD consecutive successful misses, transition
      // to a terminal state and stop replaying stale state.json content.
      const next_n = (missCount.get(c.id) ?? 0) + 1;
      missCount.set(c.id, next_n);
      if (next_n >= MISS_THRESHOLD) {
        const promoted = markTerminalIfMissing(next);
        if (promoted) { next = promoted; changed = true; }
      } else {
        // Still within grace period — keep applying state.json so a freshly
        // started daemon that hasn't appeared in listAgents yet still shows
        // its live state.
        const merged = applyJobToConversation(next);
        if (merged.changed) { next = merged.next; changed = true; }
      }
    } else if (ACTIVE_STATES.has((c.state || '').toLowerCase())) {
      // Daemonless (forked) conversation whose interactive process is gone —
      // the user closed the terminal, or it was killed mid-turn. There is no
      // state.json to fall back on, so a lingering "working"/"blocked" can
      // never advance on its own. Settle it as done once the absence is
      // confirmed (same MISS_THRESHOLD debounce as the daemon path).
      if (c.status) { next = { ...next, status: '' }; changed = true; }
      const next_n = (missCount.get(c.id) ?? 0) + 1;
      missCount.set(c.id, next_n);
      if (next_n >= MISS_THRESHOLD) { next = { ...next, state: 'done' }; changed = true; }
    } else {
      // No daemon and no live row: an unopened fork (state "idle") or a plain
      // conversation with nothing to reconcile against. Leave alone.
    }
    if (changed) anyChange = true;
    return next;
  });

  if (anyChange) {
    store.setConversations(updated);
    schedulePush();
  }

  // Reap finished-but-still-running daemons (and their mcp-server children).
  // Fire-and-forget so it never delays state reconciliation; it self-guards
  // against overlapping runs and caps how many it stops per tick.
  void reapStaleDaemons(updated, rows);
}

const FAST_TICK_MS = 3000;
const SLOW_TICK_MS = 30000;

function scheduleNextTick(): void {
  if (fallbackTimer) clearTimeout(fallbackTimer);
  const interval = hasActiveConversation(store.getConversations()) ? FAST_TICK_MS : SLOW_TICK_MS;
  fallbackTimer = setTimeout(async () => {
    try { await fallbackTick(); } catch { /* swallow */ }
    scheduleNextTick();
  }, interval);
}

export function startPoller(getWindow: () => BrowserWindow | null): void {
  stopPoller();
  getWindowRef = getWindow;
  syncWatchers();
  fallbackTick().catch(() => undefined);
  scheduleNextTick();
}

export function stopPoller(): void {
  if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
  for (const id of Array.from(watchers.keys())) unwatchConversation(id);
}

export async function refreshNow(): Promise<Conversation[]> {
  await fallbackTick();
  return store.getConversations();
}
