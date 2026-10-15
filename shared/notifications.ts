import type { Routine, RoutineRun } from './routines';

// Notifications the app shows the user: raised by an agent through the
// `notify` MCP tool, or by the app itself when a routine run fails or is
// missed. Two levels only — there is deliberately no "info": a chat that
// finished with nothing needed is already visible as a green dot.
export type NotificationLevel = 'warn' | 'action';
export type QuestionKind = 'yesno' | 'choice' | 'text';

export interface NotificationQuestion {
  id: string;
  text: string;
  kind: QuestionKind;
  choices?: string[];      // choice: 2..12 options
  hint?: string;           // what the agent found / assumed
  answer?: string;         // yesno: 'yes' | 'no'; choice: one of choices; text: free text
  answeredAt?: string;     // ISO
}
export interface NotificationTodo { id: string; text: string; done: boolean; doneAt?: string }
export interface NotificationFile { path: string; label?: string }   // absolute path (resolved by main)

export interface NotificationSource {
  kind: 'chat' | 'routine' | 'app';
  conversationId?: string;
  conversationTitle?: string;   // denormalized at creation, for the "from …" line
  directoryId?: string;
  peerName?: string;
  routineId?: string;
  routineName?: string;
  runId?: string;
  auto?: boolean;               // raised by the app (failed / missed run), not by an agent
}

// The last "Send answers" attempt. A failed attempt the user has seen still
// unlocks Dismiss: a chat that no longer exists must not lock a notice forever.
export interface AnswersDelivery {
  at: string;
  ok: boolean;
  via?: 'open-chat' | 'headless' | 'resume' | 'codex';
  error?: string;
}

// Not `Notification`: Electron's main process has a global class of that name.
export interface UserNotification {
  id: string;
  level: NotificationLevel;
  title: string;
  body?: string;
  source: NotificationSource;
  createdAt: string;            // ISO
  readAt?: string;              // first time its card was expanded
  dismissedAt?: string;         // set = gone from the drawer; kept on disk for a while
  files: NotificationFile[];
  questions: NotificationQuestion[];
  todos: NotificationTodo[];
  answersDelivery?: AnswersDelivery;
}

export interface NotificationsSnapshot {
  notifications: UserNotification[];   // open (not dismissed) ones only, newest first
  now: string;                          // main's clock, ISO
}

export const NOTIFICATIONS_IPC = {
  list: 'notifications:list',               // () → NotificationsSnapshot
  markRead: 'notifications:markRead',       // (id) → UserNotification
  answer: 'notifications:answer',           // (id, questionId, answer) → UserNotification; rejects with a one-line message on a bad answer
  setTodo: 'notifications:setTodo',         // (id, todoId, done) → UserNotification
  sendAnswers: 'notifications:sendAnswers', // (id) → UserNotification with answersDelivery set; rejects when a question is unanswered
  dismiss: 'notifications:dismiss',         // (id) → UserNotification; rejects when !canDismiss
  openFile: 'notifications:openFile',       // (id, path) → { status: 'success' | 'failure'; error?: string }
  updated: 'notifications:updated',         // push: NotificationsSnapshot on every change
  open: 'notifications:open',               // push: { id } — open the drawer on this one (macOS banner click)
} as const;

export const NOTIFICATION_LIMITS = { title: 200, body: 4000, files: 20, questions: 20, todos: 20, choices: 12, answer: 4000 } as const;
export const DISMISSED_RETENTION_DAYS = 30;   // dismissed notices are pruned from the file after this
export const OPEN_RETENTION_DAYS = 180;       // an open notice nobody touched for this long is pruned too

export const isOpen = (n: Pick<UserNotification, 'dismissedAt'>) => !n.dismissedAt;
export const allAnswered = (n: Pick<UserNotification, 'questions'>) => n.questions.every((q) => typeof q.answer === 'string' && q.answer.length > 0);
export const allTodosDone = (n: Pick<UserNotification, 'todos'>) => n.todos.every((t) => t.done);
/** Answers only need sending when there is a question to answer. */
export const needsSend = (n: Pick<UserNotification, 'questions'>) => n.questions.length > 0;
/** A delivery the user attempted counts even when it failed (the error is shown to them). */
export const answersSent = (n: Pick<UserNotification, 'answersDelivery'>) => !!n.answersDelivery;

/** What still blocks Dismiss, in the user's words. Empty = may dismiss. */
export function missingForDismiss(n: UserNotification): string[] {
  if (n.level !== 'action') return [];
  const out: string[] = [];
  const unanswered = n.questions.filter((q) => !(typeof q.answer === 'string' && q.answer.length > 0)).length;
  if (unanswered) out.push(unanswered === 1 ? '1 question unanswered' : `${unanswered} questions unanswered`);
  const open = n.todos.filter((t) => !t.done).length;
  if (open) out.push(open === 1 ? '1 to-do not ticked' : `${open} to-dos not ticked`);
  if (needsSend(n) && !unanswered && !answersSent(n)) out.push('answers not sent to the agent yet');
  return out;
}
export const canDismiss = (n: UserNotification) => missingForDismiss(n).length === 0;

/** Badge numbers for the bell: open "needs you" notices, and whether any warning is open. */
export function countsOf(list: UserNotification[]): { action: number; warn: number } {
  let action = 0, warn = 0;
  for (const n of list) { if (!isOpen(n)) continue; if (n.level === 'action') action++; else warn++; }
  return { action, warn };
}

// Re-exported so main's run → warning builder and the scheduler hook share one vocabulary.
export type { Routine, RoutineRun };
