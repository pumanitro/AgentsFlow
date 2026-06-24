import { useEffect, useRef, useState } from 'react';
import { TrackedDirectory } from '../../shared/types';

interface Props {
  dir: TrackedDirectory;
  selected: boolean;
  historyCount: number;
  onSelect: () => void;
  onViewHistory: () => void;
  onPreview: () => void;
  onRemove: () => void;
}

export default function DirectoryCard({ dir, selected, historyCount, onSelect, onViewHistory, onPreview, onRemove }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <div
      onClick={onSelect}
      className={`group relative text-left rounded-lg border px-4 py-3 transition-colors cursor-pointer ${
        selected
          ? 'border-accent bg-panel2 ring-1 ring-accent/40'
          : 'border-border bg-panel hover:bg-panel2 hover:border-border'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-text truncate">{dir.displayName}</div>
          <div className="text-xs text-muted truncate font-mono mt-0.5">{dir.path}</div>
        </div>
        <div className="shrink-0 flex flex-col items-center gap-1">
          <div className="relative" ref={menuRef}>
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
              className="text-muted hover:text-text px-1.5 py-0.5 rounded hover:bg-bg/60"
              title="Options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >⋯</button>
            {menuOpen && (
              <div
                role="menu"
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 top-full mt-1 w-56 rounded-md border border-border bg-panel2 shadow-lg z-20 py-1"
              >
                <button
                  role="menuitem"
                  className="w-full text-left px-3 py-1.5 text-sm text-text hover:bg-panel"
                  onClick={() => { setMenuOpen(false); onViewHistory(); }}
                >
                  View history{historyCount > 0 ? ` (${historyCount})` : ''}
                </button>
                <button
                  role="menuitem"
                  className="w-full text-left px-3 py-1.5 text-sm text-err hover:bg-panel"
                  onClick={() => { setMenuOpen(false); onRemove(); }}
                >
                  Remove directory
                </button>
              </div>
            )}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onPreview(); }}
            className="text-muted hover:text-accent hover:bg-accent/10 p-1 rounded border border-transparent hover:border-accent/40 transition-colors"
            title="Open files preview"
            aria-label="Open files preview"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
