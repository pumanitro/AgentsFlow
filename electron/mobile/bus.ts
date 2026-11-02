// In-process change bus: the poller and notifications emit here, the mobile gateway listens.
import { EventEmitter } from 'node:events';

export const mobileBus = new EventEmitter();

export function emitConversationsChanged(): void {
  mobileBus.emit('conversations.changed');
}

export function emitNotificationsChanged(): void {
  mobileBus.emit('notifications.changed');
}
