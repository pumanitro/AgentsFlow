import { useEffect, useRef, useState } from 'react';
import { PinnedDivider } from '../../shared/types';

interface Props {
  divider: PinnedDivider;
  focused: boolean;
  suppressHover: boolean;
  startInRename: boolean;
  onFocus: () => void;
  onSaveTitle: (title: string) => void;
  onRemove: () => void;
  onRenameHandled: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

export default function DividerRow({
  divider,
  focused,
  suppressHover,
  startInRename,
  onFocus,
  onSaveTitle,
  onRemove,
  onRenameHandled,
  draggable,
  onDragStart,
  onDragEnd,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(divider.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(divider.title);
  }, [divider.title, editing]);

  useEffect(() => {
    if (startInRename) {
      setEditing(true);
      onRenameHandled();
    }
  }, [startInRename, onRenameHandled]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v !== divider.title) onSaveTitle(v);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(divider.title);
  };

  return (
    <div
      data-focused={focused}
      data-testid={`divider-row-${divider.id}`}
      draggable={draggable && !editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onFocus}
      className={`group flex items-center gap-3 px-4 py-1.5 border-l-2 ${focused ? 'border-l-accent bg-panel2' : `border-l-transparent bg-bg/50 ${suppressHover ? '' : 'hover:bg-panel2/60'}`} border-b border-b-border ${editing ? 'cursor-default' : 'cursor-grab active:cursor-grabbing select-none'}`}
      title={editing ? undefined : 'Drag to reorder · Shift+↑/↓'}
    >
      <span className="text-muted/70 shrink-0" aria-hidden>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="4" cy="4" r="1.4"/><circle cx="4" cy="8" r="1.4"/><circle cx="4" cy="12" r="1.4"/><circle cx="9" cy="4" r="1.4"/><circle cx="9" cy="8" r="1.4"/><circle cx="9" cy="12" r="1.4"/></svg>
      </span>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        <div className="h-px flex-1 bg-border" />
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
            placeholder="Separator label"
            className="bg-panel border border-border rounded px-2 py-0.5 text-xs uppercase tracking-wider text-text outline-none focus:border-accent"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 text-[11px] uppercase tracking-wider font-semibold text-text/90 px-2.5 py-0.5 rounded-full border border-border bg-panel hover:border-accent/60 select-text"
            title="Double-click to rename"
          >
            {divider.title || <span className="text-muted italic normal-case font-normal">separator</span>}
          </button>
        )}
        <div className="h-px flex-1 bg-border" />
      </div>

      <div className="flex items-center gap-1 shrink-0 opacity-60 group-hover:opacity-100">
        <button
          onClick={(e) => { e.stopPropagation(); setEditing(true); }}
          className="text-muted hover:text-accent p-1 rounded hover:bg-bg/40"
          title="Rename separator"
          aria-label="Rename separator"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.207 2.5l2.293 2.293-8.5 8.5-2.293-.707-.707-2.293 8.5-8.5zm.707-.707l1-1a1 1 0 011.414 0l1.293 1.293a1 1 0 010 1.414l-1 1L11.914 1.793zM2 14h12v1H2v-1z"/></svg>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="text-muted hover:text-err hover:bg-err/10 p-1 rounded border border-transparent hover:border-err/40"
          title="Remove separator"
          aria-label="Remove separator"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.293 4.293a1 1 0 011.414 0L8 6.586l2.293-2.293a1 1 0 111.414 1.414L9.414 8l2.293 2.293a1 1 0 01-1.414 1.414L8 9.414l-2.293 2.293a1 1 0 01-1.414-1.414L6.586 8 4.293 5.707a1 1 0 010-1.414z"/></svg>
        </button>
      </div>
    </div>
  );
}
