import * as fs from 'fs';
import * as path from 'path';
import {
  DISMISSED_RETENTION_DAYS,
  OPEN_RETENTION_DAYS,
  isOpen,
  type NotificationFile,
  type NotificationLevel,
  type NotificationSource,
  type NotificationsSnapshot,
  type UserNotification,
} from '../shared/notifications';

// Notifications live in their own file (<userData>/notifications.json), like
// routines: a corrupt notifications file can never take the chat list down.

const FILE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 250;
const DAY_MS = 24 * 60 * 60 * 1000;

interface FileShape { version: number; notifications: UserNotification[] }

export interface NotificationsStore {
  list(opts?: { includeDismissed?: boolean }): UserNotification[];   // newest first (createdAt desc)
  get(id: string): UserNotification | null;
  add(n: UserNotification): UserNotification;
  update(id: string, patch: Partial<UserNotification>): UserNotification | null;   // id is never changed
  findOpen(pred: (n: UserNotification) => boolean): UserNotification | null;
  snapshot(nowMs: number): NotificationsSnapshot;                     // open ones, newest first
  flushSync(): void;
}

const LEVELS: NotificationLevel[] = ['warn', 'action'];
const SOURCE_KINDS: NotificationSource['kind'][] = ['chat', 'routine', 'app'];

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const isoOrUndef = (v: unknown): string | undefined => {
  const s = str(v);
  return s && Number.isFinite(Date.parse(s)) ? s : undefined;
};
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// Sanitizers return null when the record must be dropped: an unknown level
// means a newer app wrote it, and we cannot show it faithfully. Fields this app
// no longer knows — e.g. `questions` / `todos` / `answersDelivery` from the
// retired in-app answering UI — are simply not copied over.
function sanitizeFile(f: any): NotificationFile | null {
  const p = str(f?.path);
  if (!p) return null;
  const label = str(f.label);
  return label ? { path: p, label } : { path: p };
}

function sanitizeSource(s: any): NotificationSource {
  const out: NotificationSource = { kind: SOURCE_KINDS.includes(s?.kind) ? s.kind : 'app' };
  if (!s || typeof s !== 'object') return out;
  for (const k of ['conversationId', 'conversationTitle', 'directoryId', 'peerName', 'routineId', 'routineName', 'runId'] as const) {
    const v = str(s[k]);
    if (v) out[k] = v;
  }
  if (s.auto === true) out.auto = true;
  return out;
}

function sanitizeNotification(n: any): UserNotification | null {
  if (!n || typeof n !== 'object') return null;
  const id = str(n.id);
  const title = str(n.title);
  const createdAt = isoOrUndef(n.createdAt);
  if (!id || !title || !createdAt || !LEVELS.includes(n.level)) return null;
  const files = arr(n.files).map(sanitizeFile).filter((f): f is NotificationFile => !!f);
  const out: UserNotification = {
    id,
    level: n.level as NotificationLevel,
    title,
    source: sanitizeSource(n.source),
    createdAt,
    files,
  };
  const body = str(n.body);
  if (body) out.body = body;
  const readAt = isoOrUndef(n.readAt);
  if (readAt) out.readAt = readAt;
  const dismissedAt = isoOrUndef(n.dismissedAt);
  if (dismissedAt) out.dismissedAt = dismissedAt;
  return out;
}

function writeFileAtomicSync(target: string, data: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, target);
}

const newestFirst = (a: UserNotification, b: UserNotification) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

/**
 * `now` is a test seam for the retention prune; production uses the wall clock.
 */
export function createNotificationsStore(filePath: string, opts: { now?: () => number } = {}): NotificationsStore {
  const now = opts.now ?? Date.now;
  const byId = new Map<string, UserNotification>();
  let saveTimer: NodeJS.Timeout | null = null;
  let lastPruneMs = 0;

  /** Dismissed notices go after DISMISSED_RETENTION_DAYS; open ones nobody touched after OPEN_RETENTION_DAYS. */
  function prune(): boolean {
    const t = now();
    const dismissedCutoff = t - DISMISSED_RETENTION_DAYS * DAY_MS;
    const openCutoff = t - OPEN_RETENTION_DAYS * DAY_MS;
    let changed = false;
    for (const n of [...byId.values()]) {
      const old = n.dismissedAt ? Date.parse(n.dismissedAt) < dismissedCutoff : Date.parse(n.createdAt) < openCutoff;
      if (old) { byId.delete(n.id); changed = true; }
    }
    lastPruneMs = t;
    return changed;
  }

  function load(): void {
    let raw: any = null;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') console.error('[agentsflow][notifications] could not read notifications.json, starting empty', err);
    }
    let dropped = 0;
    for (const n of arr(raw?.notifications)) {
      const clean = sanitizeNotification(n);
      if (!clean) { dropped++; continue; }
      if (!byId.has(clean.id)) byId.set(clean.id, clean);
    }
    if (dropped) console.error(`[agentsflow][notifications] dropped ${dropped} unreadable notification(s) from notifications.json`);
    if (prune() || dropped) scheduleSave();
  }

  function serialize(): string {
    const shape: FileShape = { version: FILE_VERSION, notifications: [...byId.values()].sort(newestFirst) };
    return JSON.stringify(shape, null, 2);
  }

  function flushSync(): void {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      writeFileAtomicSync(filePath, serialize());
    } catch (err) {
      console.error('[agentsflow][notifications] save failed', err);
    }
  }

  function scheduleSave(): void {
    // The daily prune piggybacks on writes: a store nobody writes to has nothing new to prune.
    if (now() - lastPruneMs >= DAY_MS) prune();
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; flushSync(); }, SAVE_DEBOUNCE_MS);
    saveTimer.unref?.();
  }

  const listAll = () => [...byId.values()].sort(newestFirst);

  load();

  return {
    list(o = {}) {
      const all = listAll();
      return o.includeDismissed ? all : all.filter(isOpen);
    },
    get: (id) => byId.get(id) ?? null,
    add(n) {
      byId.set(n.id, n);
      scheduleSave();
      return n;
    },
    update(id, patch) {
      const cur = byId.get(id);
      if (!cur) return null;
      const next: UserNotification = { ...cur, ...patch, id: cur.id };
      byId.set(id, next);
      scheduleSave();
      return next;
    },
    findOpen: (pred) => listAll().find((n) => isOpen(n) && pred(n)) ?? null,
    snapshot: (nowMs) => {
      return { notifications: listAll().filter(isOpen), now: new Date(nowMs).toISOString() };
    },
    flushSync,
  };
}
