import { Conversation } from '../../shared/types';
import { statusDotClass } from '../lib/status';

interface Props {
  conv: Conversation;
  onAttach: () => void;
  // Whether this peer row is the currently-selected element (independent of its
  // root row). Drives its own orange left rail — the unit never selects as one.
  selected?: boolean;
}

/**
 * A delegated peer session, indented to the right of its root's dot column. The
 * `⤷` arrow alone marks the nesting — there's no persistent left rail; the 2px
 * left border is transparent until selected, when it shows the orange selection
 * indicator. Hovers and selects on its own; click to open/preview.
 */
export default function DelegatedChildRow({ conv, onAttach, selected }: Props) {
  const ready = !!conv.sessionId;

  return (
    <div
      data-testid={`delegated-row-${conv.id}`}
      onClick={() => { if (ready) onAttach(); }}
      className={`relative flex items-center gap-2 pl-[50px] pr-4 py-1.5 border-l-2 ${selected ? 'border-l-accent bg-panel2' : 'border-l-transparent'} border-b border-b-border/50 last:border-b-0 text-[13px] ${ready ? 'cursor-pointer hover:bg-panel2' : 'opacity-70'}`}
      title={ready ? 'Open the delegated peer — watch it work live' : 'Peer is still starting…'}
    >
      {/* nesting arrow marking the peer (no persistent rail) */}
      <span className="text-muted/70 shrink-0 text-[13px] leading-none -translate-y-px" aria-hidden>⤷</span>
      <span
        className={`inline-block w-2 h-2 rounded-full shrink-0 ${statusDotClass(conv, true)}`}
        title={conv.state || conv.status || 'idle'}
      />
      <span className="font-medium text-text/90 shrink-0">{conv.displayName}</span>
      <span className="text-muted text-xs shrink-0">·</span>
      <span className="truncate text-text/70 min-w-0 flex-1" title={conv.title || conv.description}>
        {conv.title || <span className="italic text-muted">delegated task</span>}
      </span>
    </div>
  );
}
