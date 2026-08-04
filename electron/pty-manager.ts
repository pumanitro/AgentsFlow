import { BrowserWindow } from 'electron';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import type { IPty } from 'node-pty';
import { withUtf8Locale } from './locale';
import { buildResumeArgs, redactResumeArgs } from './resume-args';

const execFileAsync = promisify(execFile);

let ptyMod: typeof import('node-pty') | null = null;
function getPty(): typeof import('node-pty') {
  if (!ptyMod) {
    // Lazy require so the rest of the app can boot even if rebuild hasn't run.
    ptyMod = require('node-pty');
  }
  return ptyMod!;
}

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// ---------- node-pty callback safety ----------
// node-pty invokes our onData/onExit callbacks from a *native* N-API
// ThreadSafeFunction. If our JS callback throws, node-addon-api re-throws the
// exception as a C++ exception out of that native callback, which node-pty does
// not catch — it reaches std::terminate() → abort() and SIGABRTs the whole app.
// This is uncatchable by process.on('uncaughtException') because it terminates
// in native code, not the JS event loop. (Observed crash: an "Object has been
// destroyed" throw from webContents.send inside onExit during window teardown.)
// So every pty callback body MUST be wrapped so nothing can escape into native.
function guardCb<A extends unknown[]>(label: string, fn: (...args: A) => void): (...args: A) => void {
  return (...args: A) => {
    try {
      fn(...args);
    } catch (err) {
      // Swallow + log: throwing here would abort the process. Never re-throw.
      console.error(`[agentsflow][pty] ${label} callback threw (suppressed to avoid native abort)`, err);
    }
  };
}

// webContents can be destroyed independently of its BrowserWindow (reload,
// navigation, teardown), and win.isDestroyed() is racy against the send that
// follows it. Check both layers and never let a send throw — this is the
// specific call that was aborting the app from inside pty onExit.
function safeSend(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  try {
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send(channel, ...args);
  } catch (err) {
    console.error('[agentsflow][pty] webContents.send failed', { channel }, err);
  }
}

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

// TERM_PROGRAM identifies the hosting terminal to the programs we spawn. Left
// unset, Claude Code can't name us and /terminal-setup reports it can't run
// "from xterm-256color" (the bare TERM string). This is deliberately NOT one of
// the values /terminal-setup knows how to configure (Apple_Terminal, vscode,
// iTerm.app) — claiming those would make it write a keybinding into some other
// app's config. We just want to be identifiable; Terminal.tsx already sends
// \x1b\r for Shift+Enter itself, so we need nothing from /terminal-setup.
const TERM_PROGRAM = 'PeersFlow';

const env = () => withUtf8Locale({
  ...process.env,
  PATH: `${process.env.PATH}:${path.join(os.homedir(), '.local/bin')}`,
  TERM: 'xterm-256color',
  TERM_PROGRAM,
} as Record<string, string>);

interface ClaudeChannel { id: string; pty: IPty; win: BrowserWindow; sessionId: string; }
const claudeChannels = new Map<string, ClaudeChannel>();

interface ResumeSession {
  sessionId: string;
  pty: IPty;
  buffer: string[];
  bufferBytes: number;
  subscribers: Map<string, ShellSubscriber>;
  lastDataAt: number;            // last time the PTY produced output
  detachedAt: number | null;     // when the last subscriber left (null while watched)
}
const resumeSessions = new Map<string, ResumeSession>();
const resumeChannelToSessionId = new Map<string, string>();

// ---------- PTY capacity guard ----------
// node-pty's native spawn (PtyFork) throws a C++ exception when forkpty() fails
// — most commonly because the OS can't allocate a pseudo-terminal, i.e. macOS
// has hit its system-wide cap (`kern.tty.ptmx_max`, 511 by default). That throw
// crosses the native/V8 boundary and is *uncatchable* by the JS try/catch
// around spawn(): it reaches std::terminate → abort(), taking the whole app
// down with SIGABRT. So we must refuse to spawn *before* node-pty does, while
// the OS still has a pty to give us.
//
// Two ceilings, because there are two distinct ways to run out:
//
//  1. Our own handle count (MAX_LIVE_PTYS). A simple self-limit so a runaway in
//     this app alone can't monopolise the budget.
//
//  2. The *system-wide* live-pty count. This is the one that actually bit us:
//     `kern.tty.ptmx_max` is shared across EVERY process on the machine — our
//     terminals, the user's iTerm2 tabs, other Electron apps — so the app can
//     sit comfortably under its own ceiling while the system as a whole runs
//     dry, and the next forkpty() aborts. We read the live count straight from
//     devfs: every allocated unix98 pty has a `/dev/ttysNNN` slave node, so a
//     single readdir of /dev (~0.1ms, no subprocess, consumes no fds — which
//     matters precisely when fds/ptys are scarce) gives an accurate, slightly
//     conservative count. We refuse once within SYSTEM_PTY_MARGIN of the cap.
const MAX_LIVE_PTYS = Number(process.env.AGENTSFLOW_MAX_PTYS) || 64;
const SYSTEM_PTY_MARGIN = Number(process.env.AGENTSFLOW_PTY_MARGIN) || 60;
const SYSTEM_PTY_CACHE_MS = 1000;

// kern.tty.ptmx_max, read once at startup. Defaults to the macOS default (511)
// if sysctl is unavailable (e.g. non-macOS), so the guard degrades safely.
const PTMX_MAX = (() => {
  try {
    const n = Number(execFileSync('sysctl', ['-n', 'kern.tty.ptmx_max'], { encoding: 'utf8' }).trim());
    return Number.isFinite(n) && n > 0 ? n : 511;
  } catch {
    return 511;
  }
})();

function livePtyCount(): number {
  return claudeChannels.size + resumeSessions.size + shells.size;
}

// Live system-wide unix98 pty count, via devfs slave nodes (`/dev/ttysNNN`).
// Cached briefly so a burst of spawns doesn't readdir on every call. Returns 0
// if /dev can't be read (non-macOS, sandbox), which disables only this check
// and leaves the own-count guard in force.
const TTYS_SLAVE_RE = /^ttys\d{3,}$/;
let cachedSystemPtys = 0;
let cachedSystemPtysAt = 0;
function systemPtyCount(): number {
  const now = Date.now();
  if (cachedSystemPtysAt && now - cachedSystemPtysAt < SYSTEM_PTY_CACHE_MS) return cachedSystemPtys;
  let count = 0;
  try {
    for (const name of fs.readdirSync('/dev')) {
      if (TTYS_SLAVE_RE.test(name)) count++;
    }
  } catch {
    count = 0;
  }
  cachedSystemPtys = count;
  cachedSystemPtysAt = now;
  return count;
}

// Final, resource-agnostic gate: can the OS create a child process *right now*?
// node-pty's native spawn does openpty() + fork(). In practice it aborts us not
// at the pty cap (the checks above) but one step deeper: fork() returning EAGAIN
// when the per-user process/thread table is full, or open("/dev/ptmx") returning
// EMFILE when *our own* fd table is full. Both modes are invisible to a count of
// ptys — the crash that motivated this guard happened with only a handful of our
// own PTYs live — and a forkpty() failure is an *uncatchable* native throw that
// SIGABRTs the whole app. So before handing control to node-pty, we probe the
// very same kernel operation with a throwaway child we can actually observe:
// child_process surfaces EAGAIN/EMFILE/ENFILE/ENOMEM as an ordinary `{ error }`
// to branch on instead of crashing. If the probe is starved, forkpty() would be
// too. (Caveat: Node uses posix_spawn while forkpty uses fork(), so a pure
// fork-only ENOMEM could slip past — but the dominant EAGAIN/EMFILE cases, which
// both share, are exactly the ones that were aborting us.)
//
// CRITICAL: this probe is *async* (execFile, not spawnSync). The synchronous
// version blocked the Electron main thread for the entire fork()+wait of a child
// — up to the 2s timeout — on EVERY pty spawn. During the agent re-attach burst
// (several `claude attach` PTYs spawned back-to-back on residency), those
// synchronous probes stacked up and froze the UI for tens of seconds, ending in
// a force-quit (a hang with no .ips and no JS trace). Awaiting an async probe
// keeps the event loop pumping while the throwaway child runs, so the window
// stays responsive no matter how many spawns are queued.
const FORK_PROBE_BIN = '/usr/bin/true';
const FORK_STARVED_ERRNOS = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM']);
async function forkStarvedErrno(): Promise<string | null> {
  try {
    await execFileAsync(FORK_PROBE_BIN, [], { timeout: 2000 });
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // A real fork starvation surfaces as EAGAIN/EMFILE/ENFILE/ENOMEM. Anything
    // else — ENOENT (probe binary absent, e.g. non-macOS), ETIMEDOUT (the probe
    // child outran its budget), a non-zero exit — means "can't tell": fail open
    // so we never refuse a legitimate spawn on the probe's account.
    return code && FORK_STARVED_ERRNOS.has(code) ? code : null;
  }
}

function refusePty(win: BrowserWindow, channelId: string, message: string): false {
  safeSend(win, 'terminal:data', channelId, `\r\n\x1b[31m${message}\x1b[0m\r\n`);
  safeSend(win, 'terminal:exit', channelId);
  return false;
}

// True if another PTY may be spawned. On false, emits a graceful error to the
// channel (mirroring the spawn-failure path) so the renderer surfaces it
// instead of the app aborting. Async because the fork probe must not block the
// main thread (see forkStarvedErrno) — callers await it before node-pty spawn.
async function ensurePtyCapacity(win: BrowserWindow, channelId: string, label: string): Promise<boolean> {
  let live = livePtyCount();
  let sys = systemPtyCount();

  // Over either ceiling: reclaim before refusing. The guard used to be a dead
  // end — once the count was over the line it refused *every* subsequent spawn,
  // and since refusing frees nothing, the app could never open another terminal
  // until it was restarted. (2026-07-23: the machine sat at 453/511 ptys — only
  // 12 of them ours — and from then on every attach failed, which is what made a
  // recoverable resource squeeze look like a broken app.) Killing the PTYs that
  // are safely killable first turns the ceiling into something the app can climb
  // back down from on its own.
  if (live >= MAX_LIVE_PTYS || (sys > 0 && sys > PTMX_MAX - SYSTEM_PTY_MARGIN)) {
    const reclaimed = reapIdlePtys({ pressure: true });
    if (reclaimed > 0) {
      console.warn(`[agentsflow][pty] ${label} spawn hit the ceiling — reclaimed ${reclaimed} idle pty(s), re-checking`, { live, systemPtys: sys });
      cachedSystemPtysAt = 0; // the count just changed — don't trust the 1s cache
      live = livePtyCount();
      sys = systemPtyCount();
    }
  }

  if (live >= MAX_LIVE_PTYS) {
    console.error(`[agentsflow][pty] refusing to spawn ${label}: app PTY ceiling reached`, { live, max: MAX_LIVE_PTYS });
    return refusePty(win, channelId, `[${label} spawn refused] too many open terminals in this app (${live}/${MAX_LIVE_PTYS}). Close some sessions or shells, then retry.`);
  }
  if (sys > 0 && sys > PTMX_MAX - SYSTEM_PTY_MARGIN) {
    console.error(`[agentsflow][pty] refusing to spawn ${label}: system PTY budget nearly exhausted`, { systemPtys: sys, ptmxMax: PTMX_MAX, margin: SYSTEM_PTY_MARGIN });
    return refusePty(win, channelId, `[${label} spawn refused] the system is almost out of pseudo-terminals (${sys}/${PTMX_MAX} in use across all apps). Close some terminals here or in other apps, then retry.`);
  }
  const starved = await forkStarvedErrno();
  if (starved) {
    console.error(`[agentsflow][pty] refusing to spawn ${label}: OS cannot start a new process right now`, { errno: starved });
    return refusePty(win, channelId, `[${label} spawn refused] the system is temporarily out of resources to start a new process (${starved}). This usually clears on its own — close some sessions or other apps, then retry.`);
  }
  return true;
}

// ---------- Idle-PTY reaper ----------
// Shells and resume sessions are deliberately kept alive across renderer detach
// (instant re-attach; in-progress turns aren't aborted). Their underlying
// processes (`zsh -l`, `claude --resume`) don't self-exit, so over a long
// session they accumulate toward the OS PTY cap — which is what drove the
// SIGABRT crashes. The reaper kills the ones that have been detached *and*
// silent past a TTL: nobody's watching and nothing's happening. Resume sessions
// get a longer TTL, and "idle" requires zero output, so an actively printing
// turn is never reaped — only a quiet, detached (very likely finished) one.
const SHELL_IDLE_TTL_MS = 30 * 60 * 1000;
const RESUME_IDLE_TTL_MS = 60 * 60 * 1000;
const REAPER_INTERVAL_MS = 5 * 60 * 1000;
// Under pressure (a spawn is being refused right now) the TTLs collapse.
// "Detached and silent for a few minutes" is a much weaker claim than the hour
// we normally wait — but it is still a strictly safe one: nobody is watching the
// PTY and nothing has printed on it. Weighed against the alternative, which is
// refusing every terminal the user opens until they restart the app, it is the
// better trade.
const PRESSURE_SHELL_TTL_MS = 2 * 60 * 1000;
const PRESSURE_RESUME_TTL_MS = 5 * 60 * 1000;

let reaperTimer: ReturnType<typeof setInterval> | null = null;
function startPtyReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(reapIdlePtys, REAPER_INTERVAL_MS);
  // Don't keep the process alive just for the reaper.
  reaperTimer.unref?.();
}

/** Kills detached, silent PTYs. Returns how many were reclaimed. */
function reapIdlePtys(opts: { pressure?: boolean } = {}): number {
  const shellTtl = opts.pressure ? PRESSURE_SHELL_TTL_MS : SHELL_IDLE_TTL_MS;
  const resumeTtl = opts.pressure ? PRESSURE_RESUME_TTL_MS : RESUME_IDLE_TTL_MS;
  const why = opts.pressure ? ' (under pty pressure)' : '';
  const now = Date.now();
  let reclaimed = 0;
  for (const [shellId, s] of Array.from(shells.entries())) {
    if (s.subscribers.size > 0 || s.detachedAt == null) continue;
    if (now - s.detachedAt < shellTtl || now - s.lastDataAt < shellTtl) continue;
    console.log(`[agentsflow][pty] reaping idle shell${why}`, { shellId, idleMs: now - s.lastDataAt });
    try { s.pty.kill(); } catch { /* ignore */ }
    shells.delete(shellId);
    reclaimed++;
  }
  for (const [sessionId, s] of Array.from(resumeSessions.entries())) {
    if (s.subscribers.size > 0 || s.detachedAt == null) continue;
    if (now - s.detachedAt < resumeTtl || now - s.lastDataAt < resumeTtl) continue;
    console.log(`[agentsflow][pty] reaping idle resume session${why}`, { sessionId, idleMs: now - s.lastDataAt });
    try { s.pty.kill(); } catch { /* ignore */ }
    resumeSessions.delete(sessionId);
    reclaimed++;
  }
  return reclaimed;
}

export async function attach(opts: {
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
  // Fork mode (resume only): branch a copy of THIS session id instead of
  // resuming `sessionId` itself. Spawns `--resume <forkFrom> --fork-session
  // --session-id <sessionId>`, so the new transcript lands at the caller's
  // pre-assigned `sessionId`. Forking sidesteps the CLI's residency guard —
  // it works even when `forkFrom` is held by a live (or crash-looping) daemon.
  forkFrom?: string;
  // Peer awareness (resume/fork only — see attachResume). Ignored in 'attach'
  // mode, where the daemon already carries what it was spawned with.
  mcpConfigPath?: string;
  appendSystemPrompt?: string;
}): Promise<string> {
  startPtyReaper();
  const mode = opts.mode ?? 'attach';
  if (mode === 'resume') return attachResume(opts);

  const args = ['attach', opts.sessionId];
  const cwd = os.homedir();
  console.log('[agentsflow][pty] spawning', { bin: CLAUDE_BIN, args, cols: opts.cols, rows: opts.rows, cwd, mode });
  if (!(await ensurePtyCapacity(opts.win, opts.channelId, 'pty'))) return '';
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
    safeSend(opts.win, 'terminal:data', opts.channelId, `\r\n\x1b[31m[pty spawn failed] ${(err as Error)?.message ?? err}\x1b[0m\r\n`);
    safeSend(opts.win, 'terminal:exit', opts.channelId);
    return '';
  }
  console.log('[agentsflow][pty] spawn ok', { pid: pty.pid });

  const ch: ClaudeChannel = { id: opts.channelId, pty, win: opts.win, sessionId: opts.sessionId };
  claudeChannels.set(opts.channelId, ch);

  pty.onData(guardCb('attach onData', (data) => {
    safeSend(ch.win, 'terminal:data', opts.channelId, data);
  }));
  // Logged like the shell/resume exits below. Without this, an attach PTY's
  // whole lifecycle was write-only in the log — every spawn recorded, no exit
  // ever — so "88 spawns, 0 exits" read as a leak when reconstructing an
  // incident, and a *real* leak would have looked identical.
  pty.onExit(guardCb('attach onExit', (e) => {
    console.log('[agentsflow][pty] attach onExit', {
      sessionId: opts.sessionId,
      pid: pty.pid,
      exitCode: e?.exitCode,
      signal: e?.signal,
    });
    safeSend(ch.win, 'terminal:exit', opts.channelId);
    claudeChannels.delete(opts.channelId);
  }));
  return '';
}

/** Live PTY/subsystem counts for the heartbeat. Cheap: no subprocess, no fds. */
export function ptyStats(): Record<string, number> {
  return {
    attachPtys: claudeChannels.size,
    resumePtys: resumeSessions.size,
    shellPtys: shells.size,
    systemPtys: systemPtyCount(),
    ptmxMax: PTMX_MAX,
  };
}

// Persistent, subscriber-based attach for `claude --resume`. Mirrors attachShell:
// spawn once per sessionId, reuse on re-attach, and return a replay buffer so a
// re-mounted terminal can reconstruct the screen. Returns '' on spawn failure.
async function attachResume(opts: {
  channelId: string;
  sessionId: string;
  cols: number;
  rows: number;
  win: BrowserWindow;
  cwd?: string;
  forkFrom?: string;
  mcpConfigPath?: string;
  appendSystemPrompt?: string;
}): Promise<string> {
  let sess = resumeSessions.get(opts.sessionId);

  if (!sess) {
    const args = buildResumeArgs(opts);
    const cwd = opts.cwd || os.homedir();
    console.log('[agentsflow][pty] spawning resume', { bin: CLAUDE_BIN, args: redactResumeArgs(args), cwd, cols: opts.cols, rows: opts.rows });
    if (!(await ensurePtyCapacity(opts.win, opts.channelId, 'resume'))) return '';
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
      safeSend(opts.win, 'terminal:data', opts.channelId, `\r\n\x1b[31m[pty spawn failed] ${(err as Error)?.message ?? err}\x1b[0m\r\n`);
      safeSend(opts.win, 'terminal:exit', opts.channelId);
      return '';
    }
    console.log('[agentsflow][pty] resume spawn ok', { sessionId: opts.sessionId, pid: pty.pid });

    const newSess: ResumeSession = {
      sessionId: opts.sessionId,
      pty,
      buffer: [],
      bufferBytes: 0,
      subscribers: new Map(),
      lastDataAt: Date.now(),
      detachedAt: null,
    };
    resumeSessions.set(opts.sessionId, newSess);
    sess = newSess;

    pty.onData(guardCb('resume onData', (data) => {
      const s = resumeSessions.get(opts.sessionId);
      if (!s) return;
      s.lastDataAt = Date.now();
      appendBuffer(s, data, RESUME_BUFFER_MAX_BYTES);
      for (const sub of s.subscribers.values()) {
        safeSend(sub.win, 'terminal:data', sub.channelId, data);
      }
    }));
    pty.onExit(guardCb('resume onExit', (e) => {
      console.log('[agentsflow][pty] resume onExit', { sessionId: opts.sessionId, exitCode: e.exitCode, signal: e.signal });
      const s = resumeSessions.get(opts.sessionId);
      if (!s) return;
      for (const sub of s.subscribers.values()) {
        safeSend(sub.win, 'terminal:exit', sub.channelId);
        resumeChannelToSessionId.delete(sub.channelId);
      }
      resumeSessions.delete(opts.sessionId);
    }));
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
  sess.detachedAt = null;
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
  lastDataAt: number;            // last time the PTY produced output
  detachedAt: number | null;     // when the last subscriber left (null while watched)
}
const shells = new Map<string, ShellState>();
const shellChannelToShellId = new Map<string, string>();

const SHELL_BUFFER_MAX_BYTES = 256 * 1024;
// Resume sessions get a much larger replay cap than shells. On re-attach, xterm
// is rebuilt entirely from this buffer (there's no fresh reprint like a cold
// `claude --resume`), so the cap is the ceiling on how far back you can scroll.
// A full Claude transcript reprint — ANSI colors, box-drawing, tool output,
// in-place repaints — easily blows past 256 KB, which used to evict the top of
// the conversation and leave the terminal unable to scroll to it. Resume ptys
// are few and user-opened (unlike chatty shells), so the memory trade-off is
// cheap. ~4 MB comfortably holds a reprint within xterm's 10 000-line window.
const RESUME_BUFFER_MAX_BYTES = Number(process.env.AGENTSFLOW_RESUME_BUFFER_MAX_BYTES) || 4 * 1024 * 1024;

function appendBuffer(
  s: { buffer: string[]; bufferBytes: number },
  data: string,
  maxBytes: number = SHELL_BUFFER_MAX_BYTES,
) {
  s.buffer.push(data);
  s.bufferBytes += data.length;
  while (s.bufferBytes > maxBytes && s.buffer.length > 1) {
    const removed = s.buffer.shift()!;
    s.bufferBytes -= removed.length;
  }
}

// A command to run automatically the first time a given shell is spawned. Used
// by the account-add flow, which must open a terminal *and* start the one-time
// `claude auth login` inside it. Registered before the renderer attaches, and
// written on spawn — so it can't race the user's own typing or a subscriber.
const pendingShellCommands = new Map<string, string>();

/** Queue `command` to run when shell `shellId` is next spawned (one-shot). */
export function queueShellCommand(shellId: string, command: string): void {
  pendingShellCommands.set(shellId, command);
}

export function cancelShellCommand(shellId: string): void {
  pendingShellCommands.delete(shellId);
}

export async function attachShell(opts: {
  shellId: string;
  channelId: string;
  cwd: string;
  cols: number;
  rows: number;
  win: BrowserWindow;
}): Promise<string> {
  startPtyReaper();
  let shell = shells.get(opts.shellId);

  if (!shell) {
    const shellBin = process.env.SHELL || '/bin/zsh';
    console.log('[agentsflow][pty] spawning shell', { shellId: opts.shellId, shell: shellBin, cwd: opts.cwd, cols: opts.cols, rows: opts.rows });
    if (!(await ensurePtyCapacity(opts.win, opts.channelId, 'shell'))) return '';
    let pty: IPty;
    try {
      pty = getPty().spawn(shellBin, ['-l'], {
        name: 'xterm-256color',
        cols: Math.max(opts.cols, 20),
        rows: Math.max(opts.rows, 5),
        cwd: opts.cwd,
        env: env(),
      });
    } catch (err) {
      console.error('[agentsflow][pty] shell spawn failed', err);
      safeSend(opts.win, 'terminal:data', opts.channelId, `\r\n\x1b[31m[shell spawn failed] ${(err as Error)?.message ?? err}\x1b[0m\r\n`);
      safeSend(opts.win, 'terminal:exit', opts.channelId);
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
      lastDataAt: Date.now(),
      detachedAt: null,
    };
    shells.set(opts.shellId, newShell);
    shell = newShell;

    pty.onData(guardCb('shell onData', (data) => {
      const s = shells.get(opts.shellId);
      if (!s) return;
      s.lastDataAt = Date.now();
      appendBuffer(s, data);
      for (const sub of s.subscribers.values()) {
        safeSend(sub.win, 'terminal:data', sub.channelId, data);
      }
    }));
    // One-shot startup command (account login). Written after the handlers are
    // wired so its output is captured in the replay buffer like anything else.
    const queued = pendingShellCommands.get(opts.shellId);
    if (queued) {
      pendingShellCommands.delete(opts.shellId);
      try {
        pty.write(`${queued}\r`);
      } catch (err) {
        console.warn('[agentsflow][pty] queued shell command failed to write', (err as Error)?.message ?? err);
      }
    }

    pty.onExit(guardCb('shell onExit', (e) => {
      console.log('[agentsflow][pty] shell onExit', { shellId: opts.shellId, exitCode: e.exitCode, signal: e.signal });
      const s = shells.get(opts.shellId);
      if (!s) return;
      for (const sub of s.subscribers.values()) {
        safeSend(sub.win, 'terminal:exit', sub.channelId);
        shellChannelToShellId.delete(sub.channelId);
      }
      shells.delete(opts.shellId);
    }));
  } else {
    // Re-attaching to an existing shell — resize PTY to the new viewer's geometry.
    try {
      shell.pty.resize(Math.max(opts.cols, 20), Math.max(opts.rows, 5));
    } catch {
      // ignore
    }
  }

  shell.subscribers.set(opts.channelId, { channelId: opts.channelId, win: opts.win });
  shell.detachedAt = null;
  shellChannelToShellId.set(opts.channelId, opts.shellId);

  // Return the replay buffer to the caller so the renderer can write it AFTER
  // it has registered its `terminal:data` listener. Sending the replay through
  // the data IPC here would race the listener registration and get dropped.
  return shell.buffer.length > 0 ? shell.buffer.join('') : '';
}

export function listShellIds(): string[] {
  return Array.from(shells.keys());
}

// True if this app already holds a live `claude --resume` PTY for the session.
// term:attach checks this FIRST: an in-app resume registers itself in
// `claude agents` as an "interactive" session, so consulting daemon residency
// would misroute the re-attach to a `claude attach` viewer of our own child
// instead of re-subscribing to the PTY we already own.
export function hasResumeSession(sessionId: string): boolean {
  return !!sessionId && resumeSessions.has(sessionId);
}

// True if a Claude session is currently being watched in the app — either an
// `attach` viewer or a live `resume` session. The daemon reaper uses this to
// avoid stopping a daemon the user is actively looking at.
export function hasLiveViewer(sessionId: string): boolean {
  if (!sessionId) return false;
  if (resumeSessions.has(sessionId)) return true;
  for (const ch of claudeChannels.values()) {
    if (ch.sessionId === sessionId) return true;
  }
  return false;
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
    const rs = resumeSessions.get(rsid);
    rs?.subscribers.delete(channelId);
    resumeChannelToSessionId.delete(channelId);
    // Last viewer gone — start the idle clock so the reaper can reclaim the PTY.
    if (rs && rs.subscribers.size === 0) rs.detachedAt = Date.now();
    return;
  }
  // Shell: just unsubscribe — PTY stays alive for future re-attach.
  const sid = shellChannelToShellId.get(channelId);
  if (!sid) return;
  const s = shells.get(sid);
  s?.subscribers.delete(channelId);
  shellChannelToShellId.delete(channelId);
  if (s && s.subscribers.size === 0) s.detachedAt = Date.now();
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
