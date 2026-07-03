import { useEffect, useRef, useState } from 'react';
import { PinnedTodo } from '../../shared/types';

interface Props {
  todo: PinnedTodo;
  // Display name of the peer the task is scoped to, resolved by the parent.
  peerName: string;
  focused: boolean;
  suppressHover: boolean;
  justAdded?: boolean;
  // A freshly added task opens its editor immediately (mirrors DividerRow's
  // startInRename). Committing an empty text removes the row instead of
  // leaving a blank task behind.
  startInEdit: boolean;
  onEditHandled: () => void;
  onFocus: () => void;
  onSaveText: (text: string) => void;
  onToggleDone: () => void;
  onRemove: () => void;
  // Same contract as PinnedRow: lets the parent stop treating the row as a
  // drag source while the inline editor is open.
  onEditingChange?: (editing: boolean) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

export default function TodoRow({ todo, peerName, focused, suppressHover, justAdded, startInEdit, onEditHandled, onFocus, onSaveText, onToggleDone, onRemove, onEditingChange, draggable, onDragStart, onDragEnd }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(todo.text);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(todo.text);
  }, [todo.text, editing]);

  useEffect(() => {
    if (startInEdit) {
      setEditing(true);
      onEditingChange?.(true);
      onEditHandled();
    }
  }, [startInEdit, onEditHandled, onEditingChange]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const beginEdit = () => {
    setEditing(true);
    onEditingChange?.(true);
  };
  const commit = () => {
    setEditing(false);
    onEditingChange?.(false);
    const v = draft.trim();
    // A task with no text is useless — committing empty deletes the row
    // (covers abandoning the freshly-added editor without typing).
    if (!v && !todo.text) { onRemove(); return; }
    if (v && v !== todo.text) onSaveText(v);
  };
  const cancel = () => {
    setEditing(false);
    onEditingChange?.(false);
    if (!todo.text) { onRemove(); return; }
    setDraft(todo.text);
  };

  return (
    <div
      data-focused={focused}
      data-testid={`todo-row-${todo.id}`}
      draggable={draggable && !editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onFocus}
      className={`group grid grid-cols-[16px_200px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 border-l-2 ${focused ? 'border-l-accent bg-panel2' : `border-l-transparent ${suppressHover ? '' : 'hover:bg-panel2'}`} border-b border-b-border cursor-default ${justAdded ? 'row-just-added' : ''}`}
      title="Task · drag to reorder"
    >
      <span
        className="text-muted/60 group-hover:text-muted opacity-50 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0"
        title="Drag to reorder"
        aria-hidden
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="4" cy="4" r="1.4"/><circle cx="4" cy="8" r="1.4"/><circle cx="4" cy="12" r="1.4"/><circle cx="9" cy="4" r="1.4"/><circle cx="9" cy="8" r="1.4"/><circle cx="9" cy="12" r="1.4"/></svg>
      </span>

      <div className="flex items-center gap-2 min-w-0">
        {/* Square checkbox where a chat row shows its round status dot — the
            "this is a task, not an agent" marker, and the done control. */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleDone(); }}
          className="shrink-0 w-3.5 h-3.5 rounded-[3px] border-[1.5px] border-muted/70 hover:border-ok hover:bg-ok/15 flex items-center justify-center text-transparent hover:text-ok"
          title="Mark task done (moves to history, can be restored)"
          aria-label="Mark task done"
        >
          <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 11.207L3.146 7.854l.708-.708L6.5 9.793l5.646-5.647.708.708L6.5 11.207z"/></svg>
        </button>
        <div className="truncate text-text font-medium">{peerName}</div>
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
            placeholder="Describe the task…"
            className="flex-1 bg-panel border border-border rounded px-2 py-1 text-sm text-text outline-none focus:border-accent"
          />
        ) : (
          <div className="min-w-0 flex items-center gap-1 flex-1">
            <button
              type="button"
              onDoubleClick={(e) => { e.stopPropagation(); beginEdit(); }}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 truncate text-left text-sm select-text rounded px-1 -mx-1 hover:bg-bg/40 text-text/90"
              title="Double-click to edit task"
            >
              {todo.text || <span className="text-muted italic">—</span>}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); beginEdit(); }}
              className="shrink-0 text-muted hover:text-accent p-1 rounded hover:bg-bg/40 opacity-60 group-hover:opacity-100"
              title="Edit task"
              aria-label="Edit task"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.207 2.5l2.293 2.293-8.5 8.5-2.293-.707-.707-2.293 8.5-8.5zm.707-.707l1-1a1 1 0 011.414 0l1.293 1.293a1 1 0 010 1.414l-1 1L11.914 1.793zM2 14h12v1H2v-1z"/></svg>
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={(e) => { e.stopPropagation(); onToggleDone(); }}
          className="text-xs text-muted hover:text-ok hover:bg-ok/10 px-2 py-1 rounded border border-transparent hover:border-ok/40 flex items-center gap-1 opacity-70 group-hover:opacity-100"
          title="Mark done (moves to history, can be restored)"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 11.207L3.146 7.854l.708-.708L6.5 9.793l5.646-5.647.708.708L6.5 11.207z"/></svg>
          Done
        </button>
      </div>
    </div>
  );
}
