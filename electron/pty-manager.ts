import { BrowserWindow } from 'electron';
import * as os from 'os';
import * as path from 'path';
import type { IPty } from 'node-pty';
import { withUtf8Locale } from './locale';

let ptyMod: typeof import('node-pty') | null = null;
function getPty(): typeof import('node-pty') {
  if (!ptyMod) {
    // Lazy require so the rest of the app can boot even if rebuild hasn't run.
    ptyMod = require('node-pty');
  }
  return ptyMod!;
}

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// ---------- Claude attaches ----------
// Two flavors, with deliberately different lifecycles:
//
//  - 'attach' mode: a viewer for a live *background daemon*. The daemon owns
//    execution and outlives this PTY, so the PTY is disposable — killed on
//    detach. Re-attaching spawns a fresh `claude attach` viewer.
//
//  - 'resume' mode: `claude --resume` runs the agent *inside this PTY* — there
//    is no separate daemon, so the PTY *is* the execution. It must survive
//    renderer detach exactly like a shell does: one persistent PTY per
//    sessionId, subscriber-tracked, with a replay buffer. Killing it on detach
//    is what was aborting in-progress turns when switching/closing the view.

const env = () => withUtf8Locale({
  ...process.env,
  PATH: `${process.env.PATH}:${path.join(os.homedir(), '.local/bin')}`,
  TERM: 'xterm-256color',
} as Record<string, string>);

interface ClaudeChannel { id: string; pty: IPty; win: BrowserWindow; }
const claudeChannels = new Map<string, ClaudeChannel>();

interface ResumeSession {
  sessionId: string;
  pty: IPty;
  buffer: string[];
  bufferBytes: number;
  subscribers: Map<string, ShellSubscriber>;
}
const resumeSessions = new Map<string, ResumeSession>();
const resumeChannelToSessionId = new Map<string, string>();

export function attach(opts: {
  channelId: string;
  sessionId: string;
  cols: number;
  rows: number;
  win: BrowserWindow;
  // 'attach' — connect to a live background daemon (default, original behavior)
  // 'resume' — load a saved transcript from disk and continue interactively
  mode?: 'attach' | 'resume';
  // Required when mode==='resume'; ignored otherwise. The directory the
  // session was originally run in, so Claude finds the right .claude project.
  cwd?: string;
}): string {
  const mode = opts.mode ?? 'attach';
  if (mode === 'resume') return attachResume(opts);

  const args = ['attach', opts.sessionId];
  const cwd = os.homedir();
  console.log('[agentsflow][pty] spawning', { bin: CLAUDE_BIN, args, cols: opts.cols, rows: opts.rows, cwd, mode });
  let pty: IPty;
  try {
    pty = getPty().spawn(CLAUDE_BIN, args, {
      name: 'xterm-256color',
      cols: Math.max(opts.cols, 20),
      rows: Math.max(opts.rows, 5),
      cwd,
      env: env(),
    });
  } catch (err) {
    console.error('[agentsflow][pty] spawn failed', err);
    if (!opts.win.isDestroyed()) {
      opts.win.webContents.send('terminal:data', opts.channelId, `\r\n\x1b[31m[pty spawn failed] ${(err as Error)?.message ?? err}\x1b[0m\r\n`);
      opts.win.webContents.send('terminal:exit', opts.channelId);
    }
    return '';
  }
  console.log('[agentsflow][pty] spawn ok', { pid: pty.pid });

  const ch: ClaudeChannel = { id: opts.channelId, pty, win: opts.win };
  claudeChannels.set(opts.channelId, ch);

  pty.onData((data) => {
    if (!ch.win.isDestroyed()) ch.win.webContents.send('terminal:data', opts.channelId, data);
  });
  pty.onExit(() => {
    if (!ch.win.isDestroyed()) ch.win.webContents.send('terminal:exit', opts.channelId);
    claudeChannels.delete(opts.channelId);
  });
  return '';
}

// Persistent, subscriber-based attach for `claude --resume`. Mirrors attachShell:
// spawn once per sessionId, reuse on re-attach, and return a replay buffer so a
// re-mounted terminal can reconstruct the screen. Returns '' on spawn failure.
function attachResume(opts: {
  channelId: string;
  sessionId: string;
  cols: number;
  rows: number;
  win: BrowserWindow;
  cwd?: string;
}): string {
  let sess = resumeSessions.get(opts.sessionId);

  if (!sess) {
    // Match dispatchBackground: resumed sessions don't inherit the original
    // session's permission mode, so re-assert bypassPermissions explicitly or
    // the user lands back in the default/auto mode after detach + reattach.
    const args = ['--resume', opts.sessionId, '--permission-mode', 'bypassPermissions'];
    const cwd = opts.cwd || os.homedir();
    console.log('[agentsflow][pty] spawning resume', { bin: CLAUDE_BIN, args, cwd, cols: opts.cols, rows: opts.rows });
    let pty: IPty;
    try {
      pty = getPty().spawn(CLAUDE_BIN, args, {
        name: 'xterm-256color',
        cols: Math.max(opts.cols, 20),
        rows: Math.max(opts.rows, 5),
        cwd,
        env: env(),
      });
    } catch (err) {
      console.error('[agentsflow][pty] resume spawn failed', err);
      if (!opts.win.isDestroyed()) {
        opts.win.webContents.send('terminal:data', opts.channelId, `\r\n\x1b[31m[pty spawn failed] ${(err as Error)?.message ?? err}\x1b[0m\r\n`);
        opts.win.webContents.send('terminal:exit', opts.channelId);
      }
      return '';
    }
    console.log('[agentsflow][pty] resume spawn ok', { sessionId: opts.sessionId, pid: pty.pid });

    const newSess: ResumeSession = {
      sessionId: opts.sessionId,
      pty,
      buffer: [],
      bufferBytes: 0,
      subscribers: new Map(),
    };
    resumeSessions.set(opts.sessionId, newSess);
    sess = newSess;

    pty.onData((data) => {
      const s = resumeSessions.get(opts.sessionId);
      if (!s) return;
      appendBuffer(s, data);
      for (const sub of s.subscribers.values()) {
        if (!sub.win.isDestroyed()) sub.win.webContents.send('terminal:data', sub.channelId, data);
      }
    });
    pty.onExit((e) => {
      console.log('[agentsflow][pty] resume onExit', { sessionId: opts.sessionId, exitCode: e.exitCode, signal: e.signal });
      const s = resumeSessions.get(opts.sessionId);
      if (!s) return;
      for (const sub of s.subscribers.values()) {
        if (!sub.win.isDestroyed()) sub.win.webContents.send('terminal:exit', sub.channelId);
        resumeChannelToSessionId.delete(sub.channelId);
      }
      resumeSessions.delete(opts.sessionId);
    });
  } else {
    // Re-attaching to a running resume session — resize to the new viewer's
    // geometry, which also nudges Claude to redraw the current screen.
    try {
      sess.pty.resize(Math.max(opts.cols, 20), Math.max(opts.rows, 5));
    } catch {
      // ignore
    }
  }

  sess.subscribers.set(opts.channelId, { channelId: opts.channelId, win: opts.win });
  resumeChannelToSessionId.set(opts.channelId, opts.sessionId);

  // Replay buffer is written by the renderer after its data listener is wired.
  return sess.buffer.length > 0 ? sess.buffer.join('') : '';
}

// ---------- Shells: one PTY per shellId, survives renderer detach ----------

interface ShellSubscriber { channelId: string; win: BrowserWindow; }
interface ShellState {
  shellId: string;
  pty: IPty;
  cwd: string;
  buffer: string[];        // chunks of recent output, capped by total bytes
  bufferBytes: number;
  subscribers: Map<string, ShellSubscriber>;
}
const shells = new Map<string, ShellState>();
const shellChannelToShellId = new Map<string, string>();

const SHELL_BUFFER_MAX_BYTES = 256 * 1024;

function appendBuffer(s: { buffer: string[]; bufferBytes: number }, data: string) {
  s.buffer.push(data);
  s.bufferBytes += data.length;
  while (s.bufferBytes > SHELL_BUFFER_MAX_BYTES && s.buffer.length > 1) {
    const removed = s.buffer.shift()!;
    s.bufferBytes -= removed.length;
  }
}

export function attachShell(opts: {
  shellId: string;
  channelId: string;
  cwd: string;
  cols: number;
  rows: number;
  win: BrowserWindow;
}): string {
  let shell = shells.get(opts.shellId);

  if (!shell) {
    const shellBin = process.env.SHELL || '/bin/zsh';
    const env = withUtf8Locale({
      ...process.env,
      PATH: `${process.env.PATH}:${path.join(os.homedir(), '.local/bin')}`,
      TERM: 'xterm-256color',
    } as Record<string, string>);
    console.log('[agentsflow][pty] spawning shell', { shellId: opts.shellId, shell: shellBin, cwd: opts.cwd, cols: opts.cols, rows: opts.rows });
    let pty: IPty;
    try {
      pty = getPty().spawn(shellBin, ['-l'], {
        name: 'xterm-256color',
        cols: Math.max(opts.cols, 20),
        rows: Math.max(opts.rows, 5),
        cwd: opts.cwd,
        env,
      });
    } catch (err) {
      console.error('[agentsflow][pty] shell spawn failed', err);
      if (!opts.win.isDestroyed()) {
        opts.win.webContents.send('terminal:data', opts.channelId, `\r\n\x1b[31m[shell spawn failed] ${(err as Error)?.message ?? err}\x1b[0m\r\n`);
        opts.win.webContents.send('terminal:exit', opts.channelId);
      }
      return '';
    }
    console.log('[agentsflow][pty] shell spawn ok', { shellId: opts.shellId, pid: pty.pid });

    const newShell: ShellState = {
      shellId: opts.shellId,
      pty,
      cwd: opts.cwd,
      buffer: [],
      bufferBytes: 0,
      subscribers: new Map(),
    };
    shells.set(opts.shellId, newShell);
    shell = newShell;

    pty.onData((data) => {
      const s = shells.get(opts.shellId);
      if (!s) return;
      appendBuffer(s, data);
      for (const sub of s.subscribers.values()) {
        if (!sub.win.isDestroyed()) {
          sub.win.webContents.send('terminal:data', sub.channelId, data);
        }
      }
    });
    pty.onExit((e) => {
      console.log('[agentsflow][pty] shell onExit', { shellId: opts.shellId, exitCode: e.exitCode, signal: e.signal });
      const s = shells.get(opts.shellId);
      if (!s) return;
      for (const sub of s.subscribers.values()) {
        if (!sub.win.isDestroyed()) sub.win.webContents.send('terminal:exit', sub.channelId);
        shellChannelToShellId.delete(sub.channelId);
      }
      shells.delete(opts.shellId);
    });
  } else {
    // Re-attaching to an existing shell — resize PTY to the new viewer's geometry.
    try {
      shell.pty.resize(Math.max(opts.cols, 20), Math.max(opts.rows, 5));
    } catch {
      // ignore
    }
  }

  shell.subscribers.set(opts.channelId, { channelId: opts.channelId, win: opts.win });
  shellChannelToShellId.set(opts.channelId, opts.shellId);

  // Return the replay buffer to the caller so the renderer can write it AFTER
  // it has registered its `terminal:data` listener. Sending the replay through
  // the data IPC here would race the listener registration and get dropped.
  return shell.buffer.length > 0 ? shell.buffer.join('') : '';
}

export function listShellIds(): string[] {
  return Array.from(shells.keys());
}

export function killShell(shellId: string): void {
  const s = shells.get(shellId);
  if (!s) return;
  try { s.pty.kill(); } catch { /* ignore */ }
  // onExit handler will clean up subscribers + map entries.
}

// ---------- Shared per-channel API ----------

export function write(channelId: string, data: string): void {
  const cc = claudeChannels.get(channelId);
  if (cc) { cc.pty.write(data); return; }
  const rsid = resumeChannelToSessionId.get(channelId);
  if (rsid) { resumeSessions.get(rsid)?.pty.write(data); return; }
  const sid = shellChannelToShellId.get(channelId);
  if (!sid) return;
  shells.get(sid)?.pty.write(data);
}

export function resize(channelId: string, cols: number, rows: number): void {
  try {
    const cc = claudeChannels.get(channelId);
    if (cc) { cc.pty.resize(Math.max(cols, 20), Math.max(rows, 5)); return; }
    const rsid = resumeChannelToSessionId.get(channelId);
    if (rsid) { resumeSessions.get(rsid)?.pty.resize(Math.max(cols, 20), Math.max(rows, 5)); return; }
    const sid = shellChannelToShellId.get(channelId);
    if (!sid) return;
    shells.get(sid)?.pty.resize(Math.max(cols, 20), Math.max(rows, 5));
  } catch {
    // ignore
  }
}

export function detach(channelId: string): void {
  // Claude attach-mode viewer: kill the PTY (the daemon keeps running).
  const cc = claudeChannels.get(channelId);
  if (cc) {
    try { cc.pty.kill(); } catch { /* ignore */ }
    claudeChannels.delete(channelId);
    return;
  }
  // Claude resume session: just unsubscribe — the agent keeps running in the
  // background so the in-progress turn isn't aborted by detaching the view.
  const rsid = resumeChannelToSessionId.get(channelId);
  if (rsid) {
    resumeSessions.get(rsid)?.subscribers.delete(channelId);
    resumeChannelToSessionId.delete(channelId);
    return;
  }
  // Shell: just unsubscribe — PTY stays alive for future re-attach.
  const sid = shellChannelToShellId.get(channelId);
  if (!sid) return;
  const s = shells.get(sid);
  s?.subscribers.delete(channelId);
  shellChannelToShellId.delete(channelId);
}

export function detachAll(): void {
  for (const id of Array.from(claudeChannels.keys())) {
    const cc = claudeChannels.get(id);
    if (cc) { try { cc.pty.kill(); } catch { /* ignore */ } claudeChannels.delete(id); }
  }
  for (const sid of Array.from(resumeSessions.keys())) {
    const s = resumeSessions.get(sid);
    if (s) { try { s.pty.kill(); } catch { /* ignore */ } resumeSessions.delete(sid); }
  }
  for (const id of Array.from(shells.keys())) killShell(id);
}
