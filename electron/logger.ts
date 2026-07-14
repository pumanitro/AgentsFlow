import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { recentSlowOpsSummary } from './perf';

// ---------- Persistent main-process logging ----------
// Until now the main process only ever wrote to console.*, which in dev scrolls
// past in the terminal and in a packaged build goes nowhere. When the app
// crashed we were left with only the OS-level .ips reports and no application
// context. This module mirrors every console.* call to a rotating-ish log file
// and installs last-resort handlers so future incidents leave a trace on disk.
//
// IMPORTANT: a *native* terminate (e.g. a JS exception escaping a node-pty
// ThreadSafeFunction callback → std::terminate → abort) never reaches
// process.on('uncaughtException'). Those must be prevented at the source by
// guarding the offending callback. The handlers here catch the ordinary JS
// failures that *are* observable; they are a safety net, not a substitute for
// not throwing across the native boundary.

let installed = false;
let logFilePath = '';

function resolveLogDir(): string {
  // Prefer the OS logs dir (~/Library/Logs/Peers Flow on macOS); fall back to
  // userData/logs. Both are available before app `ready`.
  for (const getter of [
    () => app.getPath('logs'),
    () => path.join(app.getPath('userData'), 'logs'),
  ]) {
    try {
      const dir = getter();
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* try next */
    }
  }
  return '';
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function writeLine(level: string, args: unknown[]): void {
  if (!logFilePath) return;
  try {
    // Synchronous append — NOT an async WriteStream. The stream buffered writes
    // and silently dropped the last lines when the process exited fast (a quit,
    // a signal-driven teardown, a force-exit) — which is exactly when the
    // before-quit / [signal] / [fatal] / [stall] lines matter most. (Observed:
    // a clean quit whose `before-quit` never reached disk, making a normal
    // restart look like a traceless crash.) appendFileSync guarantees the line
    // is on disk before we return, so the log can be trusted to explain an exit.
    // Volume here is control-plane only (a few lines/sec), so the per-call cost
    // is irrelevant.
    fs.appendFileSync(logFilePath, `${new Date().toISOString()} [${level}] ${fmt(args)}\n`);
  } catch {
    /* a broken log file must never take down the app */
  }
}

export function getLogFilePath(): string {
  return logFilePath;
}

// Call once, as early as possible in main.ts (after app.setName). Patches
// console.*, opens the log file, and registers global failure handlers.
export function installCrashLogging(): void {
  if (installed) return;
  installed = true;

  const dir = resolveLogDir();
  if (dir) {
    logFilePath = path.join(dir, 'main.log');
  }

  // Mirror console.* to the file while preserving the original terminal output.
  const levels: Array<{ method: 'log' | 'info' | 'warn' | 'error'; level: string }> = [
    { method: 'log', level: 'INFO' },
    { method: 'info', level: 'INFO' },
    { method: 'warn', level: 'WARN' },
    { method: 'error', level: 'ERROR' },
  ];
  for (const { method, level } of levels) {
    const orig = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      writeLine(level, args);
      orig(...args);
    };
  }

  console.log(
    `[agentsflow] === main process start === pid=${process.pid} electron=${process.versions.electron} node=${process.versions.node} log=${logFilePath || '(file disabled)'}`,
  );

  // Ordinary JS failures. We log and keep running: an uncaught exception in the
  // main process is usually non-fatal here, and exiting would kill every live
  // session/terminal the user has open. console.error is patched above, so this
  // lands in both the terminal and the file.
  process.on('uncaughtException', (err) => {
    console.error('[agentsflow][fatal] uncaughtException', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[agentsflow][fatal] unhandledRejection', reason);
  });

  // Renderer / utility / GPU process crashes. These are reported to the main
  // process rather than crashing it, so they are pure signal for diagnosis.
  app.on('render-process-gone', (_e, _wc, details) => {
    console.error('[agentsflow][fatal] render-process-gone', details);
  });
  app.on('child-process-gone', (_e, details) => {
    console.error('[agentsflow][fatal] child-process-gone', details);
  });

  // ---------- Main-thread stall detector ----------
  // The failure mode that left NO trace at all (no .ips, no JS error): the main
  // process froze for ~43s — UI unresponsive — and was force-quit. A blocked
  // event loop can't log *while* it's blocked, but it CAN log once it recovers:
  // a fixed-interval timer that fires late by more than the threshold means the
  // loop was wedged for that long. This is the single most useful breadcrumb for
  // diagnosing a freeze-then-force-quit after the fact. (If the loop never
  // recovers and the process is killed, the absence of this line — combined with
  // the lifecycle/signal lines below — still narrows the cause.)
  const LOOP_TICK_MS = 2000;
  const LOOP_STALL_THRESHOLD_MS = 4000;
  let lastTick = Date.now();
  const loopMon = setInterval(() => {
    const now = Date.now();
    const stall = now - lastTick - LOOP_TICK_MS;
    if (stall > LOOP_STALL_THRESHOLD_MS) {
      // Append the recent slow-op history so a freeze can be attributed to the
      // operation that caused it, instead of just recording that one happened.
      console.error(`[agentsflow][stall] main event loop blocked for ~${Math.round(stall)}ms — the UI was frozen${recentSlowOpsSummary()}`);
    }
    lastTick = now;
  }, LOOP_TICK_MS);
  loopMon.unref?.();

  // ---------- Termination attribution ----------
  // A plain Cmd+Q and an external SIGKILL both leave the log silent today, so a
  // "crash" report can't be classified after the fact. Log the app lifecycle and
  // catchable signals so the NEXT incident is attributable: a clean quit shows
  // `before-quit`/`quit`; a `npm run dev` / Ctrl+C teardown shows the signal;
  // and a hard SIGKILL/jetsam shows none of these (→ look for an .ips, then OS
  // memory pressure). SIGKILL can't be caught — its signature is this silence.
  app.on('before-quit', () => console.log('[agentsflow][lifecycle] before-quit'));
  app.on('will-quit', () => console.log('[agentsflow][lifecycle] will-quit'));
  app.on('quit', (_e, code) => console.log(`[agentsflow][lifecycle] quit code=${code}`));

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
      // Installing a handler suppresses Node's default terminate-on-signal, so we
      // must exit ourselves. Run the app's normal teardown (before-quit → quit),
      // with a hard backstop in case quit can't proceed (e.g. loop still wedged).
      console.error(`[agentsflow][signal] received ${sig} — shutting down`);
      try {
        app.quit();
      } catch {
        /* ignore */
      }
      setTimeout(() => process.exit(0), 1500).unref?.();
    });
  }
}
