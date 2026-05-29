import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/ipc';

interface Props {
  conversationId?: string;
  shellId?: string;
  shellCwd?: string;
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

export default function Terminal({ conversationId, shellId, shellCwd, onExit, autoFocus = true }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
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

      const term = new xtermMod.Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        cursorBlink: true,
        scrollback: 10000,
        scrollOnUserInput: true,
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
      term.loadAddon(new linksMod.WebLinksAddon());

      term.open(containerRef.current);
      fit.fit();

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
        term.write(`\r\n\x1b[31m[attach failed] ${(err as Error)?.message ?? err}\x1b[0m\r\n`);
        return;
      }
      channelId = cid;

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

      // Replay buffered history now that the data listener is registered. Doing
      // this earlier would race with listener wiring and the replay would be lost.
      if (replay) term.write(replay, sync);

      // In alternate-screen mode (TUI apps like Claude Code), xterm has no scrollback,
      // so wheel events have no effect. Translate them into Page Up/Down bytes the app can read.
      // Capture phase ensures we run before xterm's own .xterm-viewport wheel handler.
      const onWheel = (e: WheelEvent) => {
        if (term.buffer.active.type !== 'alternate') return;
        e.preventDefault();
        e.stopPropagation();
        const steps = Math.max(1, Math.min(3, Math.round(Math.abs(e.deltaY) / 80)));
        const key = e.deltaY > 0 ? '\x1b[6~' : '\x1b[5~'; // Page Down / Page Up
        api().writeTerminal(cid, key.repeat(steps));
      };
      containerRef.current!.addEventListener('wheel', onWheel, { passive: false, capture: true });

      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
          api().resizeTerminal(cid, term.cols, term.rows);
          sync();
        } catch {}
      });
      ro.observe(containerRef.current);

      detach = () => {
        scrollDisp.dispose();
        bufDisp.dispose();
        ro.disconnect();
        containerRef.current?.removeEventListener('mousedown', onContainerMouseDown);
        containerRef.current?.removeEventListener('wheel', onWheel, { capture: true } as any);
        if (channelId) api().detachTerminal(channelId).catch(() => undefined);
        term.dispose();
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

  const totalScrollable = scroll.baseY;
  const visibleHasOverflow = totalScrollable > 0;
  const thumbHeightPct = visibleHasOverflow
    ? Math.max(8, (scroll.rows / (scroll.rows + scroll.baseY)) * 100)
    : 100;
  const thumbTopPct = visibleHasOverflow
    ? (scroll.viewportY / totalScrollable) * (100 - thumbHeightPct)
    : 0;

  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    if (!trackRef.current || !scrollToLineRef.current || !visibleHasOverflow) return;
    if ((e.target as HTMLElement).dataset.scrollThumb) return;
    const rect = trackRef.current.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const ratio = Math.max(0, Math.min(1, clickY / rect.height));
    scrollToLineRef.current(Math.round(ratio * totalScrollable));
  }, [visibleHasOverflow, totalScrollable]);

  const startThumbDrag = useCallback((e: React.MouseEvent) => {
    if (!trackRef.current || !scrollToLineRef.current || !visibleHasOverflow) return;
    e.preventDefault();
    e.stopPropagation();
    const track = trackRef.current;
    const rect = track.getBoundingClientRect();
    const startY = e.clientY;
    const startViewportY = scroll.viewportY;
    const thumbPx = (thumbHeightPct / 100) * rect.height;
    const trackUsable = rect.height - thumbPx;
    const onMove = (ev: MouseEvent) => {
      const deltaY = ev.clientY - startY;
      const deltaRatio = trackUsable > 0 ? deltaY / trackUsable : 0;
      const next = Math.max(0, Math.min(totalScrollable, Math.round(startViewportY + deltaRatio * totalScrollable)));
      scrollToLineRef.current?.(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [visibleHasOverflow, totalScrollable, thumbHeightPct, scroll.viewportY]);

  // In alt-buffer mode (Claude Code TUI), the host has no concept of scroll position —
  // the app owns the screen. Hide the track entirely; use the History tab to read past turns.
  const showTrack = !scroll.altBuffer && visibleHasOverflow;

  return (
    <div className="absolute inset-0 flex bg-bg">
      <div ref={containerRef} className="flex-1 min-w-0 h-full relative" />
      {showTrack && (
        <div
          ref={trackRef}
          onClick={handleTrackClick}
          className="w-3 shrink-0 h-full bg-panel relative cursor-pointer select-none border-l border-border"
          title="Click or drag to scroll"
        >
          <div
            data-scroll-thumb="1"
            onMouseDown={startThumbDrag}
            className="absolute left-[2px] right-[2px] rounded-md bg-[#6b7494] hover:bg-[#8a93b0] active:bg-[#8a93b0]"
            style={{
              top: `${thumbTopPct}%`,
              height: `${thumbHeightPct}%`,
              minHeight: '24px',
            }}
          />
        </div>
      )}
    </div>
  );
}
