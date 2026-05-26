import { useEffect } from 'react';
import { Conversation, TrackedDirectory } from '../../shared/types';
import { statusDotClass } from '../lib/status';

interface Props {
  dir: TrackedDirectory;
  conversations: Conversation[];
  onClose: () => void;
  onAttach: (c: Conversation) => void;
  onTogglePin: (c: Conversation) => void;
  onRemove: (c: Conversation) => void;
}

function relTime(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export default function HistoryModal({ dir, conversations, onClose, onAttach, onTogglePin, onRemove }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sorted = [...conversations].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl max-h-[80vh] bg-panel border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        <header className="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text truncate">History · {dir.displayName}</div>
            <div className="text-xs text-muted font-mono truncate">{dir.path}</div>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text px-2 py-1 rounded hover:bg-panel2"
            title="Close"
          >✕</button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {sorted.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted">
              No conversations yet for this directory. Spawn one from the home screen.
            </div>
          ) : (
            sorted.map((c) => (
              <div
                key={c.id}
                className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3 border-b border-border hover:bg-panel2"
              >
                <span className={`inline-block w-2 h-2 rounded-full ${statusDotClass(c)}`} />
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <div className="truncate text-sm font-medium text-text">{c.title || <span className="text-muted italic">untitled</span>}</div>
                    <div className="text-[11px] text-muted shrink-0">{relTime(c.createdAt)}</div>
                    <div className="text-[10px] text-muted shrink-0">{c.state || c.status || ''}</div>
                  </div>
                  <div className="truncate text-xs text-muted mt-0.5">{c.description || <span className="italic">—</span>}</div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onTogglePin(c)}
                    className={`text-xs px-2 py-1 rounded hover:bg-panel flex items-center gap-1 ${c.pinned ? 'text-muted hover:text-ok' : 'text-muted hover:text-accent'}`}
                    title={c.pinned ? 'Mark done (move to history)' : 'Reopen on home'}
                  >
                    {c.pinned ? (
                      <>
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 11.207L3.146 7.854l.708-.708L6.5 9.793l5.646-5.647.708.708L6.5 11.207z"/></svg>
                        Done
                      </>
                    ) : (
                      <>
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 100 10 5 5 0 000-10zM2 8a6 6 0 1112 0A6 6 0 012 8zm7-3v3h2v1H8V5h1z"/></svg>
                        Reopen
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => onAttach(c)}
                    disabled={!c.sessionId}
                    className="text-xs px-2 py-1 rounded text-muted hover:text-text hover:bg-panel disabled:opacity-40 disabled:cursor-not-allowed"
                    title={c.sessionId ? 'Attach terminal' : 'Session is still starting…'}
                  >open →</button>
                  <button
                    onClick={() => onRemove(c)}
                    className="text-xs px-2 py-1 rounded text-muted hover:text-err hover:bg-panel"
                    title="Stop & remove forever"
                  >✕</button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
