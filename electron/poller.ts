import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listAgentsResult, readJobState, type ClaudeAgentJsonRow } from './claude-cli';
import { store } from './store';
import { Conversation } from '../shared/types';
import { effectiveState, deriveDescription } from './derive-state';

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

function applyJobToConversation(c: Conversation): { next: Conversation; changed: boolean } {
  const job = readJobState(c.daemonShort);
  if (!job) return { next: c, changed: false };

  let changed = false;
  const next: Conversation = { ...c };
  const eff = effectiveState(job);
  if (eff && eff !== c.state) { next.state = eff; changed = true; }
  const live = deriveDescription(job);
  if (live && live !== c.description) { next.description = live; changed = true; }
  if (job.intent && job.intent !== c.intent) { next.intent = job.intent; changed = true; }

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
  const byName = new Map(rows.filter((r) => r.name).map((r) => [r.name!, r]));

  // Drop miss counters for conversations that no longer exist.
  const liveIds = new Set(convs.map((c) => c.id));
  for (const id of Array.from(missCount.keys())) {
    if (!liveIds.has(id)) missCount.delete(id);
  }

  let anyChange = false;
  const updated = convs.map((c) => {
    let next = c;
    let changed = false;
    // Look up by sessionName first (legacy), then by daemonShort prefix.
    let row = c.sessionName ? byName.get(c.sessionName) : undefined;
    if (!row && c.daemonShort) {
      row = rows.find((r) => r.sessionId.startsWith(c.daemonShort));
    }
    if (row) {
      missCount.delete(c.id);
      if (row.status && row.status !== c.status) { next = { ...next, status: row.status }; changed = true; }
      if (row.sessionId && row.sessionId !== c.sessionId) { next = { ...next, sessionId: row.sessionId }; changed = true; }
      // Daemon is present: trust state.json as before.
      const merged = applyJobToConversation(next);
      if (merged.changed) { next = merged.next; changed = true; }
    } else if (c.daemonShort) {
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
    } else {
      // No daemonShort recorded — nothing to reconcile against. Leave alone.
    }
    if (changed) anyChange = true;
    return next;
  });

  if (anyChange) {
    store.setConversations(updated);
    schedulePush();
  }
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
