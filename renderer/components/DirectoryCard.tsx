import { useEffect, useRef, useState } from 'react';
import { RemoteHostStatus, TrackedDirectory } from '../../shared/types';
import { collapseHome, shortHost } from '../lib/remote';

interface Props {
  dir: TrackedDirectory;
  selected: boolean;
  historyCount: number;
  onSelect: () => void;
  onAddTask: () => void;
  onViewHistory: () => void;
  onPreview: () => void;
  onRemove: () => void;
  /** Remote peers only: the host's live status (undefined = not reported yet). */
  remoteStatus?: RemoteHostStatus;
  /** Remote peers only: ask main to reconnect this peer's host. */
  onReconnect?: () => void;
}

export default function DirectoryCard({ dir, selected, historyCount, onSelect, onAddTask, onViewHistory, onPreview, onRemove, remoteStatus, onReconnect }: Props) {
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

  // The full path is redundant noise in a narrow sidebar — collapse the home
  // prefix; the tooltip keeps the exact path.
  const shortPath = dir.path.replace(/^\/Users\/[^/]+/, '~');

  // Remote peer: `⇅ user@short-host:~/path`, plus a host status dot. The home
  // used for `~` comes from the live status, else the cached peer info.
  const remote = dir.remote;
  const remoteLine = remote
    ? `⇅ ${remote.user}@${shortHost(remote.host)}:${collapseHome(dir.path, remoteStatus?.home ?? dir.remoteCache?.home)}`
    : null;
  const remoteDotClass = !remoteStatus
    ? 'bg-muted'
    : remoteStatus.state === 'ready'
      ? 'bg-ok'
      : remoteStatus.state === 'connecting'
        ? 'bg-warn animate-pulse'
        : 'bg-err';
  const remoteDotTitle = !remoteStatus
    ? 'unknown — no status yet (click to reconnect)'
    : remoteStatus.state === 'ready'
      ? `ready${remoteStatus.claudeVersion ? ` · claude ${remoteStatus.claudeVersion}` : ''}`
      : `${remoteStatus.state}${remoteStatus.error ? ` · ${remoteStatus.error}` : ''} (click to reconnect)`;

  return (
    <div
      onClick={onSelect}
      className={`group relative text-left rounded-md border px-2.5 py-1.5 transition-colors cursor-pointer ${
        selected
          ? 'border-accent bg-panel2 ring-1 ring-accent/40'
          : 'border-border bg-panel hover:bg-panel2 hover:border-border'
      }`}
    >
      <div className="flex items-center justify-between gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text truncate">{dir.displayName}</div>
          {remoteLine ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (remoteStatus?.state !== 'ready') onReconnect?.();
                }}
                className={`shrink-0 inline-block w-2 h-2 rounded-full ${remoteDotClass} ${remoteStatus?.state === 'ready' ? 'cursor-default' : 'cursor-pointer'}`}
                title={remoteDotTitle}
                aria-label={`Remote host status: ${remoteDotTitle}`}
              />
              <div className="text-[11px] text-muted truncate font-mono" title={`${remote!.user}@${remote!.host}:${dir.path}`}>{remoteLine}</div>
            </div>
          ) : (
            <div className="text-[11px] text-muted truncate font-mono" title={dir.path}>{shortPath}</div>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
          <button
            onClick={(e) => { e.stopPropagation(); onAddTask(); }}
            className="text-muted hover:text-accent hover:bg-accent/10 p-1 rounded border border-transparent hover:border-accent/40 transition-colors"
            title={`Add a task for ${dir.displayName}`}
            aria-label={`Add a task for ${dir.displayName}`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
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
                {remote && onReconnect && (
                  <button
                    role="menuitem"
                    className="w-full text-left px-3 py-1.5 text-sm text-text hover:bg-panel"
                    onClick={() => { setMenuOpen(false); onReconnect(); }}
                  >
                    Reconnect host
                  </button>
                )}
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
