import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { Conversation, TrackedDirectory } from '../shared/types';

interface StoreShape {
  directories: TrackedDirectory[];
  conversations: Conversation[];
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

function load(): StoreShape {
  if (cache) return cache;
  const p = getPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    cache = {
      directories: parsed.directories ?? [],
      conversations: (parsed.conversations ?? []).map(migrateConversation),
    };
  } catch {
    cache = { directories: [], conversations: [] };
  }
  return cache;
}

function save(): void {
  if (!cache) return;
  const p = getPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8');
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
    save();
  },
  updateConversation(id: string, patch: Partial<Conversation>): Conversation | null {
    const s = load();
    const idx = s.conversations.findIndex((x) => x.id === id);
    if (idx === -1) return null;
    s.conversations[idx] = { ...s.conversations[idx], ...patch };
    save();
    return s.conversations[idx];
  },
  removeConversation(id: string): void {
    const s = load();
    s.conversations = s.conversations.filter((x) => x.id !== id);
    save();
  },
};
