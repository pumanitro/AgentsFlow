import { ACTION_POINTER_LINE } from '../../../shared/notifications';
import type { UserNotification } from '../../../shared/notifications';
import { formatSlot } from '../../../shared/routine-schedule';
import NotificationFiles, { type FileActions } from './NotificationFiles';

const PRIMARY = 'px-3 py-1 text-[11px] uppercase tracking-wider rounded-md bg-accent text-bg font-semibold hover:bg-accent2';
// The Routines preview's button, so Dismiss reads as one of the app's own.
const BTN = 'px-3 py-1 text-[11px] uppercase tracking-wider rounded-md border border-border bg-panel text-muted hover:text-text hover:bg-panel2';

export const hhmm = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
};

/**
 * One "needs you" notice in the drawer. It is only a pointer: the title, the
 * chat it came from, "Look inside the chat — it needs you", the agent's body,
 * the attached files and "Open chat ›". The agent wrote its questions / to-dos
 * as plain text in that chat, and the user answers there by typing — nothing is
 * answered here. Dismiss is always available.
 */
export default function NotificationCard({ n, fileActions, onOpenChat, onDismiss }: {
  n: UserNotification;
  fileActions: FileActions;
  onOpenChat?: (conversationId: string) => void;
  onDismiss: () => void;
}) {
  const from = n.source.conversationTitle ?? n.source.routineName ?? 'a chat';
  const convId = n.source.conversationId;

  return (
    <div className="border border-orange-500/55 border-l-[3px] border-l-orange-500 rounded-md bg-panel2/45 p-2.5 flex flex-col gap-2">
      <div className="flex gap-2 items-start">
        <span className="mt-1.5 shrink-0 w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
        <span className="text-[13px] font-semibold leading-[18px] text-text">{n.title}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-subtle" title={`Arrived ${formatSlot(n.createdAt)}`}>{hhmm(n.createdAt)}</span>
      </div>
      <div className="pl-4 flex flex-col gap-1">
        <div className="text-[11px] text-subtle">from <span className="text-muted">{from}</span></div>
        {convId && <div className="text-[12px] text-orange-400">{ACTION_POINTER_LINE}</div>}
        {n.body && <div className="text-[12px] leading-[17px] text-muted whitespace-pre-wrap break-words">{n.body}</div>}
      </div>
      {n.files.length > 0 && <div className="pl-4"><NotificationFiles files={n.files} actions={fileActions} /></div>}
      <div className="pl-4 flex items-center gap-2">
        {convId && onOpenChat && (
          <button type="button" className={PRIMARY} onClick={() => onOpenChat(convId)}>Open chat ›</button>
        )}
        <button
          type="button"
          className={`${BTN} ml-auto`}
          title="Clear this notice"
          onClick={onDismiss}
        >Dismiss</button>
      </div>
    </div>
  );
}
