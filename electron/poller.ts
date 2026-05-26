import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listAgents, readJobState } from './claude-cli';
import { store } from './store';
import { Conversation } from '../shared/types';

let fallbackTimer: NodeJS.Timeout | null = null;
const watchers = new Map<string, fs.FSWatcher>();
let getWindowRef: (() => BrowserWindow | null) | null = null;
let pushScheduled = false;

const ACTIVE_STATES = new Set(['working', 'active', 'blocked', 'needs-input', 'starting']);
function hasActiveConversation(convs: Conversation[]): boolean {
  for (const c of convs) {
    if (ACTIVE_STATES.has((c.state || '').toLowerCase())) return true;
  }
  return false;
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

function deriveDescription(job: NonNullable<ReturnType<typeof readJobState>>): string {
  const detail = (job.detail || job.output?.result || '').trim();
  if (detail) return detail;
  const state = (job.state || '').toLowerCase();
  const tempo = (job.tempo || '').toLowerCase();
  const kinds = job.inFlight?.kinds ?? [];
  const tasks = job.inFlight?.tasks ?? 0;
  if (state === 'blocked' || state === 'needs-input') return 'waiting for your input';
  if (state === 'failed' || state === 'error') return 'failed';
  if (state === 'done' || state === 'completed') return 'completed';
  if (state === 'starting') return 'starting…';
  // Anything else we treat as in-flight work
  const active = state === 'working' || state === 'active' || tempo === 'active' || tasks > 0;
  if (active) {
    if (kinds.length > 0) {
      const uniq = Array.from(new Set(kinds)).slice(0, 3).join(', ').toLowerCase();
      return `working — ${uniq}…`;
    }
    return 'working…';
  }
  return state || 'idle';
}

function effectiveState(job: NonNullable<ReturnType<typeof readJobState>>): string | undefined {
  const tempo = (job.tempo || '').toLowerCase();
  const tasks = job.inFlight?.tasks ?? 0;
  // If Claude is actually doing work right now, treat the conversation as "working"
  // even if state.json/state still says "done" from the previous turn. This makes the
  // status dot react to follow-up prompts instead of getting stuck green.
  if (tempo === 'active' || tasks > 0) return 'working';
  return job.state;
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

  const rows = await listAgents();
  const byName = new Map(rows.filter((r) => r.name).map((r) => [r.name!, r]));

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
      if (row.status && row.status !== c.status) { next = { ...next, status: row.status }; changed = true; }
      if (row.sessionId && row.sessionId !== c.sessionId) { next = { ...next, sessionId: row.sessionId }; changed = true; }
    }
    const merged = applyJobToConversation(next);
    if (merged.changed) { next = merged.next; changed = true; }
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
