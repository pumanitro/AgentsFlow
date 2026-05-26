import { useEffect, useRef, useState } from 'react';
import { Conversation } from '../../shared/types';
import { statusDotClass } from '../lib/status';

interface Props {
  conv: Conversation;
  onAttach: () => void;
  onSaveTitle: (title: string) => void;
  onResetTitle: () => void;
  onMarkDone: () => void;
  focused: boolean;
  onFocus: () => void;
}

export default function PinnedRow({ conv, onAttach, onSaveTitle, onResetTitle, onMarkDone, focused, onFocus }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conv.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(conv.title);
  }, [conv.title, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v !== conv.title) onSaveTitle(v);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(conv.title);
  };

  const ready = !!conv.sessionId;
  const titleMirrorsDescription = !conv.titleLocked && conv.title === conv.description;

  const handleRowClick = () => {
    // eslint-disable-next-line no-console
    console.log('[agentsflow] row clicked', { id: conv.id, sessionId: conv.sessionId, ready });
    onFocus();
    if (ready) onAttach();
  };

  return (
    <div
      data-focused={focused}
      data-testid={`pinned-row-${conv.id}`}
      onClick={handleRowClick}
      className={`group grid grid-cols-[200px_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 border-l-2 ${focused ? 'border-l-accent bg-panel2' : 'border-l-transparent hover:bg-panel2'} border-b border-b-border cursor-pointer ${ready ? '' : 'opacity-80'}`}
      title={ready ? 'Open terminal' : 'Session is still starting…'}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${statusDotClass(conv)}`}
          title={conv.state || conv.status || 'idle'}
        />
        <div className="truncate text-text font-medium">{conv.displayName}</div>
      </div>

      <div className="min-w-0 flex items-center gap-2">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 bg-panel border border-border rounded px-2 py-1 text-sm text-text outline-none focus:border-accent"
          />
        ) : (
          <div className="min-w-0 flex items-center gap-1 flex-1">
            <button
              type="button"
              onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
              onClick={(e) => e.stopPropagation()}
              className={`min-w-0 truncate text-left text-sm select-text rounded px-1 -mx-1 hover:bg-bg/40 ${conv.titleLocked ? 'text-text/90' : titleMirrorsDescription ? 'text-muted italic' : 'text-text/90'}`}
              title="Double-click to rename"
            >
              {conv.title || <span className="text-muted italic">—</span>}
              {conv.titleLocked && <span className="ml-1 text-[10px] text-accent/80" title="Locked — auto-sync paused">●</span>}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setEditing(true); }}
              className="shrink-0 text-muted hover:text-accent p-1 rounded hover:bg-bg/40 opacity-60 group-hover:opacity-100"
              title="Rename title"
              aria-label="Rename title"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.207 2.5l2.293 2.293-8.5 8.5-2.293-.707-.707-2.293 8.5-8.5zm.707-.707l1-1a1 1 0 011.414 0l1.293 1.293a1 1 0 010 1.414l-1 1L11.914 1.793zM2 14h12v1H2v-1z"/></svg>
            </button>
            {conv.titleLocked && (
              <button
                onClick={(e) => { e.stopPropagation(); onResetTitle(); }}
                className="shrink-0 text-[11px] text-muted hover:text-accent px-1.5 py-0.5 rounded hover:bg-panel opacity-60 group-hover:opacity-100"
                title="Restore auto-sync from Claude"
              >↺ auto</button>
            )}
          </div>
        )}
      </div>

      <div className="min-w-0 truncate text-sm text-text/85" title={conv.description}>
        {ready ? (conv.description || <span className="text-muted italic">—</span>) : <span className="text-muted italic">starting…</span>}
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={(e) => { e.stopPropagation(); onMarkDone(); }}
          className="text-xs text-muted hover:text-ok hover:bg-ok/10 px-2 py-1 rounded border border-transparent hover:border-ok/40 flex items-center gap-1 opacity-70 group-hover:opacity-100"
          title="Mark done (moves to history, can be reopened)"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 11.207L3.146 7.854l.708-.708L6.5 9.793l5.646-5.647.708.708L6.5 11.207z"/></svg>
          Done
        </button>
      </div>
    </div>
  );
}
