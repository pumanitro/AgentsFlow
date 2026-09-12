import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import { Conversation } from '../../shared/types';
import { statusDotClass } from '../lib/status';
import { saveUIState, useDirectoryNumber, useUIState } from '../lib/ui-state';
import { useBackNavKeys, BackNavHint } from '../lib/back-nav';

import ShellArea, { appendShell, ShellNode } from '../components/ShellArea';
import PaneErrorBoundary from '../components/PaneErrorBoundary';
import paneLoading from '../components/PaneLoading';

const CodexChat = dynamic(() => import('../components/CodexChat'), { ssr: false, loading: paneLoading('Codex') });
const Terminal = dynamic(() => import('../components/Terminal'), { ssr: false, loading: paneLoading('terminal') });
const FileTreeSidebar = dynamic(() => import('../components/FileTreeSidebar'), { ssr: false, loading: paneLoading('files') });
const FileEditor = dynamic(() => import('../components/FileEditor'), { ssr: false, loading: paneLoading('editor') });

const MIN_SHELL_HEIGHT = 120;
const MAX_SHELL_HEIGHT_RATIO = 0.8;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH_RATIO = 0.6;

export default function SessionPage() {
  const router = useRouter();
  const idParam = router.query.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  // An explicit file to open in the file pane, e.g. from the `open_file` MCP tool.
  const fileParam = router.query.file;
  const explicitFile = Array.isArray(fileParam) ? fileParam[0] : fileParam;
  const lineParam = router.query.line;
  const explicitLine = Array.isArray(lineParam) ? lineParam[0] : lineParam;
  // Per-request token: re-opening the same file bumps this so the effect re-fires
  // and reveals the file pane again (even if the user had switched back to Chat).
  const tokenParam = router.query.t;
  const explicitToken = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
  const [conv, setConv] = useState<Conversation | null>(null);
  // Peers this conversation has delegated to — drives the live "a peer is
  // working" banner so you can watch them without leaving the root session.
  const [children, setChildren] = useState<Conversation[]>([]);
  const [rightPane, setRightPane] = useUIState('rightPane');
  const [openFile, setOpenFile] = useState<string | null>(null);
  // The chat terminal exited. This fires both for a real session end AND for a
  // fast-fail attach — e.g. `claude attach` to a finished/lingering daemon that
  // just replays and exits, a spawn the capacity guard refused, or a daemon the
  // reaper stopped mid-attach. We used to call goBack() here, which teleported
  // the user to the home list the instant they opened a peer ("opens the chat,
  // then a moment later bounces to home"). Stay on the page instead and let them
  // Reopen (re-attach / resume) or go Back deliberately — matching the app's
  // explicit ⌘←/Back navigation model.
  const [chatExited, setChatExited] = useState(false);
  // Bumped by Reopen to force a fresh Terminal mount (and a new attach).
  const [chatGen, setChatGen] = useState(0);
  // Which pane a Codex row shows. The terminal is the default — it is the Codex
  // CLI's own TUI attached to the live thread, so it is the same thing the user
  // would see in a shell, approvals included. `CodexChat` stays one click away
  // because its rendering of approval cards and the handover context line is
  // easier to read than the TUI's, and because it is the only surface that can
  // start a thread that does not exist yet.
  const [codexView, setCodexView] = useState<'terminal' | 'native'>('terminal');
  // 1-based line to jump to when a file is opened from search. The nonce makes
  // re-opening the *same* file at the same line still trigger the jump.
  const [gotoLine, setGotoLine] = useState<{ line: number; nonce: number } | null>(null);
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

  // Remember the last file opened in this peer (keyed on its directory, like the
  // shell/sidebar sizes) so the FILE switch reopens it on return instead of
  // stranding us on an empty pane.
  const lastFileKey = conv?.directoryId;
  const lastFileHydratedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!lastFileKey || typeof localStorage === 'undefined') return;
    if (lastFileHydratedFor.current === lastFileKey) return;
    lastFileHydratedFor.current = lastFileKey;
    // An explicit ?file= (e.g. from open_file) wins over the remembered file —
    // the effect below opens it. Mark this directory hydrated (so the persist
    // effect runs) but don't restore or flip the pane out from under it.
    if (explicitFile) return;
    let stored: string | null = null;
    try { stored = localStorage.getItem(`agentsflow:dir:${lastFileKey}:lastFile`); } catch { /* ignore */ }
    setOpenFile(stored || null);
    // Nothing remembered → a persisted FILE pane has nothing to show, so fall
    // back to CHAT. (A remembered file that was since deleted surfaces as an
    // error inside the editor, which is friendlier than silently hiding it.)
    if (!stored && rightPane === 'file') setRightPane('chat');
  }, [lastFileKey, rightPane, setRightPane, explicitFile]);

  // Open the file named in the URL and reveal the file pane. Routed here by the
  // `open_file` MCP tool when the file lives in this conversation's directory, so
  // the user can read it and toggle straight back to the chat.
  //
  // This runs once per open REQUEST (keyed on the per-request token), not on
  // every render — otherwise it would keep forcing `rightPane` back to 'file' and
  // clicking Chat could never stick. The deps are all stable URL strings (and
  // `setRightPane` is memoized by useUIState), so it only re-fires when a new
  // request actually arrives — including re-opening the same file.
  useEffect(() => {
    if (!explicitFile) return;
    setOpenFile(explicitFile);
    const ln = Number(explicitLine);
    setGotoLine(Number.isFinite(ln) && ln > 0 ? { line: ln, nonce: Date.now() } : null);
    setRightPane('file');
  }, [explicitFile, explicitLine, explicitToken, setRightPane]);

  // Persist the last-opened file per peer. Skip until the restore above has run
  // for this directory so the initial null never clobbers the stored path.
  useEffect(() => {
    if (!lastFileKey || typeof localStorage === 'undefined') return;
    if (lastFileHydratedFor.current !== lastFileKey) return;
    try {
      const key = `agentsflow:dir:${lastFileKey}:lastFile`;
      if (openFile) localStorage.setItem(key, openFile);
      else localStorage.removeItem(key);
    } catch { /* ignore */ }
  }, [lastFileKey, openFile]);

  useEffect(() => {
    if (!id) return;
    // New conversation in view → clear any prior "chat ended" notice so the
    // fresh terminal mounts instead of showing the stale Reopen panel.
    setChatExited(false);
    const a = api();
    const apply = (cs: Conversation[]) => {
      setConv(cs.find((c) => c.id === id) ?? null);
      setChildren(cs.filter((c) => c.delegatedByConversationId === id));
    };
    a.listConversations().then(apply);
    const off = a.onConversationsUpdated(apply);
    // Patches carry only the changed rows; this view cares about exactly two
    // things — this conversation and its delegated children — so it can pick
    // them straight out of the patch instead of re-scanning all of history.
    const offPatch = a.onConversationsPatched?.((changed) => {
      for (const c of changed) {
        if (c.id === id) setConv(c);
        if (c.delegatedByConversationId === id) {
          setChildren((prev) => {
            const idx = prev.findIndex((x) => x.id === c.id);
            if (idx === -1) return [...prev, c];
            const next = prev.slice();
            next[idx] = c;
            return next;
          });
        }
      }
    }) ?? (() => undefined);
    return () => { off(); offPatch(); };
  }, [id]);

  // A conversation that moved provider gets a fresh terminal, so a "chat ended"
  // notice from the side it left would otherwise sit on top of the side it
  // arrived at.
  useEffect(() => { setChatExited(false); }, [conv?.provider]);

  // Terminal-vs-native is remembered per conversation: one Codex chat being
  // read through the native view is not a reason for the next one to open that
  // way. Hydrated on mount so SSR renders the default.
  useEffect(() => {
    if (!id || typeof localStorage === 'undefined') return;
    let stored: string | null = null;
    try { stored = localStorage.getItem(`agentsflow:conv:${id}:codexView`); } catch { /* ignore */ }
    setCodexView(stored === 'native' ? 'native' : 'terminal');
  }, [id]);

  const chooseCodexView = useCallback((next: 'terminal' | 'native') => {
    setCodexView(next);
    // Switching back to the terminal re-attaches: the thread is still alive in
    // the app-server, so a previous exit notice is stale the moment we return.
    setChatExited(false);
    if (!id || typeof localStorage === 'undefined') return;
    try { localStorage.setItem(`agentsflow:conv:${id}:codexView`, next); } catch { /* ignore */ }
  }, [id]);

  // Start the Codex thread for a row handed over from Claude. `continue` is the
  // ordinary first turn — the main process seeds it with the handover context
  // built from the Claude transcript — and the conversations broadcast then
  // fills in the sessionId (the thread id) the terminal attaches to.
  const [startingCodex, setStartingCodex] = useState(false);
  const [startCodexError, setStartCodexError] = useState<string | null>(null);
  const startOnCodex = useCallback(async () => {
    if (!id || startingCodex) return;
    setStartingCodex(true);
    setStartCodexError(null);
    try {
      await api().codexSend(String(id), 'continue');
    } catch (err) {
      setStartCodexError((err as Error)?.message ?? 'Could not start this conversation on Codex.');
    } finally {
      setStartingCodex(false);
    }
  }, [id, startingCodex]);

  // Continue a conversation that was handed over to Claude: the main process
  // starts a fresh session seeded with the other agent's transcript, and the
  // conversations broadcast then fills in the sessionId the Terminal needs.
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const resumeHandover = useCallback(async () => {
    if (!id || resuming) return;
    setResuming(true);
    setResumeError(null);
    try {
      const r = await api().resumeHandover(String(id));
      if (!r.ok) setResumeError(r.error || 'Could not continue this conversation.');
    } catch (err) {
      setResumeError((err as Error)?.message ?? 'Could not continue this conversation.');
    } finally {
      setResuming(false);
    }
  }, [id, resuming]);

  const goBack = useCallback(() => {
    if (conv?.directoryId) saveUIState({ selectedDirId: conv.directoryId });
    router.push({ pathname: '/', query: id ? { focus: String(id) } : undefined });
  }, [router, id, conv]);

  // Branch an independent copy of this chat (full history, new session) and
  // open it. The escape hatch when the original session can't be reopened —
  // e.g. it's held by a stuck background daemon that refuses attach/resume.
  const [forking, setForking] = useState(false);
  const forkChat = useCallback(async () => {
    if (!conv?.sessionId || forking) return;
    setForking(true);
    try {
      const { conversationId } = await api().forkConversation(conv.id);
      router.push({ pathname: '/session', query: { id: conversationId } });
    } catch (err) {
      console.error('[agentsflow] fork failed', err);
    } finally {
      setForking(false);
    }
  }, [conv, forking, router]);

  const backHint = useBackNavKeys(goBack);

  // Claude rows are always the terminal; Codex rows are the terminal unless the
  // reader asked for the native view. Drives which pane mounts AND whether a
  // stale "terminal closed" notice is allowed to cover it.
  const showingTerminal = conv?.provider !== 'codex' || codexView === 'terminal';

  if (!id) return null;

  return (
    <div className="h-screen flex flex-col">
      <BackNavHint hint={backHint} />
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
        {conv?.provider === 'codex' && (
          <button
            onClick={() => chooseCodexView(codexView === 'native' ? 'terminal' : 'native')}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className={`shrink-0 px-3 py-1 text-[11px] uppercase tracking-wider rounded-md border ${codexView === 'native' ? 'bg-accent text-bg font-semibold border-accent' : 'bg-panel text-muted border-border hover:text-text hover:bg-panel2'}`}
            title={codexView === 'native'
              ? 'Back to the Codex terminal (the CLI’s own TUI, attached to the live thread)'
              : 'Show the built-in Codex view instead — approval cards and the handover note, rendered by Peers Flow'}
          >Native view</button>
        )}
        <button
          onClick={forkChat}
          disabled={!conv?.sessionId || forking}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="shrink-0 px-3 py-1 text-[11px] uppercase tracking-wider rounded-md border bg-panel text-muted border-border hover:text-text hover:bg-panel2 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Branch an independent copy of this chat (full history, new session) — use it when the original is stuck"
        >{forking ? 'Forking…' : '⑂ Fork'}</button>
        <button
          onClick={addShell}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="shrink-0 px-3 py-1 text-[11px] uppercase tracking-wider rounded-md border bg-panel text-muted border-border hover:text-text hover:bg-panel2 flex items-center gap-1"
          title={`Add shell in ${conv?.directoryPath ?? 'project directory'}`}
        >+ Shell</button>
      </header>

      {children.length > 0 && (
        <div className="shrink-0 border-b border-border bg-panel/60 px-4 py-1.5 flex flex-col gap-1">
          {children.map((child) => {
            const state = (child.state || '').toLowerCase();
            const running = !['done', 'completed', 'failed', 'error'].includes(state);
            const failed = state === 'failed' || state === 'error';
            return (
              <div key={child.id} className="flex items-center gap-2 text-[12.5px] min-w-0">
                <span className="text-muted/70 shrink-0" aria-hidden>⤷</span>
                <span
                  className={`inline-block w-2 h-2 rounded-full shrink-0 ${statusDotClass(child, true)}`}
                />
                <span className="shrink-0 font-medium text-text/90">{child.displayName}</span>
                <span className="text-muted shrink-0">
                  {running ? 'is working' : failed ? 'failed' : 'finished'}
                </span>
                <span className="text-muted/60 shrink-0">—</span>
                <span className="truncate text-text/70 min-w-0 flex-1" title={child.title || child.description}>
                  {child.title || 'delegated task'}
                </span>
                <button
                  onClick={() => { if (child.sessionId) router.push({ pathname: '/session', query: { id: child.id } }); }}
                  disabled={!child.sessionId && child.provider !== 'codex'}
                  className="shrink-0 text-[11px] uppercase tracking-wider px-2 py-0.5 rounded border border-border text-accent hover:bg-panel2 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Open the delegated peer and watch it live"
                >
                  Open ▸
                </button>
              </div>
            );
          })}
        </div>
      )}

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
                worktreePath={conv.worktreePath}
                openedFilePath={openFile}
                onFileOpen={(abs, line) => {
                  setOpenFile(abs);
                  setGotoLine(typeof line === 'number' ? { line, nonce: Date.now() } : null);
                  setRightPane('file');
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
          {/* Both panes stay mounted; toggling uses visibility so xterm size doesn't reset */}
          <div className={`absolute inset-0 ${rightPane === 'chat' ? 'visible' : 'invisible'}`}>
            {conv?.sessionId ? (
              chatExited && showingTerminal ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                  <div className="text-sm text-text">The chat terminal closed.</div>
                  <div className="text-xs text-muted max-w-sm">
                    {conv.provider === 'codex'
                      ? 'Closing the Codex terminal only detaches the view — the thread keeps running in the background. Reopen to attach again; it comes back with its full history and any turn still in flight.'
                      : 'The session ended or couldn’t attach (a finished agent just replays and exits). Reopen to reconnect — a finished session resumes where it left off. If it keeps failing, Fork branches an independent copy with the full history.'}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setChatExited(false); setChatGen((g) => g + 1); }}
                      className="px-3 py-1 text-[11px] uppercase tracking-wider rounded-md bg-accent text-bg font-semibold hover:opacity-90"
                    >Reopen</button>
                    <button
                      onClick={forkChat}
                      disabled={forking}
                      className="px-3 py-1 text-[11px] uppercase tracking-wider rounded-md border border-border bg-panel text-accent hover:bg-panel2 disabled:opacity-40 disabled:cursor-not-allowed"
                    >{forking ? 'Forking…' : '⑂ Fork'}</button>
                    <button
                      onClick={goBack}
                      className="px-3 py-1 text-[11px] uppercase tracking-wider rounded-md border border-border bg-panel text-muted hover:text-text hover:bg-panel2"
                    >← Back</button>
                  </div>
                </div>
              ) : (
                <PaneErrorBoundary key={chatGen} label={showingTerminal ? 'Terminal' : 'Codex'}>
                  {showingTerminal
                    ? <Terminal key={chatGen} conversationId={String(id)} baseDir={conv.provider === 'codex' ? (conv.worktreePath || conv.directoryPath) : conv.directoryPath} onExit={() => setChatExited(true)} autoFocus={rightPane === 'chat'} />
                    : <CodexChat conversationId={String(id)} directoryPath={conv.directoryPath} />}
                </PaneErrorBoundary>
              )
            ) : conv && conv.provider === 'codex' ? (
              // A Codex row with no thread. Two ways to get here, and only one
              // of them is a dead end for the terminal:
              //
              //  • handed over from Claude and never continued — there is no
              //    thread to attach a TUI to until the first turn creates one,
              //    so the pane is the button that starts it. The conversations
              //    broadcast then carries the thread id back and the terminal
              //    mounts on the next render.
              //  • brand new, first turn still in flight — the native composer
              //    is the surface that starts a thread, so it stands in until
              //    the id arrives, whatever the remembered preference says.
              conv.handover && codexView !== 'native' ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                  <div className="text-sm text-text font-medium">
                    Handed over from {conv.handover.from === 'codex' ? 'Codex' : 'Claude'}
                  </div>
                  <div className="text-xs text-muted max-w-sm leading-relaxed">
                    {conv.handover.reason ? `${conv.handover.reason} ` : ''}
                    Starting opens a Codex thread seeded with what the other agent did
                    {conv.handover.at ? ` (moved ${new Date(conv.handover.at).toLocaleString()})` : ''}.
                    The terminal attaches to it as soon as it exists.
                  </div>
                  {startCodexError && <div className="text-xs text-danger max-w-sm">{startCodexError}</div>}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void startOnCodex()}
                      disabled={startingCodex}
                      className="px-3 py-1 text-[11px] uppercase tracking-wider rounded-md bg-accent text-bg font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >{startingCodex ? 'Starting…' : 'Start on Codex'}</button>
                    <button
                      onClick={goBack}
                      className="px-3 py-1 text-[11px] uppercase tracking-wider rounded-md border border-border bg-panel text-muted hover:text-text hover:bg-panel2"
                    >← Back</button>
                  </div>
                </div>
              ) : (
                <PaneErrorBoundary label="Codex">
                  <CodexChat conversationId={String(id)} directoryPath={conv.directoryPath} />
                </PaneErrorBoundary>
              )
            ) : conv?.handover ? (
              // A Claude-side conversation with no session: handed over from the
              // other agent and not yet continued here. There is nothing to
              // attach to until someone says go, so the pane is the button that
              // says go.
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="text-sm text-text font-medium">
                  Handed over from {conv.handover.from === 'codex' ? 'Codex' : 'Claude'}
                </div>
                <div className="text-xs text-muted max-w-sm leading-relaxed">
                  {conv.handover.reason ? `${conv.handover.reason} ` : ''}
                  Continuing starts a Claude session seeded with what the other agent did
                  {conv.handover.at ? ` (moved ${new Date(conv.handover.at).toLocaleString()})` : ''}.
                </div>
                {resumeError && <div className="text-xs text-danger max-w-sm">{resumeError}</div>}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void resumeHandover()}
                    disabled={resuming}
                    className="px-3 py-1 text-[11px] uppercase tracking-wider rounded-md bg-accent text-bg font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                  >{resuming ? 'Starting…' : 'Continue with Claude'}</button>
                  <button
                    onClick={goBack}
                    className="px-3 py-1 text-[11px] uppercase tracking-wider rounded-md border border-border bg-panel text-muted hover:text-text hover:bg-panel2"
                  >← Back</button>
                </div>
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">
                {conv ? 'Session not ready yet…' : 'Loading…'}
              </div>
            )}
          </div>

          <div className={`absolute inset-0 ${rightPane === 'file' ? 'visible' : 'invisible'}`}>
            {openFile ? (
              <PaneErrorBoundary key={openFile} label="Editor">
                <FileEditor filePath={openFile} baseDir={conv?.directoryPath} autoFocus={rightPane === 'file'} gotoLine={gotoLine?.line} gotoNonce={gotoLine?.nonce} />
              </PaneErrorBoundary>
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
