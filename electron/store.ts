import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { Conversation, PinnedDivider, PinnedItemRef, TrackedDirectory } from '../shared/types';

interface StoreShape {
  directories: TrackedDirectory[];
  conversations: Conversation[];
  dividers: PinnedDivider[];
  pinnedOrder: PinnedItemRef[];
}

let cache: StoreShape | null = null;
let filePath: string | null = null;

function getPath(): string {
  if (!filePath) {
    filePath = path.join(app.getPath('userData'), 'store.json');
    migrateLegacyStoreIfNeeded(filePath);
  }
  return filePath;
}

/**
 * Earlier builds wrote `store.json` to Electron's default `userData` dir, which on macOS is
 * `~/Library/Application Support/Electron/` until `app.setName(...)` is called. Once we set
 * the product name to "Agents Flow" the location moves to `…/Agents Flow/` and the old
 * store would look empty. On first launch in the new location, copy the most recent legacy
 * store over so the user keeps their tracked directories and conversation history.
 */
function migrateLegacyStoreIfNeeded(newPath: string): void {
  try {
    if (fs.existsSync(newPath)) return;
    const home = os.homedir();
    const candidates = [
      path.join(home, 'Library', 'Application Support', 'Electron', 'store.json'),
      path.join(home, 'Library', 'Application Support', 'AgentsFlow', 'store.json'),
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
    lastPrompt: c.lastPrompt ?? '',
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

function sanitizePinnedOrder(
  raw: any,
  conversations: Conversation[],
  dividers: PinnedDivider[],
): PinnedItemRef[] {
  const convIds = new Set(conversations.filter((c) => c.pinned).map((c) => c.id));
  const divIds = new Set(dividers.map((d) => d.id));
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
  return [...missingDividers, ...missing, ...out];
}

function load(): StoreShape {
  if (cache) return cache;
  const p = getPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    const conversations = (parsed.conversations ?? []).map(migrateConversation);
    const dividers = sanitizeDividers(parsed.dividers);
    const pinnedOrder = sanitizePinnedOrder(parsed.pinnedOrder, conversations, dividers);
    cache = {
      directories: parsed.directories ?? [],
      conversations,
      dividers,
      pinnedOrder,
    };
  } catch {
    cache = { directories: [], conversations: [], dividers: [], pinnedOrder: [] };
  }
  return cache;
}

function save(): void {
  if (!cache) return;
  const p = getPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8');
}

function dropPinnedRef(s: StoreShape, ref: PinnedItemRef): void {
  s.pinnedOrder = s.pinnedOrder.filter((r) => !(r.kind === ref.kind && r.id === ref.id));
}

function prependPinnedRef(s: StoreShape, ref: PinnedItemRef): void {
  dropPinnedRef(s, ref);
  s.pinnedOrder = [ref, ...s.pinnedOrder];
}

export const store = {
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
  setConversations(convs: Conversation[]): void {
    load().conversations = convs;
    save();
  },
  addConversation(c: Conversation): void {
    const s = load();
    s.conversations = [c, ...s.conversations.filter((x) => x.id !== c.id)];
    if (c.pinned) prependPinnedRef(s, { kind: 'conversation', id: c.id });
    save();
  },
  updateConversation(id: string, patch: Partial<Conversation>): Conversation | null {
    const s = load();
    const idx = s.conversations.findIndex((x) => x.id === id);
    if (idx === -1) return null;
    const prev = s.conversations[idx];
    const next = { ...prev, ...patch };
    s.conversations[idx] = next;
    if (patch.pinned !== undefined && patch.pinned !== prev.pinned) {
      if (patch.pinned) prependPinnedRef(s, { kind: 'conversation', id });
      else dropPinnedRef(s, { kind: 'conversation', id });
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

  getPinnedOrder(): PinnedItemRef[] {
    return load().pinnedOrder;
  },
  setPinnedOrder(order: PinnedItemRef[]): PinnedItemRef[] {
    const s = load();
    s.pinnedOrder = sanitizePinnedOrder(order, s.conversations, s.dividers);
    save();
    return s.pinnedOrder;
  },
};
