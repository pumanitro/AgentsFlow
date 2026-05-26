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

function cleanName(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  if (/^agentsflow:[0-9a-f]+$/i.test(v)) return '';
  return v;
}

function applyJobToConversation(c: Conversation): { next: Conversation; changed: boolean } {
  const job = readJobState(c.daemonShort);
  if (!job) return { next: c, changed: false };

  let changed = false;
  const next: Conversation = { ...c };
  if (job.state && job.state !== c.state) { next.state = job.state; changed = true; }
  const live = (job.detail || job.output?.result || '').trim();
  if (live && live !== c.description) { next.description = live; changed = true; }
  if (job.intent && job.intent !== c.intent) { next.intent = job.intent; changed = true; }

  if (!c.titleLocked) {
    const claudeName = cleanName(job.name);
    const intentSnip = (job.intent || c.intent || '').trim().slice(0, 60);
    const desired = claudeName || intentSnip;
    if (desired && desired !== c.title) {
      next.title = desired;
      changed = true;
    }
  }
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
  const p = jobStatePath(c.daemonShort);
  try {
    let lastFire = 0;
    const handler = () => {
      const now = Date.now();
      if (now - lastFire < 30) return;
      lastFire = now;
      refreshOneFromFile(c.id);
    };
    const w = fs.watch(p, { persistent: false }, handler);
    w.on('error', () => {
      try { w.close(); } catch {}
      watchers.delete(c.id);
    });
    watchers.set(c.id, w);
    refreshOneFromFile(c.id);
  } catch {
    // file may not exist yet; the fallback poll will catch it
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

export function startPoller(getWindow: () => BrowserWindow | null, fallbackMs = 30000): void {
  stopPoller();
  getWindowRef = getWindow;
  syncWatchers();
  fallbackTick();
  fallbackTimer = setInterval(() => { fallbackTick().catch(() => undefined); }, fallbackMs);
}

export function stopPoller(): void {
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
  for (const id of Array.from(watchers.keys())) unwatchConversation(id);
}

export async function refreshNow(): Promise<Conversation[]> {
  await fallbackTick();
  return store.getConversations();
}
