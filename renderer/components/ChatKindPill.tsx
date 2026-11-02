import { Conversation } from '../../shared/types';

// Renders null unless the chat was started by a routine or by voice from the phone. One component so the
// three views can never drift (list row, chat header, history).
export default function ChatKindPill({ conv, className = '' }: { conv: Pick<Conversation, 'chatKind'>; className?: string }): JSX.Element | null {
  const isVoice = conv.chatKind === 'voice';
  if (conv.chatKind !== 'routine' && !isVoice) return null;
  return (
    <span
      className={`shrink-0 text-[10px] uppercase tracking-wider leading-none px-1 py-0.5 rounded border border-border text-text/80 ${className}`}
      title={isVoice ? 'Started from the phone by voice — it may notify you through the bell' : 'Started by a routine — it may notify you through the bell'}
    >
      {isVoice ? 'voice' : 'routine'}
    </span>
  );
}
