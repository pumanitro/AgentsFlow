import type { Routine, RoutineRun } from './routines';

// Notifications the app shows the user: raised by an agent through the
// `notify` MCP tool, or by the app itself when a routine run fails or is
// missed. Two levels only — there is deliberately no "info": a chat that
// finished with nothing needed is already visible as a green dot.
export type NotificationLevel = 'warn' | 'action';
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

// Not `Notification`: Electron's main process has a global class of that name.
export interface UserNotification {
  id: string;
  level: NotificationLevel;
  title: string;
  body?: string;
  source: NotificationSource;
  createdAt: string;            // ISO
  readAt?: string;              // first time its card was shown in the open drawer
  dismissedAt?: string;         // set = gone from the drawer; kept on disk for a while
  files: NotificationFile[];
}

export interface NotificationsSnapshot {
  notifications: UserNotification[];   // open (not dismissed) ones only, newest first
  now: string;                          // main's clock, ISO
}

export const NOTIFICATIONS_IPC = {
  list: 'notifications:list',               // () → NotificationsSnapshot
  markRead: 'notifications:markRead',       // (id) → UserNotification
  dismiss: 'notifications:dismiss',         // (id) → UserNotification; always allowed
  openFile: 'notifications:openFile',       // (id, path) → { status: 'success' | 'failure'; error?: string }
  updated: 'notifications:updated',         // push: NotificationsSnapshot on every change
  open: 'notifications:open',               // push: { id } — open the drawer on this one (macOS banner click)
} as const;

export const NOTIFICATION_LIMITS = { title: 200, body: 4000, files: 20 } as const;
export const DISMISSED_RETENTION_DAYS = 30;   // dismissed notices are pruned from the file after this
export const OPEN_RETENTION_DAYS = 180;       // an open notice nobody touched for this long is pruned too

export const isOpen = (n: Pick<UserNotification, 'dismissedAt'>) => !n.dismissedAt;
/**
 * The drawer card's line for an "action" notice. The notice is only a pointer:
 * the agent asked its questions as plain text in its chat, and the user answers
 * there by typing. Nothing is ever answered inside Peers Flow's notification UI.
 */
export const ACTION_POINTER_LINE = 'Look inside the chat — it needs you';

/** Badge numbers for the bell: open "needs you" notices, and whether any warning is open. */
export function countsOf(list: UserNotification[]): { action: number; warn: number } {
  let action = 0, warn = 0;
  for (const n of list) { if (!isOpen(n)) continue; if (n.level === 'action') action++; else warn++; }
  return { action, warn };
}

// Re-exported so main's run → warning builder and the scheduler hook share one vocabulary.
export type { Routine, RoutineRun };
