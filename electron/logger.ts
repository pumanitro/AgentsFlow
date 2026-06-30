import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

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
let stream: fs.WriteStream | null = null;
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
  if (!stream) return;
  try {
    stream.write(`${new Date().toISOString()} [${level}] ${fmt(args)}\n`);
  } catch {
    /* a broken log stream must never take down the app */
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
    try {
      stream = fs.createWriteStream(logFilePath, { flags: 'a' });
    } catch {
      stream = null;
    }
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
}
