/**
 * Notifications as raised by an agent: the main-process half of the `notify`
 * MCP tool, plus the rules the drawer's IPC applies to a notice (answer a
 * question, tick a to-do, dismiss) so the tool and the UI can never disagree.
 *
 * Dependency-free on purpose (no `electron`): the bridge hands
 * `buildNotificationFromArgs` the raw tool arguments, everything is validated
 * here, and the tests drive it on plain node.
 */
import {
  NOTIFICATION_LIMITS,
  canDismiss,
  missingForDismiss,
  type NotificationFile,
  type NotificationLevel,
  type NotificationQuestion,
  type NotificationSource,
  type NotificationTodo,
  type QuestionKind,
  type Routine,
  type RoutineRun,
  type UserNotification,
} from '../shared/notifications';

export interface NotifyContext { id: string; now: string; source: NotificationSource; resolvePath: (p: string) => string }

type Args = Record<string, unknown>;

const LEVELS: NotificationLevel[] = ['warn', 'action'];
const KINDS: QuestionKind[] = ['yesno', 'choice', 'text'];

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

/** A provided id wins; a repeated one gets `-2`, `-3`, … so answers can never land on the wrong question. */
function uniqueId(wanted: string, taken: Set<string>): string {
  let id = wanted;
  for (let i = 2; taken.has(id); i++) id = `${wanted}-${i}`;
  taken.add(id);
  return id;
}

/** Raw `notify` arguments → a UserNotification. Throws Error with ONE human line. */
export function buildNotificationFromArgs(raw: unknown, ctx: NotifyContext): UserNotification {
  if (!isObj(raw)) throw new Error('notify needs an object of arguments');
  const L = NOTIFICATION_LIMITS;
  const title = reqText(raw.title, '`title`', L.title);
  if (!LEVELS.includes(raw.level as NotificationLevel)) throw new Error('level must be "warn" or "action"');
  const level = raw.level as NotificationLevel;
  const body = optText(raw.body, '`body`', L.body);

  const files: NotificationFile[] = list(raw.files, 'files', L.files).map((f, i) => {
    if (!isObj(f)) throw new Error(`file ${i + 1}: must be an object with a \`path\``);
    const p = reqText(f.path, `file ${i + 1}: \`path\``, 4096);
    const label = optText(f.label, `file ${i + 1}: \`label\``, L.title);
    return label ? { path: ctx.resolvePath(p), label } : { path: ctx.resolvePath(p) };
  });

  const qIds = new Set<string>();
  const questions: NotificationQuestion[] = list(raw.questions, 'questions', L.questions).map((q, i) => {
    const n = i + 1;
    if (!isObj(q)) throw new Error(`question ${n}: must be an object with \`text\` and \`kind\``);
    const text = reqText(q.text, `question ${n}: \`text\``, L.body);
    if (!KINDS.includes(q.kind as QuestionKind)) throw new Error(`question ${n}: kind must be "yesno", "choice" or "text"`);
    const kind = q.kind as QuestionKind;
    const out: NotificationQuestion = { id: uniqueId(optText(q.id, `question ${n}: \`id\``, 100) ?? `q${n}`, qIds), text, kind };
    if (kind === 'choice') {
      const choices = Array.isArray(q.choices)
        ? q.choices.map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean)
        : [];
      if (choices.length < 2 || choices.length > L.choices || choices.length !== (q.choices as unknown[]).length) {
        throw new Error(`question ${n}: kind "choice" needs 2 to ${L.choices} choices`);
      }
      if (new Set(choices).size !== choices.length) throw new Error(`question ${n}: choices must all be different`);
      out.choices = choices;
    }
    const hint = optText(q.hint, `question ${n}: \`hint\``, L.body);
    if (hint) out.hint = hint;
    return out;
  });

  const todos: NotificationTodo[] = list(raw.todos, 'todos', L.todos).map((t, i) => {
    if (!isObj(t)) throw new Error(`to-do ${i + 1}: must be an object with \`text\``);
    return { id: `t${i + 1}`, text: reqText(t.text, `to-do ${i + 1}: \`text\``, L.body), done: false };
  });

  // A warning closes with one click, so nothing on it could ever hold the user to an answer.
  if (level === 'warn' && (questions.length || todos.length)) {
    throw new Error('questions and to-dos need level "action"');
  }

  const n: UserNotification = { id: ctx.id, level, title, source: ctx.source, createdAt: ctx.now, files, questions, todos };
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
    questions: n.questions.length,
    todos: n.todos.length,
    files: n.files.length,
    note: n.questions.length
      ? 'The user will see this in the bell. Answers arrive in this chat as a new message — end your turn now.'
      : 'The user will see this in the bell.',
  };
}

function findQuestion(n: UserNotification, questionId: string): NotificationQuestion {
  const q = n.questions.find((x) => x.id === questionId);
  if (!q) throw new Error(`question "${questionId}" not found`);
  return q;
}

/** Validate one answer and store it. Throws a one-line human message on a bad answer. */
export function applyAnswer(n: UserNotification, questionId: string, answer: string, now: string): UserNotification {
  const q = findQuestion(n, questionId);
  const raw = typeof answer === 'string' ? answer.trim() : '';
  let value: string;
  if (q.kind === 'yesno') {
    value = raw.toLowerCase();
    if (value !== 'yes' && value !== 'no') throw new Error('answer "yes" or "no"');
  } else if (q.kind === 'choice') {
    const choices = q.choices ?? [];
    if (!choices.includes(raw)) throw new Error(`pick one of: ${choices.join(', ')}`);
    value = raw;
  } else {
    if (!raw) throw new Error('the answer is empty');
    if (raw.length > NOTIFICATION_LIMITS.answer) throw new Error(`the answer is longer than ${NOTIFICATION_LIMITS.answer} characters`);
    value = raw;
  }
  return { ...n, questions: n.questions.map((x) => (x.id === q.id ? { ...x, answer: value, answeredAt: now } : x)) };
}

export function applyTodo(n: UserNotification, todoId: string, done: boolean, now: string): UserNotification {
  if (!n.todos.some((t) => t.id === todoId)) throw new Error(`to-do "${todoId}" not found`);
  return {
    ...n,
    todos: n.todos.map((t) => {
      if (t.id !== todoId) return t;
      const { doneAt: _drop, ...rest } = t;
      return done ? { ...rest, done: true, doneAt: now } : { ...rest, done: false };
    }),
  };
}

/** Sets readAt once: the first expand is what counts. */
export function markRead(n: UserNotification, now: string): UserNotification {
  return n.readAt ? n : { ...n, readAt: now };
}

export function dismissNotification(n: UserNotification, now: string): UserNotification {
  if (!canDismiss(n)) throw new Error(missingForDismiss(n).join(', '));
  return n.dismissedAt ? n : { ...n, dismissedAt: now };
}

const shownAnswer = (q: NotificationQuestion): string => {
  if (!q.answer) return '(no answer)';
  if (q.kind === 'yesno') return q.answer === 'yes' ? 'Yes' : q.answer === 'no' ? 'No' : q.answer;
  return q.answer;
};

/** The message that carries the user's answers back into the source chat. The agent reads this. */
export function formatAnswersMessage(n: UserNotification): string {
  const lines = [`[Peers Flow] The user answered your notification "${n.title}":`];
  n.questions.forEach((q, i) => lines.push(`${i + 1}. ${q.text} — ${shownAnswer(q)}`));
  if (n.todos.length) {
    lines.push(`To-dos the user keeps for themselves: ${n.todos.map((t) => `${t.text} (${t.done ? 'done' : 'not done yet'})`).join('; ')}.`);
  }
  lines.push("Continue the work with these answers. Do not do the user's to-dos.");
  return lines.join('\n');
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
  return { id, level: 'warn', title, body, source, createdAt: now, files: [], questions: [], todos: [] };
}

/** A macOS banner only for something that needs the user, and only when they are not looking at the app. */
export function shouldShowSystemNotification(n: UserNotification, windowFocused: boolean): boolean {
  return n.level === 'action' && !windowFocused;
}
