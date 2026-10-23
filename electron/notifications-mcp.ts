/**
 * Notifications as raised by an agent: the main-process half of the `notify`
 * MCP tool, plus the rules the IPC applies to a notice (mark read, dismiss) so
 * the tool and the UI can never disagree. A notice is only a pointer to its
 * chat: the agent writes its questions / to-dos as plain text in its own chat
 * reply, and the user answers there by typing. Nothing is answered in the app's
 * notification UI.
 *
 * Dependency-free on purpose (no `electron`): the bridge hands
 * `buildNotificationFromArgs` the raw tool arguments, everything is validated
 * here, and the tests drive it on plain node.
 */
import {
  NOTIFICATION_LIMITS,
  type NotificationFile,
  type NotificationLevel,
  type NotificationSource,
  type Routine,
  type RoutineRun,
  type UserNotification,
} from '../shared/notifications';

export interface NotifyContext { id: string; now: string; source: NotificationSource; resolvePath: (p: string) => string }

type Args = Record<string, unknown>;

const LEVELS: NotificationLevel[] = ['warn', 'action'];

const isObj = (v: unknown): v is Args => !!v && typeof v === 'object' && !Array.isArray(v);

/** A trimmed optional string field; throws when present but not text, or longer than `max`. */
function optText(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${what} must be text`);
  const s = v.trim();
  if (s.length > max) throw new Error(`${what} is longer than ${max} characters`);
  return s || undefined;
}

function reqText(v: unknown, what: string, max: number): string {
  const s = optText(v, what, max);
  if (!s) throw new Error(`${what} is required`);
  return s;
}

function list(v: unknown, what: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`\`${what}\` must be a list`);
  if (v.length > max) throw new Error(`at most ${max} ${what}`);
  return v;
}

/** Raw `notify` arguments → a UserNotification. Throws Error with ONE human line. */
export function buildNotificationFromArgs(raw: unknown, ctx: NotifyContext): UserNotification {
  if (!isObj(raw)) throw new Error('notify needs an object of arguments');
  const L = NOTIFICATION_LIMITS;
  const title = reqText(raw.title, '`title`', L.title);
  if (!LEVELS.includes(raw.level as NotificationLevel)) throw new Error('level must be "warn" or "action"');
  const level = raw.level as NotificationLevel;
  const body = optText(raw.body, '`body`', L.body);
  // The in-app question / to-do UI is gone: an agent still sending them would
  // believe the user sees them, so say where they belong instead.
  if (raw.questions !== undefined || raw.todos !== undefined) {
    throw new Error('notify takes no `questions` or `todos`: write them as plain text in your chat reply, then call notify with a short pointer `body`');
  }

  const files: NotificationFile[] = list(raw.files, 'files', L.files).map((f, i) => {
    if (!isObj(f)) throw new Error(`file ${i + 1}: must be an object with a \`path\``);
    const p = reqText(f.path, `file ${i + 1}: \`path\``, 4096);
    const label = optText(f.label, `file ${i + 1}: \`label\``, L.title);
    return label ? { path: ctx.resolvePath(p), label } : { path: ctx.resolvePath(p) };
  });

  const n: UserNotification = { id: ctx.id, level, title, source: ctx.source, createdAt: ctx.now, files };
  if (body) n.body = body;
  return n;
}

/** The tool's success envelope. */
export function describeForTool(n: UserNotification): Record<string, unknown> {
  return {
    status: 'success',
    id: n.id,
    level: n.level,
    title: n.title,
    files: n.files.length,
    note: n.level === 'action'
      ? 'The bell points the user to this chat. They read your questions / to-dos in your chat reply and answer by typing in this chat — end your turn now.'
      : 'The user will see this in the bell.',
  };
}

/** Sets readAt once: the first expand is what counts. */
export function markRead(n: UserNotification, now: string): UserNotification {
  return n.readAt ? n : { ...n, readAt: now };
}

/** Always allowed: the drawer notice is only a pointer. */
export function dismissNotification(n: UserNotification, now: string): UserNotification {
  return n.dismissedAt ? n : { ...n, dismissedAt: now };
}

/** The app's own warning for a run that failed or was missed. */
export function buildRunWarning(
  run: RoutineRun,
  routine: Routine | null,
  peerName: string | null,
  id: string,
  now: string,
  formatSlot: (iso: string) => string,
): UserNotification {
  const name = routine?.name ?? 'A routine';
  const missed = run.status === 'missed';
  const title = missed ? `${name} was missed` : `${name} did not finish`;
  const body = missed
    ? `Its ${formatSlot(run.slotAt)} run never started (the app was off, or the slot was too old to catch up). Use Run now in the Routines tab to run it by hand.`
    : `${run.error ?? 'The chat ended with an error.'} · Run of ${formatSlot(run.slotAt)}. Open the chat to see why, or use Run now in the Routines tab.`;
  const source: NotificationSource = { kind: 'routine', routineId: run.routineId, runId: run.id, auto: true };
  if (routine?.name) source.routineName = routine.name;
  if (run.conversationId) source.conversationId = run.conversationId;
  if (routine?.directoryId) source.directoryId = routine.directoryId;
  if (peerName) source.peerName = peerName;
  return { id, level: 'warn', title, body, source, createdAt: now, files: [] };
}

/**
 * The app's own warning for a routine chat that started without its peersflow
 * MCP server (it never said hello over the bridge). Not `auto`: the run may still
 * succeed, and marking it done must not silently clear this.
 */
export function buildMcpMissingWarning(
  run: RoutineRun,
  routine: Routine | null,
  peerName: string | null,
  id: string,
  now: string,
  formatSlot: (iso: string) => string,
): UserNotification {
  const title = `${routine?.name ?? 'A routine'}: Peers Flow tools never connected`;
  const body = `Its chat (run of ${formatSlot(run.slotAt)}) started without the peersflow MCP server, so it cannot delegate, notify or start another routine. Open the chat to see what it did; use Run now in the Routines tab to run it again.`;
  const source: NotificationSource = { kind: 'routine', routineId: run.routineId, runId: run.id };
  if (run.conversationId) source.conversationId = run.conversationId;
  if (routine?.name) source.routineName = routine.name;
  if (routine?.directoryId) source.directoryId = routine.directoryId;
  if (peerName) source.peerName = peerName;
  return { id, level: 'warn', title, body, source, createdAt: now, files: [] };
}

/** A macOS banner only for something that needs the user, and only when they are not looking at the app. */
export function shouldShowSystemNotification(n: UserNotification, windowFocused: boolean): boolean {
  return n.level === 'action' && !windowFocused;
}
