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

// ---------- Bounding the write volume ----------
// Every console.* call lands here as a *synchronous* appendFileSync (see
// rawWrite). That is the right trade at control-plane volume, but it stops
// being control-plane the instant something starts failing in a loop, and then
// the logger itself becomes the outage: on 2026-07-23 parcel's watcher emitted
// "Events were dropped by the FSEvents client" hundreds of times a minute while
// the perf tracer emitted a SLOW line per degraded git spawn (47k of them in one
// log), so the main thread sat in write(2) against a 17 MB file that nothing
// ever rotated — the UI froze and the app had to be killed. Two bounds fix that
// without giving up the signal:
//
//   • Repeat collapsing. Lines of the same *shape* (digits normalised out, so
//     "SLOW git:worktrees 1901ms" and "…1893ms" share a key) are written a few
//     times, then suppressed and counted; the tally flushes as one
//     "repeated ×N" line. A storm costs O(1) writes instead of O(N).
//   • Size rotation. A rename at MAX_LOG_BYTES keeps the active file small
//     enough that appends stay cheap, and keeps one previous generation. The
//     comment at the top of this file has always claimed the log was
//     "rotating-ish"; it was not, and 17 MB is what that cost.
//
// Lines that explain a termination bypass collapsing entirely — those must
// never be traded away for throughput.
const MAX_LOG_BYTES = Number(process.env.AGENTSFLOW_MAX_LOG_BYTES) || 8 * 1024 * 1024;
const REPEAT_BURST = 3;             // identical-shaped lines written before suppression starts
const REPEAT_WINDOW_MS = 10_000;    // how long a suppressed key keeps accumulating
const REPEAT_KEY_CAP = 500;         // hard bound on the tracking map
const NEVER_COLLAPSE = /\[(fatal|stall|signal|lifecycle|power|health)\]/;

let bytesWritten = 0;

function stamp(level: string, msg: string): string {
  return `${new Date().toISOString()} [${level}] ${msg}\n`;
}

function rotateIfNeeded(): void {
  if (bytesWritten < MAX_LOG_BYTES) return;
  try {
    fs.renameSync(logFilePath, `${logFilePath}.1`);
    bytesWritten = 0;
  } catch {
    // Rotation failing must not stop logging — keep appending to the current
    // file, and don't retry on every line.
    bytesWritten = 0;
  }
}

function rawWrite(line: string): void {
  try {
    // Synchronous append — NOT an async WriteStream. The stream buffered writes
    // and silently dropped the last lines when the process exited fast (a quit,
    // a signal-driven teardown, a force-exit) — which is exactly when the
    // before-quit / [signal] / [fatal] / [stall] lines matter most. (Observed:
    // a clean quit whose `before-quit` never reached disk, making a normal
    // restart look like a traceless crash.) appendFileSync guarantees the line
    // is on disk before we return, so the log can be trusted to explain an exit.
    fs.appendFileSync(logFilePath, line);
    bytesWritten += Buffer.byteLength(line);
    rotateIfNeeded();
  } catch {
    /* a broken log file must never take down the app */
  }
}

/** Digits collapse to '#' so numerically-varying repeats share one key. */
export function repeatKey(level: string, msg: string): string {
  return `${level}:${msg.replace(/\d+/g, '#')}`;
}

interface RepeatState { count: number; windowStart: number; lastMsg: string; level: string }

/** A tally line emitted for a key whose repeats were suppressed. */
export interface RepeatTally { level: string; msg: string }

/**
 * Decides, per line, whether it should hit the disk or be folded into a running
 * tally. Kept as a self-contained factory with an injected clock so the policy
 * is testable without touching the filesystem or the real `Date.now`.
 */
export function createRepeatCollapser(opts: { burst: number; windowMs: number; keyCap: number }) {
  const repeats = new Map<string, RepeatState>();

  function tally(key: string, st: RepeatState, now: number): RepeatTally | null {
    repeats.delete(key);
    const suppressed = st.count - opts.burst;
    if (suppressed <= 0) return null;
    const secs = Math.round((now - st.windowStart) / 1000);
    return { level: st.level, msg: `[agentsflow][log] repeated ×${suppressed} more in ${secs}s: ${st.lastMsg}` };
  }

  return {
    /**
     * Returns whether to write `msg`, plus any tallies that fell due as a result.
     * Tallies must be written *before* the line itself to keep the log ordered.
     */
    record(level: string, msg: string, now: number): { write: boolean; tallies: RepeatTally[] } {
      const key = repeatKey(level, msg);
      const st = repeats.get(key);
      const tallies: RepeatTally[] = [];

      if (!st || now - st.windowStart >= opts.windowMs) {
        if (st) {
          const t = tally(key, st, now);
          if (t) tallies.push(t);
        }
        // Bound the map: a pathological spread of unique keys must not grow it
        // without limit. Draining everything is correct — worst case a few
        // tallies land early.
        if (repeats.size >= opts.keyCap) {
          for (const [k, s] of Array.from(repeats.entries())) {
            const t = tally(k, s, now);
            if (t) tallies.push(t);
          }
        }
        repeats.set(key, { count: 1, windowStart: now, lastMsg: msg, level });
        return { write: true, tallies };
      }

      st.count++;
      st.lastMsg = msg;
      // Past the burst the line is suppressed but still counted; the tally lands
      // on flush.
      return { write: st.count <= opts.burst, tallies };
    },

    /** Tallies for keys whose window has closed. */
    flushExpired(now: number): RepeatTally[] {
      const out: RepeatTally[] = [];
      for (const [key, st] of Array.from(repeats.entries())) {
        if (now - st.windowStart < opts.windowMs) continue;
        const t = tally(key, st, now);
        if (t) out.push(t);
      }
      return out;
    },

    /** Drain every pending tally regardless of window — used on the way out. */
    flushAll(now: number): RepeatTally[] {
      const out: RepeatTally[] = [];
      for (const [key, st] of Array.from(repeats.entries())) {
        const t = tally(key, st, now);
        if (t) out.push(t);
      }
      return out;
    },
  };
}

const collapser = createRepeatCollapser({
  burst: REPEAT_BURST,
  windowMs: REPEAT_WINDOW_MS,
  keyCap: REPEAT_KEY_CAP,
});

function writeTallies(tallies: RepeatTally[]): void {
  for (const t of tallies) rawWrite(stamp(t.level, t.msg));
}

function flushExpiredRepeats(): void {
  writeTallies(collapser.flushExpired(Date.now()));
}

function flushAllRepeats(): void {
  writeTallies(collapser.flushAll(Date.now()));
}

function writeLine(level: string, args: unknown[]): void {
  if (!logFilePath) return;
  const msg = fmt(args);

  // Termination-attribution lines are always written verbatim, immediately.
  if (NEVER_COLLAPSE.test(msg)) {
    rawWrite(stamp(level, msg));
    return;
  }

  const { write, tallies } = collapser.record(level, msg, Date.now());
  writeTallies(tallies);
  if (write) rawWrite(stamp(level, msg));
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

// Running tally of main-thread stalls this process has recorded, so the live
// Performance panel can show "N stalls, last one 2m ago (5.4s)" without
// scraping the log.
let stallCount = 0;
let lastStallAt: string | null = null;
let lastStallMs = 0;
export function getStallStats(): { count: number; lastAt: string | null; lastMs: number } {
  return { count: stallCount, lastAt: lastStallAt, lastMs: lastStallMs };
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
    // Seed the size counter from the file already on disk, so a log that grew
    // large across previous runs rotates on the next write rather than only
    // once *this* run has itself written MAX_LOG_BYTES.
    try { bytesWritten = fs.statSync(logFilePath).size; } catch { bytesWritten = 0; }
  }

  // Drain suppressed repeat tallies on a fixed cadence, so a storm that is still
  // in progress is visible in the log rather than only after it stops.
  const repeatFlusher = setInterval(flushExpiredRepeats, REPEAT_WINDOW_MS);
  repeatFlusher.unref?.();

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
        stallCount += 1;
        lastStallAt = new Date(now).toISOString();
        lastStallMs = Math.round(stall);
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
  // Flush pending tallies first: a storm that was still being suppressed when
  // the app went down is exactly the storm worth having in the log.
  app.on('before-quit', () => {
    flushAllRepeats();
    console.log('[agentsflow][lifecycle] before-quit');
  });
  app.on('will-quit', () => console.log('[agentsflow][lifecycle] will-quit'));
  app.on('quit', (_e, code) => console.log(`[agentsflow][lifecycle] quit code=${code}`));

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
      // Installing a handler suppresses Node's default terminate-on-signal, so we
      // must exit ourselves. Run the app's normal teardown (before-quit → quit),
      // with a hard backstop in case quit can't proceed (e.g. loop still wedged).
      flushAllRepeats();
      console.error(`[agentsflow][signal] received ${sig} — shutting down`);
      try {
        app.quit();
      } catch {
        /* ignore */
      }
      setTimeout(() => process.exit(0), 1500).unref?.();
    });
  }

  // A voluntary exit (exit()/app.exit()) still runs 'exit' listeners even when
  // the quit lifecycle above was cut short; a kill by signal runs nothing. This
  // line therefore separates "the app chose to exit" from "something killed it"
  // — the distinction the 2026-08-20 incident report could not make (both quits
  // that day show before-quit and then silence). Only synchronous work is legal
  // in an 'exit' listener, which rawWrite is.
  process.on('exit', (code) => {
    rawWrite(stamp('INFO', `[agentsflow][lifecycle] process exit code=${code}`));
  });

  // Orphan watch. Launched from a terminal (`npm run dev`), the app's parent is
  // the electron CLI wrapper. If that stack dies without signalling us (the
  // 2026-08-20 incident: concurrently/next died, tree-kill never reached the
  // GUI binary), the app silently reparents to launchd (ppid 1) and lives on as
  // a zombie wired to a dead dev server — the window then white-screens on its
  // next load with no trace anywhere. Packaged launches start with ppid 1, so
  // the watch disarms itself there.
  if (process.ppid !== 1) {
    const orphanMon = setInterval(() => {
      if (process.ppid !== 1) return;
      clearInterval(orphanMon);
      console.error(
        '[agentsflow][lifecycle] parent process died — the app is now orphaned. ' +
          'If it was started by `npm run dev`, the dev server on :3030 is gone and ' +
          'the window will show the reconnect page on its next load.',
      );
    }, 5000);
    orphanMon.unref?.();
  }
}
