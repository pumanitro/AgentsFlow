import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'node:perf_hooks';
import { app } from 'electron';
import { Account, Conversation, PinnedDivider, PinnedItemRef, PinnedTodo, RotationPolicy, TrackedDirectory } from '../shared/types';
import { DEFAULT_POLICY } from './rotation';
import { placePinnedRefAfter, placePinnedRefAtEndOfFirstSection } from './pinned-order';
import { makeIndexer } from './conv-index';
import * as perf from './perf';

interface StoreShape {
  directories: TrackedDirectory[];
  conversations: Conversation[];
  dividers: PinnedDivider[];
  todos: PinnedTodo[];
  pinnedOrder: PinnedItemRef[];
  // The switchable Anthropic account pool. Only identity/bookkeeping lives here
  // — credentials never leave the keychain (see electron/accounts.ts).
  accounts: Account[];
  activeAccountId: string | null;
  rotationPolicy: RotationPolicy;
}

let cache: StoreShape | null = null;
let filePath: string | null = null;

// ---- Persistence tuning ----
// Coalesce rapid mutations into one write instead of rewriting the whole store
// synchronously on every change (which, at ~2 MB / 1000+ conversations, stacked
// dozens of blocking writes during a state-change burst and froze the UI).
const FLUSH_DEBOUNCE_MS = 250;
// A terminal, unpinned conversation older than this is "cold": it can't change,
// so it lives in history.json and is only rewritten when the cold set itself
// changes — keeping the frequently-written store.json small no matter how much
// history accumulates. All conversations stay merged in memory, so every reader
// (History view, pinned list, poller) is unaffected — only the disk split changes.
const COLD_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COLD_TERMINAL_STATES = new Set(['done', 'completed', 'failed', 'error', 'stopped']);
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;
// The ids currently persisted in history.json, so we only rewrite it on change.
let lastColdIds = new Set<string>();

function getPath(): string {
  if (!filePath) {
    filePath = path.join(app.getPath('userData'), 'store.json');
    migrateLegacyStoreIfNeeded(filePath);
  }
  return filePath;
}

function historyPath(): string {
  return path.join(app.getPath('userData'), 'history.json');
}

/**
 * Earlier builds wrote `store.json` to Electron's default `userData` dir, which on macOS is
 * `~/Library/Application Support/Electron/` until `app.setName(...)` is called. The product
 * name has since moved (Electron → AgentsFlow → "Agents Flow" → "Peers Flow"), and each
 * rename relocates `userData`, leaving the prior store behind. On first launch in the new
 * location, copy the most recent legacy store over so the user keeps their tracked
 * directories and conversation history across the rename.
 */
function migrateLegacyStoreIfNeeded(newPath: string): void {
  try {
    if (fs.existsSync(newPath)) return;
    const home = os.homedir();
    const candidates = [
      path.join(home, 'Library', 'Application Support', 'Electron', 'store.json'),
      path.join(home, 'Library', 'Application Support', 'AgentsFlow', 'store.json'),
      // The immediate predecessor — "Agents Flow" before the rename to "Peers Flow".
      path.join(home, 'Library', 'Application Support', 'Agents Flow', 'store.json'),
    ];
    let best: { path: string; mtime: number } | null = null;
    for (const p of candidates) {
      try {
        const st = fs.statSync(p);
        if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs };
      } catch { /* not present */ }
    }
    if (!best) return;
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.copyFileSync(best.path, newPath);
    console.log('[agentsflow] migrated legacy store from', best.path, '→', newPath);
  } catch (err) {
    console.error('[agentsflow] legacy store migration failed', err);
  }
}

function migrateConversation(c: any): Conversation {
  const isLegacy = c.title === undefined && c.summary !== undefined;
  let title: string = isLegacy ? (c.description ?? '') : (c.title ?? '');
  if (/^agentsflow:[0-9a-f]+$/i.test(title)) title = '';
  return {
    id: c.id,
    sessionId: c.sessionId ?? '',
    daemonShort: c.daemonShort ?? '',
    sessionName: c.sessionName ?? '',
    directoryId: c.directoryId ?? '',
    directoryPath: c.directoryPath ?? '',
    displayName: c.displayName ?? '',
    title,
    description: isLegacy ? (c.summary ?? '') : (c.description ?? ''),
    pinned: c.pinned ?? true,
    state: c.state ?? '',
    status: c.status ?? '',
    intent: c.intent ?? '',
    createdAt: c.createdAt ?? new Date().toISOString(),
    unpinnedAt: typeof c.unpinnedAt === 'string' ? c.unpinnedAt : undefined,
    lastPrompt: c.lastPrompt ?? '',
    delegatedByConversationId:
      typeof c.delegatedByConversationId === 'string' ? c.delegatedByConversationId : undefined,
  };
}

function sanitizeDividers(raw: any): PinnedDivider[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d) => d && typeof d.id === 'string')
    .map((d) => ({
      id: d.id,
      title: typeof d.title === 'string' ? d.title : '',
      createdAt: typeof d.createdAt === 'string' ? d.createdAt : new Date().toISOString(),
    }));
}

function sanitizeTodos(raw: any): PinnedTodo[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && typeof t.id === 'string')
    .map((t) => ({
      id: t.id,
      directoryId: typeof t.directoryId === 'string' ? t.directoryId : '',
      text: typeof t.text === 'string' ? t.text : '',
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
      done: t.done === true,
      doneAt: typeof t.doneAt === 'string' ? t.doneAt : undefined,
    }));
}

function sanitizePinnedOrder(
  raw: any,
  conversations: Conversation[],
  dividers: PinnedDivider[],
  todos: PinnedTodo[],
): PinnedItemRef[] {
  const convIds = new Set(conversations.filter((c) => c.pinned).map((c) => c.id));
  const divIds = new Set(dividers.map((d) => d.id));
  const todoIds = new Set(todos.filter((t) => !t.done).map((t) => t.id));
  const seen = new Set<string>();
  const out: PinnedItemRef[] = [];
  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (!r || typeof r.id !== 'string') continue;
      const key = `${r.kind}:${r.id}`;
      if (seen.has(key)) continue;
      if (r.kind === 'conversation' && convIds.has(r.id)) {
        out.push({ kind: 'conversation', id: r.id });
        seen.add(key);
      } else if (r.kind === 'divider' && divIds.has(r.id)) {
        out.push({ kind: 'divider', id: r.id });
        seen.add(key);
      } else if (r.kind === 'todo' && todoIds.has(r.id)) {
        out.push({ kind: 'todo', id: r.id });
        seen.add(key);
      }
    }
  }
  // Backfill: any pinned conversation missing from the order list goes to the top,
  // newest first (preserves the previous createdAt-desc behavior on first launch).
  const missing = conversations
    .filter((c) => c.pinned && !seen.has(`conversation:${c.id}`))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => ({ kind: 'conversation' as const, id: c.id }));
  // Any divider not in the order goes to the top, newest first.
  const missingDividers = dividers
    .filter((d) => !seen.has(`divider:${d.id}`))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((d) => ({ kind: 'divider' as const, id: d.id }));
  // Any active todo not in the order goes to the top too, newest first.
  const missingTodos = todos
    .filter((t) => !t.done && !seen.has(`todo:${t.id}`))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((t) => ({ kind: 'todo' as const, id: t.id }));
  return [...missingDividers, ...missingTodos, ...missing, ...out];
}

/**
 * A stored rotation policy is only trusted within sane bounds — a threshold of
 * 0 would switch accounts on every tick, and 100 would only fire after the wall
 * has already been hit, which is the thing rotation exists to avoid.
 */
function sanitizeRotationPolicy(raw: unknown): RotationPolicy {
  const p = raw as Partial<RotationPolicy> | undefined;
  const threshold = Number(p?.threshold);
  return {
    enabled: Boolean(p?.enabled),
    threshold: Number.isFinite(threshold) ? Math.min(99, Math.max(50, Math.round(threshold))) : DEFAULT_POLICY.threshold,
  };
}

function load(): StoreShape {
  if (cache) return cache;
  const p = getPath();
  let parsed: Partial<StoreShape> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<StoreShape>;
  } catch {
    parsed = {};
  }
  // Cold (archived) conversations live in a separate history.json. Read them and
  // merge back so every in-memory reader sees the full set — the split is purely
  // a write optimization. Hot wins on any id overlap (it's the fresher copy after
  // a fallback full-write); dedup defends against that overlap.
  let coldRaw: unknown[] = [];
  try {
    const h = JSON.parse(fs.readFileSync(historyPath(), 'utf8')) as { conversations?: unknown[] };
    if (Array.isArray(h?.conversations)) coldRaw = h.conversations;
  } catch {
    /* no history.json yet — first run on the new format */
  }
  const byId = new Map<string, any>();
  for (const c of parsed.conversations ?? []) if (c && (c as any).id) byId.set((c as any).id, c);
  for (const c of coldRaw) if (c && (c as any).id && !byId.has((c as any).id)) byId.set((c as any).id, c);
  const conversations = Array.from(byId.values()).map(migrateConversation);

  const dividers = sanitizeDividers(parsed.dividers);
  const todos = sanitizeTodos(parsed.todos);
  const pinnedOrder = sanitizePinnedOrder(parsed.pinnedOrder, conversations, dividers, todos);
  cache = {
    directories: parsed.directories ?? [],
    conversations,
    dividers,
    todos,
    pinnedOrder,
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
    activeAccountId: typeof parsed.activeAccountId === 'string' ? parsed.activeAccountId : null,
    rotationPolicy: sanitizeRotationPolicy(parsed.rotationPolicy),
  };
  // Seed from what's already archived so the first flush doesn't needlessly
  // rewrite history.json.
  lastColdIds = new Set(coldRaw.map((c) => (c as any)?.id).filter(Boolean));
  return cache;
}

function convTimestamp(c: Conversation): number {
  const ms = Date.parse(c.unpinnedAt || c.createdAt || '');
  return Number.isNaN(ms) ? 0 : ms;
}

/** A conversation that can never change again and is old enough to archive. */
function isCold(c: Conversation, now: number): boolean {
  if (c.pinned) return false;
  if (!COLD_TERMINAL_STATES.has((c.state || '').toLowerCase())) return false;
  const ts = convTimestamp(c);
  return ts > 0 && now - ts > COLD_AGE_MS;
}

function sameIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function writeFileAtomicSync(target: string, data: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, target);
}

async function writeFileAtomic(target: string, data: string): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, data, 'utf8');
  await fs.promises.rename(tmp, target);
}

/**
 * Split the cache into { hot, cold }, serialize both, and report whether the cold
 * set changed. Serialization (the only synchronous, main-thread-blocking part of
 * a flush) is timed as `store:save` so a lag spell attributes to it.
 */
function serializeSplit(s: StoreShape, now: number): { hotJson: string; coldJson: string | null; coldIds: Set<string> } {
  const t0 = performance.now();
  const all = s.conversations;
  const cold = all.filter((c) => isCold(c, now));
  const coldIds = new Set(cold.map((c) => c.id));
  const coldChanged = !sameIdSet(coldIds, lastColdIds);
  const coldJson = coldChanged ? JSON.stringify({ conversations: cold }) : null;
  const hot = all.filter((c) => !coldIds.has(c.id));
  const hotJson = JSON.stringify({
    directories: s.directories,
    dividers: s.dividers,
    todos: s.todos,
    pinnedOrder: s.pinnedOrder,
    accounts: s.accounts,
    activeAccountId: s.activeAccountId,
    rotationPolicy: s.rotationPolicy,
    conversations: hot,
  });
  perf.record('store:save', performance.now() - t0);
  return { hotJson, coldJson, coldIds };
}

// Debounced, coalescing write. Marks the cache dirty and lets an in-flight or
// scheduled flush pick it up — so a burst of mutations produces a single write.
function save(): void {
  dirty = true;
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flushToDisk(); }, FLUSH_DEBOUNCE_MS);
}

async function flushToDisk(): Promise<void> {
  if (flushing || !cache || !dirty) return;
  const snapshot = cache;
  flushing = true;
  dirty = false;
  try {
    const { hotJson, coldJson, coldIds } = serializeSplit(snapshot, Date.now());
    let coldOk = true;
    if (coldJson !== null) {
      try {
        await writeFileAtomic(historyPath(), coldJson);
        lastColdIds = coldIds;
      } catch (err) {
        // Cold write failed → fall back to writing EVERYTHING to store.json so
        // nothing is lost (load() dedups the overlap). Retry the split next flush.
        coldOk = false;
        console.error('[agentsflow] history flush failed — writing full store as fallback', err);
      }
    }
    await writeFileAtomic(getPath(), coldOk ? hotJson : JSON.stringify(snapshot));
  } catch (err) {
    console.error('[agentsflow] store flush failed', err);
    dirty = true; // ensure a retry
  } finally {
    flushing = false;
    if (dirty) save();
  }
}

/** Synchronous flush for shutdown (before-quit / signal) so nothing is lost. */
function flushToDiskSync(): void {
  if (!cache) return;
  const snapshot = cache;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  dirty = false;
  try {
    const { hotJson, coldJson, coldIds } = serializeSplit(snapshot, Date.now());
    let coldOk = true;
    if (coldJson !== null) {
      try { writeFileAtomicSync(historyPath(), coldJson); lastColdIds = coldIds; }
      catch (err) { coldOk = false; console.error('[agentsflow] history flushSync failed', err); }
    }
    writeFileAtomicSync(getPath(), coldOk ? hotJson : JSON.stringify(snapshot));
  } catch (err) {
    console.error('[agentsflow] store flushSync failed', err);
  }
}

// ---- Conversation id index ----
// O(1) id lookup instead of a findIndex over all of history on every daemon
// state change. See electron/conv-index.ts for why identity-keyed memoization
// is exactly right here — and for the one thing callers must not do (reorder
// the array in place).
const conversationIndexer = makeIndexer<Conversation>();
function conversationIndex(s: StoreShape): Map<string, number> {
  return conversationIndexer(s.conversations);
}

function dropPinnedRef(s: StoreShape, ref: PinnedItemRef): void {
  s.pinnedOrder = s.pinnedOrder.filter((r) => !(r.kind === ref.kind && r.id === ref.id));
}

function prependPinnedRef(s: StoreShape, ref: PinnedItemRef): void {
  dropPinnedRef(s, ref);
  s.pinnedOrder = [ref, ...s.pinnedOrder];
}


export const store = {
  /** Persist synchronously right now — for app shutdown, so no change is lost. */
  flushSync(): void {
    flushToDiskSync();
  },
  getDirectories(): TrackedDirectory[] {
    return load().directories;
  },
  setDirectories(dirs: TrackedDirectory[]): void {
    load().directories = dirs;
    save();
  },
  getConversations(): Conversation[] {
    return load().conversations;
  },
  /** O(1) lookup by id — see the conversation index note above. */
  getConversation(id: string): Conversation | null {
    const s = load();
    const idx = conversationIndex(s).get(id);
    return idx === undefined ? null : s.conversations[idx] ?? null;
  },
  setConversations(convs: Conversation[]): void {
    load().conversations = convs;
    save();
  },
  addConversation(c: Conversation, opts?: { afterConversationId?: string }): void {
    const s = load();
    s.conversations = [c, ...s.conversations.filter((x) => x.id !== c.id)];
    if (c.pinned) {
      const ref: PinnedItemRef = { kind: 'conversation', id: c.id };
      // Anchored placement (e.g. a fork lands directly below its source, in the
      // same section); default is the end of the first section.
      s.pinnedOrder = opts?.afterConversationId
        ? placePinnedRefAfter(s.pinnedOrder, ref, { kind: 'conversation', id: opts.afterConversationId })
        : placePinnedRefAtEndOfFirstSection(s.pinnedOrder, ref);
    }
    save();
  },
  updateConversation(id: string, patch: Partial<Conversation>): Conversation | null {
    const s = load();
    const idx = conversationIndex(s).get(id);
    if (idx === undefined) return null;
    const prev = s.conversations[idx];
    if (!prev) return null;
    const next = { ...prev, ...patch };
    s.conversations[idx] = next;
    if (patch.pinned !== undefined && patch.pinned !== prev.pinned) {
      if (patch.pinned) {
        prependPinnedRef(s, { kind: 'conversation', id });
      } else {
        // Pin→unpin means the task is considered done; record the moment.
        // `next` is the same object already stored at conversations[idx].
        next.unpinnedAt = new Date().toISOString();
        dropPinnedRef(s, { kind: 'conversation', id });
      }
    }
    save();
    return next;
  },
  removeConversation(id: string): void {
    const s = load();
    s.conversations = s.conversations.filter((x) => x.id !== id);
    dropPinnedRef(s, { kind: 'conversation', id });
    save();
  },
  /**
   * After a directory is added with a new id, update any conversations whose
   * recorded `directoryPath` matches so they show up under the new dir again.
   * Also refreshes the cached `displayName` field on those conversations.
   */
  relinkConversationsByPath(absPath: string, newDirectoryId: string, displayName: string): number {
    const s = load();
    let count = 0;
    s.conversations = s.conversations.map((c) => {
      if (c.directoryPath !== absPath) return c;
      if (c.directoryId === newDirectoryId && c.displayName === displayName) return c;
      count += 1;
      return { ...c, directoryId: newDirectoryId, displayName };
    });
    if (count > 0) save();
    return count;
  },
  getAccounts(): Account[] {
    return load().accounts;
  },
  getActiveAccountId(): string | null {
    return load().activeAccountId;
  },
  addAccount(account: Account): Account {
    const s = load();
    s.accounts = [...s.accounts.filter((a) => a.id !== account.id), account];
    save();
    return account;
  },
  removeAccount(id: string): void {
    const s = load();
    s.accounts = s.accounts.filter((a) => a.id !== id);
    if (s.activeAccountId === id) s.activeAccountId = null;
    save();
  },
  setActiveAccountId(id: string | null): void {
    const s = load();
    s.activeAccountId = id;
    save();
  },
  getRotationPolicy(): RotationPolicy {
    return load().rotationPolicy;
  },
  setRotationPolicy(policy: RotationPolicy): RotationPolicy {
    const s = load();
    s.rotationPolicy = sanitizeRotationPolicy(policy);
    save();
    return s.rotationPolicy;
  },

  getDividers(): PinnedDivider[] {
    return load().dividers;
  },
  addDivider(divider: PinnedDivider, afterRef: PinnedItemRef | null): PinnedDivider {
    const s = load();
    s.dividers = [divider, ...s.dividers.filter((d) => d.id !== divider.id)];
    const ref: PinnedItemRef = { kind: 'divider', id: divider.id };
    dropPinnedRef(s, ref);
    if (!afterRef) {
      s.pinnedOrder = [ref, ...s.pinnedOrder];
    } else {
      const idx = s.pinnedOrder.findIndex(
        (r) => r.kind === afterRef.kind && r.id === afterRef.id,
      );
      if (idx < 0) {
        s.pinnedOrder = [ref, ...s.pinnedOrder];
      } else {
        s.pinnedOrder = [
          ...s.pinnedOrder.slice(0, idx),
          ref,
          ...s.pinnedOrder.slice(idx),
        ];
      }
    }
    save();
    return divider;
  },
  updateDivider(id: string, patch: Partial<PinnedDivider>): PinnedDivider | null {
    const s = load();
    const idx = s.dividers.findIndex((d) => d.id === id);
    if (idx === -1) return null;
    s.dividers[idx] = { ...s.dividers[idx], ...patch };
    save();
    return s.dividers[idx];
  },
  removeDivider(id: string): void {
    const s = load();
    s.dividers = s.dividers.filter((d) => d.id !== id);
    dropPinnedRef(s, { kind: 'divider', id });
    save();
  },

  getTodos(): PinnedTodo[] {
    return load().todos;
  },
  addTodo(todo: PinnedTodo, afterRef: PinnedItemRef | null): PinnedTodo {
    const s = load();
    s.todos = [todo, ...s.todos.filter((t) => t.id !== todo.id)];
    const ref: PinnedItemRef = { kind: 'todo', id: todo.id };
    if (!todo.done) {
      s.pinnedOrder = afterRef
        ? placePinnedRefAfter(s.pinnedOrder, ref, afterRef)
        : placePinnedRefAtEndOfFirstSection(s.pinnedOrder, ref);
    }
    save();
    return todo;
  },
  updateTodo(id: string, patch: Partial<PinnedTodo>): PinnedTodo | null {
    const s = load();
    const idx = s.todos.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    const prev = s.todos[idx];
    const next = { ...prev, ...patch };
    s.todos[idx] = next;
    if (patch.done !== undefined && patch.done !== prev.done) {
      if (patch.done) {
        // Done means finished — stamp the moment (drives the History timeline)
        // and drop the row from the pinned list, like unpinning a conversation.
        next.doneAt = new Date().toISOString();
        dropPinnedRef(s, { kind: 'todo', id });
      } else {
        next.doneAt = undefined;
        prependPinnedRef(s, { kind: 'todo', id });
      }
    }
    save();
    return next;
  },
  removeTodo(id: string): void {
    const s = load();
    s.todos = s.todos.filter((t) => t.id !== id);
    dropPinnedRef(s, { kind: 'todo', id });
    save();
  },

  getPinnedOrder(): PinnedItemRef[] {
    return load().pinnedOrder;
  },
  setPinnedOrder(order: PinnedItemRef[]): PinnedItemRef[] {
    const s = load();
    s.pinnedOrder = sanitizePinnedOrder(order, s.conversations, s.dividers, s.todos);
    save();
    return s.pinnedOrder;
  },
};
