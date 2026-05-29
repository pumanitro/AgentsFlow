import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import { Conversation } from '../../shared/types';
import { statusDotClass } from '../lib/status';
import { saveUIState, useDirectoryNumber, useUIState } from '../lib/ui-state';

import ShellArea, { appendShell, ShellNode } from '../components/ShellArea';

const Terminal = dynamic(() => import('../components/Terminal'), { ssr: false });
const FileTreeSidebar = dynamic(() => import('../components/FileTreeSidebar'), { ssr: false });
const FileEditor = dynamic(() => import('../components/FileEditor'), { ssr: false });

const MIN_SHELL_HEIGHT = 120;
const MAX_SHELL_HEIGHT_RATIO = 0.8;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH_RATIO = 0.6;

export default function SessionPage() {
  const router = useRouter();
  const idParam = router.query.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  const [conv, setConv] = useState<Conversation | null>(null);
  const [rightPane, setRightPane] = useUIState('rightPane');
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [shellHeight, setShellHeight] = useDirectoryNumber(conv?.directoryId, 'shellHeight', 260);
  const [sidebarWidth, setSidebarWidth] = useDirectoryNumber(conv?.directoryId, 'sidebarWidth', 288);
  const [shellRoot, setShellRoot] = useState<ShellNode | null>(null);
  const [shellsHydrated, setShellsHydrated] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const horizontalSplitRef = useRef<HTMLDivElement | null>(null);

  const addShell = useCallback(() => {
    const cwd = conv?.directoryPath;
    if (!cwd) return;
    setShellRoot((prev) => appendShell(prev, cwd, 'row'));
  }, [conv?.directoryPath]);

  // Shell layout is shared across all conversations rooted in the same directory,
  // so persistence is keyed on conv.directoryId.
  const directoryKey = conv?.directoryId;
  useEffect(() => {
    if (!directoryKey) return;
    setShellsHydrated(false);
    try {
      const raw = localStorage.getItem(`agentsflow:shells:${directoryKey}`);
      setShellRoot(raw ? (JSON.parse(raw) as ShellNode) : null);
    } catch {
      setShellRoot(null);
    }
    setShellsHydrated(true);
  }, [directoryKey]);

  useEffect(() => {
    if (!directoryKey || !shellsHydrated) return;
    try {
      const key = `agentsflow:shells:${directoryKey}`;
      if (shellRoot === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(shellRoot));
    } catch {
      // best-effort
    }
  }, [directoryKey, shellsHydrated, shellRoot]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const nextHeight = rect.bottom - ev.clientY;
      const maxH = Math.max(MIN_SHELL_HEIGHT, rect.height * MAX_SHELL_HEIGHT_RATIO);
      setShellHeight(Math.round(Math.max(MIN_SHELL_HEIGHT, Math.min(maxH, nextHeight))));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [setShellHeight]);

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

  // FILE pane is meaningless without an open file. If the persisted state lands
  // us there with nothing loaded (re-entering the session after navigating away,
  // or after the previously-open file was renamed/deleted), fall back to CHAT.
  useEffect(() => {
    if (rightPane === 'file' && !openFile) setRightPane('chat');
  }, [rightPane, openFile, setRightPane]);

  useEffect(() => {
    if (!id) return;
    api().listConversations().then((cs) => {
      setConv(cs.find((c) => c.id === id) ?? null);
    });
    const off = api().onConversationsUpdated((cs) => {
      setConv(cs.find((c) => c.id === id) ?? null);
    });
    return off;
  }, [id]);

  const goBack = useCallback(() => {
    if (conv?.directoryId) saveUIState({ selectedDirId: conv.directoryId });
    router.push({ pathname: '/', query: id ? { focus: String(id) } : undefined });
  }, [router, id, conv]);

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

  if (!id) return null;

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
        <div className="min-w-0 flex items-center gap-2 flex-1">
          {conv && (
            <span
              className={`shrink-0 inline-block w-2 h-2 rounded-full ${statusDotClass(conv)}`}
              title={conv.state || conv.status || 'idle'}
            />
          )}
          <span className="text-sm font-medium text-text shrink-0">{conv?.displayName ?? '…'}</span>
          {(conv?.title || conv?.description) && (
            <>
              <span className="text-muted text-xs">·</span>
              <span className="text-sm text-text/85 truncate min-w-0">{conv?.title || conv?.description}</span>
            </>
          )}
        </div>
        <div
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="shrink-0 flex rounded-md border border-border bg-panel overflow-hidden"
        >
          <button
            onClick={() => setRightPane('chat')}
            className={`px-3 py-1 text-[11px] uppercase tracking-wider ${rightPane === 'chat' ? 'bg-accent text-bg font-semibold' : 'text-muted hover:text-text hover:bg-panel2'}`}
            title="Show conversation terminal"
          >Chat</button>
          <button
            onClick={() => setRightPane('file')}
            disabled={!openFile}
            className={`px-3 py-1 text-[11px] uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed ${rightPane === 'file' ? 'bg-accent text-bg font-semibold' : 'text-muted hover:text-text hover:bg-panel2'}`}
            title={openFile ? 'Show file editor' : 'Click a file in the sidebar to open it'}
          >File</button>
        </div>
        <button
          onClick={addShell}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="shrink-0 px-3 py-1 text-[11px] uppercase tracking-wider rounded-md border bg-panel text-muted border-border hover:text-text hover:bg-panel2 flex items-center gap-1"
          title={`Add shell in ${conv?.directoryPath ?? 'project directory'}`}
        >+ Shell</button>
      </header>

      <div ref={splitContainerRef} className="flex-1 flex flex-col min-h-0">
        <div ref={horizontalSplitRef} className="flex-1 flex min-h-0">
        {conv?.directoryPath && (
          <>
            <aside
              className="shrink-0 border-r border-border min-h-0 overflow-hidden"
              style={{ width: sidebarWidth }}
            >
              <FileTreeSidebar
                dirPath={conv.directoryPath}
                conversationId={conv.id}
                openedFilePath={openFile}
                onFileOpen={(abs) => { setOpenFile(abs); setRightPane('file'); }}
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
          {/* Both panes stay mounted; toggling uses visibility so xterm size doesn't reset */}
          <div className={`absolute inset-0 ${rightPane === 'chat' ? 'visible' : 'invisible'}`}>
            {conv?.sessionId ? (
              <Terminal conversationId={String(id)} onExit={goBack} autoFocus={rightPane === 'chat'} />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">
                {conv ? 'Session not ready yet…' : 'Loading…'}
              </div>
            )}
          </div>

          <div className={`absolute inset-0 ${rightPane === 'file' ? 'visible' : 'invisible'}`}>
            {openFile ? (
              <FileEditor filePath={openFile} baseDir={conv?.directoryPath} autoFocus={rightPane === 'file'} />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">
                Click a file in the sidebar to open it
              </div>
            )}
          </div>
        </div>
        </div>

        {shellRoot && (
          <>
            <div
              onMouseDown={startResize}
              className="shrink-0 h-1 bg-subtle/70 hover:bg-accent cursor-row-resize"
              title="Drag to resize shell area"
            />
            <div
              className="shrink-0 relative bg-bg border-t border-border"
              style={{ height: shellHeight }}
            >
              {conv?.directoryPath ? (
                <ShellArea defaultCwd={conv.directoryPath} root={shellRoot} setRoot={setShellRoot} />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">
                  Loading…
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
