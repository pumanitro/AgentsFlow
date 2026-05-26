import { BrowserWindow } from 'electron';
import * as os from 'os';
import * as path from 'path';
import type { IPty } from 'node-pty';

let ptyMod: typeof import('node-pty') | null = null;
function getPty(): typeof import('node-pty') {
  if (!ptyMod) {
    // Lazy require so the rest of the app can boot even if rebuild hasn't run.
    ptyMod = require('node-pty');
  }
  return ptyMod!;
}

interface Channel {
  id: string;
  pty: IPty;
  win: BrowserWindow;
}

const channels = new Map<string, Channel>();

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

export function attach(opts: {
  channelId: string;
  sessionId: string;
  cols: number;
  rows: number;
  win: BrowserWindow;
}): void {
  const env = {
    ...process.env,
    PATH: `${process.env.PATH}:${path.join(os.homedir(), '.local/bin')}`,
    TERM: 'xterm-256color',
  } as Record<string, string>;

  console.log('[agentsflow][pty] spawning', { bin: CLAUDE_BIN, args: ['attach', opts.sessionId], cols: opts.cols, rows: opts.rows });
  let pty: IPty;
  try {
    pty = getPty().spawn(CLAUDE_BIN, ['attach', opts.sessionId], {
      name: 'xterm-256color',
      cols: Math.max(opts.cols, 20),
      rows: Math.max(opts.rows, 5),
      cwd: os.homedir(),
      env,
    });
  } catch (err) {
    console.error('[agentsflow][pty] spawn failed', err);
    if (!opts.win.isDestroyed()) {
      opts.win.webContents.send('terminal:data', opts.channelId, `\r\n\x1b[31m[pty spawn failed] ${(err as Error)?.message ?? err}\x1b[0m\r\n`);
      opts.win.webContents.send('terminal:exit', opts.channelId);
    }
    return;
  }
  console.log('[agentsflow][pty] spawn ok', { pid: pty.pid });

  const ch: Channel = { id: opts.channelId, pty, win: opts.win };
  channels.set(opts.channelId, ch);

  let dataBytes = 0;
  let dataEvents = 0;
  pty.onData((data) => {
    dataEvents++;
    dataBytes += data.length;
    if (dataEvents <= 5 || dataEvents % 50 === 0) {
      console.log('[agentsflow][pty] onData', { channelId: opts.channelId, events: dataEvents, bytes: dataBytes, sample: data.slice(0, 80) });
    }
    if (!ch.win.isDestroyed()) {
      ch.win.webContents.send('terminal:data', opts.channelId, data);
    }
  });
  pty.onExit((e) => {
    console.log('[agentsflow][pty] onExit', { channelId: opts.channelId, exitCode: e.exitCode, signal: e.signal, totalEvents: dataEvents, totalBytes: dataBytes });
    if (!ch.win.isDestroyed()) {
      ch.win.webContents.send('terminal:exit', opts.channelId);
    }
    channels.delete(opts.channelId);
  });
}

export function write(channelId: string, data: string): void {
  channels.get(channelId)?.pty.write(data);
}

export function resize(channelId: string, cols: number, rows: number): void {
  try {
    channels.get(channelId)?.pty.resize(Math.max(cols, 20), Math.max(rows, 5));
  } catch {
    // ignore
  }
}

export function detach(channelId: string): void {
  const ch = channels.get(channelId);
  if (!ch) return;
  try {
    ch.pty.kill();
  } catch {
    // ignore
  }
  channels.delete(channelId);
}

export function detachAll(): void {
  for (const id of Array.from(channels.keys())) detach(id);
}
