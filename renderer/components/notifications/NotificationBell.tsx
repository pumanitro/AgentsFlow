import { useNotificationsUI } from '../../lib/use-notifications';

/** The bell path shared by the header button and the drawer's title. */
export function BellIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/**
 * The bell in every header: an orange count for notices that need the user,
 * a yellow dot while a warning is open. Clicking toggles the drawer. Hidden
 * when this main cannot serve notifications yet (see use-notifications).
 */
export default function NotificationBell() {
  const { available, counts, open, setOpen, ring } = useNotificationsUI();
  if (!available) return null;
  const parts = [`${counts.action} need${counts.action === 1 ? 's' : ''} you`];
  if (counts.warn) parts.push(`${counts.warn} went wrong`);
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-label="Notifications"
      aria-expanded={open}
      title={`Notifications (${parts.join(', ')})`}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className={`relative shrink-0 w-6 h-6 rounded-md border border-border bg-panel hover:bg-panel2 hover:border-accent text-muted hover:text-accent flex items-center justify-center${
        open ? ' border-accent text-accent bg-panel2' : ''
      }${ring ? ' ring-[3px] ring-orange-500/60' : ''}`}
    >
      <BellIcon />
      {counts.action > 0 && (
        <span className="absolute -top-1.5 -right-[7px] min-w-[15px] h-[15px] px-1 rounded-full bg-orange-500 text-bg text-[10px] font-bold leading-[15px] text-center ring-2 ring-bg">
          {counts.action}
        </span>
      )}
      {counts.warn > 0 && (
        <span className="absolute -bottom-[3px] -right-[3px] w-[7px] h-[7px] rounded-full bg-warn ring-2 ring-bg" />
      )}
    </button>
  );
}
