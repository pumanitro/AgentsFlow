import { useEffect, useRef } from 'react';
import { api } from '../lib/ipc';

interface Props {
  conversationId: string;
  onExit?: () => void;
}

export default function Terminal({ conversationId, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const onExitRef = useRef<typeof onExit>(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    let disposed = false;
    let channelId: string | null = null;
    let off: Array<() => void> = [];
    let detach: (() => void) | null = null;

    (async () => {
      try {
        // eslint-disable-next-line no-console
        console.log('[agentsflow] Terminal mount start', { conversationId });
      } catch {}
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
      const focusTerm = () => { try { term.focus(); } catch {} };
      focusTerm();
      requestAnimationFrame(focusTerm);
      setTimeout(focusTerm, 60);
      const onWinFocus = () => focusTerm();
      window.addEventListener('focus', onWinFocus);
      const onContainerMouseDown = () => focusTerm();
      containerRef.current.addEventListener('mousedown', onContainerMouseDown);

      let cid: string;
      try {
        // eslint-disable-next-line no-console
        console.log('[agentsflow] calling attachTerminal', { conversationId, cols: term.cols, rows: term.rows });
        const res = await api().attachTerminal(conversationId, term.cols, term.rows);
        cid = res.channelId;
        // eslint-disable-next-line no-console
        console.log('[agentsflow] attachTerminal ok', { channelId: cid });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[agentsflow] attachTerminal failed', err);
        term.write(`\r\n\x1b[31m[attach failed] ${(err as Error)?.message ?? err}\x1b[0m\r\n`);
        return;
      }
      channelId = cid;

      let rxEvents = 0;
      let rxBytes = 0;
      const offData = api().onTerminalData((id, data) => {
        if (id !== cid) return;
        rxEvents++;
        rxBytes += data.length;
        if (rxEvents <= 5 || rxEvents % 50 === 0) {
          // eslint-disable-next-line no-console
          console.log('[agentsflow] terminal:data rx', { events: rxEvents, bytes: rxBytes, sample: data.slice(0, 80) });
        }
        term.write(data);
      });
      const offExit = api().onTerminalExit((id) => {
        if (id !== cid) return;
        // eslint-disable-next-line no-console
        console.log('[agentsflow] terminal:exit rx', { rxEvents, rxBytes });
        onExitRef.current?.();
      });
      off.push(offData, offExit);

      term.onData((data) => api().writeTerminal(cid, data));

      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
          api().resizeTerminal(cid, term.cols, term.rows);
        } catch {}
      });
      ro.observe(containerRef.current);

      detach = () => {
        ro.disconnect();
        window.removeEventListener('focus', onWinFocus);
        containerRef.current?.removeEventListener('mousedown', onContainerMouseDown);
        if (channelId) api().detachTerminal(channelId).catch(() => undefined);
        term.dispose();
      };
    })();

    cleanupRef.current = () => {
      disposed = true;
      off.forEach((fn) => fn());
      detach?.();
    };
    return () => cleanupRef.current?.();
  }, [conversationId]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
