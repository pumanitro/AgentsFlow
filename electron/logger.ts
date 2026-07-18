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

// Wall-clock timestamp of the last OS power/visibility transition that legitimately
// stops the event loop from ticking (system sleep, and — where observable — App Nap
// while the window sits occluded on another Space). main.ts feeds these in via
// notePowerSuspend/Resume once `powerMonitor` is available (it isn't at the very
// early point installCrashLogging() runs). The stall detector uses it to avoid
// misreporting an OS-parked process as a frozen UI. See the detector below.
let lastPowerSuspendAt = 0;
let lastPowerResumeAt = 0;
/** Called by main when the OS is about to suspend the app (screen lock / sleep). */
export function notePowerSuspend(): void { lastPowerSuspendAt = Date.now(); }
/** Called by main when the OS resumes the app from suspension. */
export function notePowerResume(): void { lastPowerResumeAt = Date.now(); }

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

// ---------- Health heartbeat ----------
// The log is event-driven, so an idle app writes nothing — and "wrote nothing"
// is indistinguishable from "was dead" after the fact. That ambiguity is what
// made the 2026-07-18 termination unattributable: the last line was ~2 minutes
// before the process actually exited, and nothing in the log could say whether
// those 2 minutes were a healthy idle or a wedged main thread. A fixed-cadence
// line removes the ambiguity in both directions:
//   • its presence up to the exit proves the app was alive and pumping, so the
//     exit was external (a signal) rather than a freeze;
//   • its absence pins the freeze to a known window.
// It also trends the resources whose exhaustion has historically aborted us
// (PTYs, fds, RSS), so a slow leak is visible in the log *before* it crashes.
const HEARTBEAT_MS = Number(process.env.AGENTSFLOW_HEARTBEAT_MS) || 60_000;
type HealthProbe = () => Record<string, unknown>;
let healthProbe: HealthProbe | null = null;

/**
 * Register the subsystem-stats provider merged into each heartbeat line. Kept
 * as a callback so this module stays dependency-free (it is imported before
 * almost everything else, including anything that touches `app`).
 */
export function registerHealthProbe(fn: HealthProbe): void {
  healthProbe = fn;
}

function heartbeat(): void {
  const mem = process.memoryUsage();
  const fields: Record<string, unknown> = {
    uptimeS: Math.round(process.uptime()),
    rssMB: Math.round(mem.rss / 1024 / 1024),
    heapMB: Math.round(mem.heapUsed / 1024 / 1024),
  };
  if (healthProbe) {
    try {
      Object.assign(fields, healthProbe());
    } catch (err) {
      fields.probeError = (err as Error)?.message ?? String(err);
    }
  }
  console.log('[agentsflow][health]', fields);
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
  // Above this, a "stall" is almost certainly the OS having *parked* the whole
  // process (system sleep / display sleep / App Nap while occluded on another
  // Space), not the JS event loop being wedged. The detector measures Date.now()
  // drift, which can't by itself tell "busy for N seconds" from "suspended for N
  // seconds" — but a genuine main-thread block that long isn't survivable (macOS
  // shows the beach-ball and the user force-quits), whereas the process here kept
  // running fine afterwards. Real pathological blocks this detector was built for
  // (the original ~43s freeze) sit comfortably under this ceiling, so they still
  // report as freezes; multi-minute "stalls" get reclassified as power events.
  const SUSPEND_LIKELY_MS = 60_000;
  let lastTick = Date.now();
  const loopMon = setInterval(() => {
    const now = Date.now();
    const stall = now - lastTick - LOOP_TICK_MS;
    if (stall > LOOP_STALL_THRESHOLD_MS) {
      // A power transition (from powerMonitor) or a stall past the ceiling means
      // the process was parked by the OS, not frozen. Either boundary catches it:
      // powerMonitor fires for real system sleep; the size ceiling catches App
      // Nap / occlusion throttling, which does NOT fire powerMonitor.
      const bracketsResume =
        (lastPowerSuspendAt && lastPowerSuspendAt >= lastTick) ||
        (lastPowerResumeAt && now - lastPowerResumeAt <= LOOP_TICK_MS * 2);
      if (stall > SUSPEND_LIKELY_MS || bracketsResume) {
        console.warn(
          `[agentsflow][power] process resumed after ~${Math.round(stall / 1000)}s parked by the OS ` +
            `(sleep / App Nap while backgrounded) — not a real UI freeze`,
        );
      } else {
        // Append the recent slow-op history so a freeze can be attributed to the
        // operation that caused it, instead of just recording that one happened.
        console.error(`[agentsflow][stall] main event loop blocked for ~${Math.round(stall)}ms — the UI was frozen${recentSlowOpsSummary()}`);
      }
    }
    lastTick = now;
  }, LOOP_TICK_MS);
  loopMon.unref?.();

  // Emit one immediately so a short-lived run (e.g. a second instance that
  // exits on the single-instance lock) still records its resource baseline.
  heartbeat();
  const beat = setInterval(heartbeat, HEARTBEAT_MS);
  beat.unref?.();

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
