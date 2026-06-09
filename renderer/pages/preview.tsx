import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import { TrackedDirectory } from '../../shared/types';
import { saveUIState, useDirectoryNumber } from '../lib/ui-state';
import PaneErrorBoundary from '../components/PaneErrorBoundary';

const paneLoading = (label: string) => () => (
  <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">{label}…</div>
);

const FileTreeSidebar = dynamic(() => import('../components/FileTreeSidebar'), { ssr: false, loading: paneLoading('Loading files') });
const FileEditor = dynamic(() => import('../components/FileEditor'), { ssr: false, loading: paneLoading('Loading editor') });

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH_RATIO = 0.6;

// A root-level readme to open by default, in rough order of preference.
function findDefaultFile(paths: string[]): string | null {
  const roots = paths.filter((p) => !p.includes('/'));
  const readme = roots.find((p) => /^readme(\.(md|markdown|mdx|txt))?$/i.test(p));
  return readme ?? null;
}

export default function PreviewPage() {
  const router = useRouter();
  const dirParam = router.query.dir;
  const dirId = Array.isArray(dirParam) ? dirParam[0] : dirParam;
  const [dir, setDir] = useState<TrackedDirectory | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  // 1-based line to jump to when a file is opened from search.
  const [gotoLine, setGotoLine] = useState<{ line: number; nonce: number } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useDirectoryNumber(dir?.id, 'sidebarWidth', 288);
  const horizontalSplitRef = useRef<HTMLDivElement | null>(null);
  // Only auto-open a default file once per directory load.
  const pickedDefaultRef = useRef<string | null>(null);

  useEffect(() => {
    if (!dirId) return;
    api().listDirectories().then((ds) => {
      setDir(ds.find((d) => d.id === dirId) ?? null);
    });
  }, [dirId]);

  // Open the project README by default (if there is one). Best-effort: if the
  // listing fails or there's no readme, we just leave the "select a file"
  // placeholder showing.
  useEffect(() => {
    const dirPath = dir?.path;
    if (!dirPath || pickedDefaultRef.current === dirPath) return;
    pickedDefaultRef.current = dirPath;
    const a = api();
    if (typeof a.listFiles !== 'function') return;
    let cancelled = false;
    a.listFiles(dirPath)
      .then((files) => {
        if (cancelled) return;
        const rel = findDefaultFile(files.map((f) => f.path));
        if (rel) setOpenFile(`${dirPath}/${rel}`);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [dir?.path]);

  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = horizontalSplitRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const nextWidth = ev.clientX - rect.left;
      const maxW = Math.max(MIN_SIDEBAR_WIDTH, rect.width * MAX_SIDEBAR_WIDTH_RATIO);
      setSidebarWidth(Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxW, nextWidth))));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [setSidebarWidth]);

  const goBack = useCallback(() => {
    if (dir?.id) saveUIState({ selectedDirId: dir.id });
    router.push({ pathname: '/' });
  }, [router, dir]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && (e.metaKey || e.altKey)) {
        e.preventDefault();
        goBack();
      } else if (e.key === 'Escape' && e.shiftKey) {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack]);

  if (!dirId) return null;

  return (
    <div className="h-screen flex flex-col">
      <header
        className="shrink-0 px-4 py-2.5 border-b border-border flex items-center gap-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <button
          onClick={goBack}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="ml-24 px-2 py-1 rounded hover:bg-panel2 text-sm text-muted hover:text-text flex items-center gap-1"
          title="Back to list (⌘←  or  Shift+Esc)"
        >
          ← Back
        </button>
        <div className="min-w-0 flex items-baseline gap-2 flex-1">
          <span className="text-[11px] uppercase tracking-wider text-muted shrink-0">Preview</span>
          <span className="text-sm font-medium text-text shrink-0">{dir?.displayName ?? '…'}</span>
          {dir?.path && (
            <>
              <span className="text-muted text-xs">·</span>
              <span className="text-xs text-muted font-mono truncate min-w-0">{dir.path}</span>
            </>
          )}
        </div>
      </header>

      <div ref={horizontalSplitRef} className="flex-1 flex min-h-0">
        {dir?.path && (
          <>
            <aside
              className="shrink-0 border-r border-border min-h-0 overflow-hidden"
              style={{ width: sidebarWidth }}
            >
              <FileTreeSidebar
                dirPath={dir.path}
                conversationId={`preview:${dir.id}`}
                initialMode="files"
                openedFilePath={openFile}
                onFileOpen={(abs, line) => {
                  setOpenFile(abs);
                  setGotoLine(typeof line === 'number' ? { line, nonce: Date.now() } : null);
                }}
              />
            </aside>
            <div
              onMouseDown={startSidebarResize}
              className="shrink-0 w-1 bg-subtle/70 hover:bg-accent cursor-col-resize"
              title="Drag to resize the file pane"
            />
          </>
        )}
        <div className="relative flex-1 bg-bg min-w-0">
          {openFile ? (
            <PaneErrorBoundary key={openFile} label="Editor">
              <FileEditor
                filePath={openFile}
                baseDir={dir?.path}
                autoFocus
                gotoLine={gotoLine?.line}
                gotoNonce={gotoLine?.nonce}
              />
            </PaneErrorBoundary>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">
              Select a file from the sidebar to preview it
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
