import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import { createPathLinkProvider } from '../lib/path-links';

interface Props {
  conversationId?: string;
  shellId?: string;
  shellCwd?: string;
  // Directory that relative paths in the terminal output are resolved against
  // when turning them into clickable "reveal in Finder" links. For a chat pane
  // this is the conversation's directory; for a shell it's the shell's cwd.
  baseDir?: string;
  onExit?: () => void;
  // Controls whether the terminal grabs focus on mount and refocuses on window
  // focus. Shells pass false so they never steal focus from the chat/file pane.
  autoFocus?: boolean;
}

interface ScrollState {
  viewportY: number;
  baseY: number;
  rows: number;
  altBuffer: boolean;
}

// Private xterm 5.3 internals, reached for at teardown — see disposeTerm below.
interface XtermViewport {
  _refreshAnimationFrame: number | null;
  _innerRefresh: () => void;
  syncScrollArea: (immediate?: boolean) => void;
}

export default function Terminal({ conversationId, shellId, shellCwd, baseDir, onExit, autoFocus = true }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Read fresh inside the link provider so a later prop change is picked up
  // without rebuilding the xterm instance.
  const baseDirRef = useRef<string | undefined>(baseDir);
  baseDirRef.current = baseDir ?? shellCwd;
  const cleanupRef = useRef<(() => void) | null>(null);
  const scrollToLineRef = useRef<((line: number) => void) | null>(null);
  const termFocusRef = useRef<() => void>(() => {});
  const [termGen, setTermGen] = useState(0);
  const onExitRef = useRef<typeof onExit>(onExit);
  onExitRef.current = onExit;

  const [scroll, setScroll] = useState<ScrollState>({ viewportY: 0, baseY: 0, rows: 0, altBuffer: false });

  useEffect(() => {
    let disposed = false;
    let channelId: string | null = null;
    let off: Array<() => void> = [];
    let detach: (() => void) | null = null;

    (async () => {
      let xtermMod, fitMod, linksMod;
      try {
        xtermMod = await import('xterm');
        fitMod = await import('xterm-addon-fit');
        linksMod = await import('xterm-addon-web-links');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[agentsflow] failed to import xterm modules', err);
        return;
      }
      if (disposed || !containerRef.current) return;

      // Open every terminal link in the system browser by handing the REAL url
      // to window.open(url, '_blank'). The main process's setWindowOpenHandler
      // forwards http(s)/mailto urls to shell.openExternal and then denies the
      // popup, so no stray BrowserWindow appears.
      //
      // We must supply this explicitly for BOTH link kinds because both of
      // xterm's built-in handlers are broken under our deny-by-default open
      // handler: they call window.open() with NO url and only afterwards set
      // newWindow.location.href = uri. Since the open is denied, window.open()
      // returns null and the url (never passed to the main process) is dropped
      // — the link silently never opens. The OSC 8 handler additionally pops a
      // "WARNING: this link could be dangerous" confirm() first; routing it
      // through our handler replaces that default entirely, so the dialog and
      // the dead no-op both go away.
      const openLink = (_event: MouseEvent, uri: string) => {
        if (!/^(https?:|mailto:)/i.test(uri)) return;
        window.open(uri, '_blank', 'noopener,noreferrer');
      };

      const term = new xtermMod.Terminal({
        // OSC 8 hyperlinks (e.g. a GitHub PR rendered as a clickable label).
        linkHandler: { activate: openLink },
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        cursorBlink: true,
        scrollback: 10000,
        scrollOnUserInput: true,
        // Treat the macOS Option key as Meta so ⌥+Backspace / ⌥+← send the
        // word-delete / word-move escape sequences (ESC-prefixed) that zsh
        // expects. Without this, xterm uses Option as a dead/compose key and
        // injects stray characters instead, leaving the line in a state where
        // normal Backspace can't cleanly remove them.
        macOptionIsMeta: true,
        theme: {
          background: '#0f1115',
          foreground: '#e6e8ee',
          cursor: '#ff7847',
          black: '#0f1115',
          brightBlack: '#3a4258',
          red: '#ef4444',
          green: '#4ade80',
          yellow: '#fbbf24',
          blue: '#60a5fa',
          magenta: '#c084fc',
          cyan: '#22d3ee',
          white: '#e6e8ee',
        },
      });

      const fit = new fitMod.FitAddon();
      term.loadAddon(fit);
      // Plain-text URLs detected in the output. Same handler so both link
      // kinds funnel through shell.openExternal instead of window.open()'s
      // urlless no-op.
      term.loadAddon(new linksMod.WebLinksAddon(openLink));

      // Filesystem paths in the output → click to reveal in Finder. Only paths
      // that actually exist on disk (resolved via the main process) light up.
      const pathLinks = term.registerLinkProvider(
        createPathLinkProvider(term, {
          getBaseDir: () => baseDirRef.current ?? null,
          probe: (dir, token) => api().probePath(dir, token),
          reveal: (absPath) => {
            api()
              .revealInFinder(absPath)
              .catch((err) => console.error('[agentsflow] revealInFinder failed', err));
          },
        }),
      );

      term.open(containerRef.current);
      fit.fit();

      // Tearing a terminal down is not just term.dispose(). xterm 5.3's Viewport
      // schedules _innerRefresh() through requestAnimationFrame (Viewport._refresh)
      // and never cancels that frame when the terminal is disposed — it is the one
      // frame scheduler in the library that doesn't (RenderDebouncer.dispose(), for
      // instance, cancels its own). The stale frame then reads
      // this._renderService.dimensions, a getter that dereferences a
      // MutableDisposable which reports `value === undefined` once disposed, and so
      // throws "Cannot read properties of undefined (reading 'dimensions')" from
      // inside a rAF callback — where no try/catch of ours can reach it, leaving it
      // an unhandled renderer error that takes the window down. Unmounting while
      // output is streaming leaves exactly such a frame pending (each write syncs the
      // scroll area, which calls _refresh), so switching away from a busy agent's
      // terminal triggers it.
      //
      // Cancel the frame xterm forgot, and no-op the two methods that read
      // .dimensions: the Viewport also schedules callbacks we hold no handle for (a
      // setTimeout(syncScrollArea) in its constructor, an rAF in reset()), and a
      // terminal being destroyed loses nothing by skipping a refresh.
      const disposeTerm = () => {
        const viewport = (term as unknown as { _core?: { viewport?: XtermViewport } })._core?.viewport;
        if (viewport) {
          if (typeof viewport._refreshAnimationFrame === 'number') {
            window.cancelAnimationFrame(viewport._refreshAnimationFrame);
            viewport._refreshAnimationFrame = null;
          }
          viewport._innerRefresh = () => {};
          viewport.syncScrollArea = () => {};
        } else {
          // eslint-disable-next-line no-console
          console.warn('[agentsflow] xterm viewport internals missing — dispose-race guard inactive');
        }
        term.dispose();
      };
      // Claim the teardown now rather than after the async attach below: an unmount
      // landing while attachTerminal is still in flight would otherwise find detach
      // still null and leak this terminal, its DOM and its renderer for the life of
      // the window.
      detach = disposeTerm;

      // The first fit() can run before the monospace web font has finished
      // loading. xterm then measures the character cell with a fallback font and
      // locks in the wrong cols/rows; once the real font loads, glyphs render
      // against a mismatched grid (text looks clipped/"missing") and mouse
      // selection maps to the wrong cells. Refit after the layout settles and
      // again once fonts are ready so the grid matches the rendered glyphs.
      // This is what a manual window resize / reattach was implicitly fixing.
      const refit = () => {
        if (disposed) return;
        try {
          fit.fit();
          if (channelId) api().resizeTerminal(channelId, term.cols, term.rows);
          sync();
        } catch {}
      };
      requestAnimationFrame(refit);
      const fontsApi = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
      fontsApi?.ready?.then(refit).catch(() => undefined);

      const sync = () => {
        if (disposed) return;
        setScroll({
          viewportY: term.buffer.active.viewportY,
          baseY: term.buffer.active.baseY,
          rows: term.rows,
          altBuffer: term.buffer.active.type === 'alternate',
        });
      };
      sync();
      const scrollDisp = term.onScroll(sync);
      const bufDisp = term.buffer.onBufferChange(sync);
      scrollToLineRef.current = (line: number) => term.scrollToLine(line);

      const focusTerm = () => { try { term.focus(); } catch {} };
      termFocusRef.current = focusTerm;
      setTermGen((g) => g + 1);
      const onContainerMouseDown = () => focusTerm();
      containerRef.current.addEventListener('mousedown', onContainerMouseDown);

      let cid: string;
      let replay = '';
      try {
        if (shellId && shellCwd) {
          const res = await api().attachShellTerminal(shellId, shellCwd, term.cols, term.rows);
          cid = res.channelId;
          replay = res.replay || '';
        } else {
          const res = await api().attachTerminal(conversationId!, term.cols, term.rows);
          cid = res.channelId;
          replay = res.replay || '';
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[agentsflow] attachTerminal failed', err);
        if (!disposed) term.write(`\r\n\x1b[31m[attach failed] ${(err as Error)?.message ?? err}\x1b[0m\r\n`);
        return;
      }
      channelId = cid;

      // attachTerminal above is async — by the time it resolves the component may
      // have unmounted (e.g. the user navigated away, or `open_file` switched to
      // the file view, while the attach was still in flight). The cleanup has then
      // already run (disposed=true, and it disposed the terminal through the detach
      // claimed above) and the container ref is gone, so every `containerRef.current`
      // below would be null. Bail before touching it, and release the channel we just
      // claimed so it isn't leaked.
      if (disposed || !containerRef.current) {
        api().detachTerminal(cid).catch(() => undefined);
        return;
      }
      const container = containerRef.current;

      // Push the current (possibly font-corrected) size to the freshly-attached
      // PTY. The font-ready refit above can run while channelId is still null —
      // it fixes xterm's grid but skips its resizeTerminal() call, leaving the
      // shell with a stale COLUMNS. That desync makes zsh's line redraw land in
      // the wrong cells, so backspace can't erase the leftmost characters.
      // Re-asserting the size here closes that race.
      api().resizeTerminal(cid, term.cols, term.rows);

      const offData = api().onTerminalData((id, data) => {
        if (id !== cid) return;
        term.write(data, sync);
      });
      const offExit = api().onTerminalExit((id) => {
        if (id !== cid) return;
        onExitRef.current?.();
      });
      off.push(offData, offExit);

      term.onData((data) => api().writeTerminal(cid, data));

      // ⌥+Backspace should delete the previous word; ⌘+Backspace clears the
      // whole input (cursor → start of line). We send the byte sequences zsh
      // binds explicitly so the behavior doesn't depend on macOptionIsMeta /
      // keymap quirks: ⌥ → Ctrl-W (\x17 backward-kill-word), ⌘ → Ctrl-U
      // (\x15 backward-kill-line). Returning false stops xterm's default.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const isBackspace = e.key === 'Backspace' || e.code === 'Backspace';
        if (isBackspace && e.metaKey) {
          api().writeTerminal(cid, '\x15'); // ⌘+Backspace → kill whole line
          return false;
        }
        if (isBackspace && e.altKey) {
          api().writeTerminal(cid, '\x17'); // ⌥+Backspace → kill previous word
          return false;
        }
        // xterm sends a bare \r for Shift+Enter, identical to plain Enter, so
        // Claude Code can't tell them apart and submits either way. \x1b\r
        // (ESC + CR) is the sequence Claude Code's /terminal-setup configures
        // other terminals to send, and it already reads it as "insert newline,
        // don't submit". Guard the other modifiers so ⌘/⌥/Ctrl+Enter stay free.
        //
        // preventDefault is required, not defensive: returning false makes xterm
        // bail out of _keyDown before its own cancel(), so the browser still
        // fires keypress, and xterm's _keyPress sends Enter's charCode as a bare
        // \r — Claude Code would get \x1b\r then \r, i.e. newline-then-submit.
        // Canceling the keydown suppresses keypress entirely. The Backspace
        // branches above need no such thing: they emit no printable keypress.
        if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey) {
          api().writeTerminal(cid, '\x1b\r'); // Shift+Enter → newline, no submit
          e.preventDefault();
          return false;
        }
        return true;
      });

      // Replay buffered history now that the data listener is registered. Doing
      // this earlier would race with listener wiring and the replay would be lost.
      if (replay) term.write(replay, sync);

      // In alternate-screen mode (TUI apps like Claude Code), xterm has no scrollback,
      // so wheel events have no effect. Translate them into Page Up/Down bytes the app can read.
      // Capture phase ensures we run before xterm's own .xterm-viewport wheel handler.
      //
      // Each page key forces the app to repaint its whole screen, which streams
      // back over IPC for xterm to re-render — an expensive round-trip per key.
      // Trackpads make this worse: they emit a long momentum tail of small-delta
      // wheel events after the finger lifts. If we turn every event into page keys
      // we queue a backlog the app can't repaint fast enough, so scrolling lurches
      // on to "catch up" after the gesture ended — that reads as lag.
      //
      // So we (1) accumulate deltaY and only page once a pixel threshold is crossed
      // (de-sensitises the burst), (2) throttle to a fixed max rate, and (3) DROP
      // surplus accumulation on each emit rather than banking it — momentum can't
      // build a backlog, so scrolling stops when your finger stops.
      const WHEEL_PX_PER_PAGE = 120;   // accumulated pixels per page key
      const WHEEL_MIN_INTERVAL = 90;   // ms between page keys — caps speed, kills backlog
      let wheelAccum = 0;
      let lastWheelTs = 0;
      const onWheel = (e: WheelEvent) => {
        if (term.buffer.active.type !== 'alternate') return;
        e.preventDefault();
        e.stopPropagation();
        // Reset on direction change so a reversal responds immediately instead of
        // first having to burn off leftover accumulation in the old direction.
        if (wheelAccum !== 0 && Math.sign(e.deltaY) !== Math.sign(wheelAccum)) wheelAccum = 0;
        wheelAccum += e.deltaY;
        if (Math.abs(wheelAccum) < WHEEL_PX_PER_PAGE) return;
        const now = performance.now();
        if (now - lastWheelTs < WHEEL_MIN_INTERVAL) return; // throttle: drop, don't queue
        lastWheelTs = now;
        const key = wheelAccum > 0 ? '\x1b[6~' : '\x1b[5~'; // Page Down / Page Up
        wheelAccum = 0; // consume everything so momentum can't bank a backlog
        api().writeTerminal(cid, key);
      };
      container.addEventListener('wheel', onWheel, { passive: false, capture: true });

      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
          api().resizeTerminal(cid, term.cols, term.rows);
          sync();
        } catch {}
      });
      ro.observe(container);

      detach = () => {
        pathLinks.dispose();
        scrollDisp.dispose();
        bufDisp.dispose();
        ro.disconnect();
        container.removeEventListener('mousedown', onContainerMouseDown);
        container.removeEventListener('wheel', onWheel, { capture: true } as any);
        if (channelId) api().detachTerminal(channelId).catch(() => undefined);
        disposeTerm();
        scrollToLineRef.current = null;
        termFocusRef.current = () => {};
      };
    })();

    cleanupRef.current = () => {
      disposed = true;
      off.forEach((fn) => fn());
      detach?.();
    };
    return () => cleanupRef.current?.();
  }, [conversationId, shellId, shellCwd]);

  // Auto-focus is gated separately so toggling the prop (e.g. switching the
  // session pane from File back to Chat) re-focuses without rebuilding the
  // xterm instance. termGen bumps each time a fresh terminal is mounted, so
  // a new terminal also gets focused if autoFocus is true.
  useEffect(() => {
    if (!autoFocus || termGen === 0) return;
    const f = () => termFocusRef.current();
    f();
    const raf = requestAnimationFrame(f);
    const to = window.setTimeout(f, 60);
    const onWinFocus = () => f();
    window.addEventListener('focus', onWinFocus);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(to);
      window.removeEventListener('focus', onWinFocus);
    };
  }, [autoFocus, termGen]);

  // Scrollbar: rely solely on xterm's own native viewport scrollbar (the "left"
  // bar sitting inside the terminal). We used to also render a custom overlay
  // track as a flex sibling to its right, but since Claude Code renders inline
  // in the normal buffer that produced two bars at once. The native scrollbar is
  // real (bound to xterm's scrollback), works by wheel + drag, and is the single
  // source of truth — so the overlay track is gone.
  return (
    <div className="absolute inset-0 bg-bg">
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
