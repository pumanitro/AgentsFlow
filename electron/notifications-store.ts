import * as fs from 'fs';
import * as path from 'path';
import {
  DISMISSED_RETENTION_DAYS,
  OPEN_RETENTION_DAYS,
  isOpen,
  type AnswersDelivery,
  type NotificationFile,
  type NotificationLevel,
  type NotificationQuestion,
  type NotificationSource,
  type NotificationTodo,
  type NotificationsSnapshot,
  type QuestionKind,
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
  snapshot(nowMs: number): NotificationsSnapshot;                     // open only, newest first
  flushSync(): void;
}

const LEVELS: NotificationLevel[] = ['warn', 'action'];
const KINDS: QuestionKind[] = ['yesno', 'choice', 'text'];
const SOURCE_KINDS: NotificationSource['kind'][] = ['chat', 'routine', 'app'];
const DELIVERY_VIA: NonNullable<AnswersDelivery['via']>[] = ['open-chat', 'headless', 'resume', 'codex'];

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const isoOrUndef = (v: unknown): string | undefined => {
  const s = str(v);
  return s && Number.isFinite(Date.parse(s)) ? s : undefined;
};
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// Sanitizers return null when the record must be dropped: an unknown level or
// question kind means a newer app wrote it, and we cannot show it faithfully.
function sanitizeQuestion(q: any): NotificationQuestion | null {
  if (!q || typeof q !== 'object') return null;
  const id = str(q.id);
  const text = str(q.text);
  if (!id || text === undefined || !KINDS.includes(q.kind)) return null;
  const out: NotificationQuestion = { id, text, kind: q.kind as QuestionKind };
  if (Array.isArray(q.choices)) out.choices = q.choices.filter((c: unknown): c is string => typeof c === 'string');
  for (const k of ['hint', 'answer'] as const) {
    const v = str(q[k]);
    if (v !== undefined) out[k] = v;
  }
  const answeredAt = isoOrUndef(q.answeredAt);
  if (answeredAt) out.answeredAt = answeredAt;
  return out;
}

function sanitizeTodo(t: any): NotificationTodo | null {
  if (!t || typeof t !== 'object') return null;
  const id = str(t.id);
  const text = str(t.text);
  if (!id || text === undefined) return null;
  const out: NotificationTodo = { id, text, done: t.done === true };
  const doneAt = isoOrUndef(t.doneAt);
  if (doneAt) out.doneAt = doneAt;
  return out;
}

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

function sanitizeDelivery(d: any): AnswersDelivery | undefined {
  const at = isoOrUndef(d?.at);
  if (!at) return undefined;
  const out: AnswersDelivery = { at, ok: d.ok === true };
  if (DELIVERY_VIA.includes(d.via)) out.via = d.via;
  const error = str(d.error);
  if (error) out.error = error;
  return out;
}

function sanitizeNotification(n: any): UserNotification | null {
  if (!n || typeof n !== 'object') return null;
  const id = str(n.id);
  const title = str(n.title);
  const createdAt = isoOrUndef(n.createdAt);
  if (!id || !title || !createdAt || !LEVELS.includes(n.level)) return null;
  const questions: NotificationQuestion[] = [];
  for (const q of arr(n.questions)) {
    const clean = sanitizeQuestion(q);
    if (!clean) return null;
    questions.push(clean);
  }
  const todos = arr(n.todos).map(sanitizeTodo).filter((t): t is NotificationTodo => !!t);
  const files = arr(n.files).map(sanitizeFile).filter((f): f is NotificationFile => !!f);
  const out: UserNotification = {
    id,
    level: n.level as NotificationLevel,
    title,
    source: sanitizeSource(n.source),
    createdAt,
    files,
    questions,
    todos,
  };
  const body = str(n.body);
  if (body) out.body = body;
  const readAt = isoOrUndef(n.readAt);
  if (readAt) out.readAt = readAt;
  const dismissedAt = isoOrUndef(n.dismissedAt);
  if (dismissedAt) out.dismissedAt = dismissedAt;
  const delivery = sanitizeDelivery(n.answersDelivery);
  if (delivery) out.answersDelivery = delivery;
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
    snapshot: (nowMs) => ({ notifications: listAll().filter(isOpen), now: new Date(nowMs).toISOString() }),
    flushSync,
  };
}
