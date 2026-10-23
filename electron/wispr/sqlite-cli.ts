// Every byte the learner reads from or writes to Wispr's flow.sqlite goes through the
// system sqlite3 CLI. No native module: better-sqlite3 would have to be rebuilt per
// Electron ABI and unpacked from the asar, and the macOS binary is always there.
//
// The DB is in WAL mode and open by the running Wispr app, so both paths set a busy
// timeout (`.timeout 5000`) instead of failing on the first SQLITE_BUSY, and writes
// run under `-bail` inside `BEGIN IMMEDIATE … COMMIT`: a failing statement stops the
// script before COMMIT and the process exit rolls the whole transaction back.

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';

export const SQLITE3_BIN = '/usr/bin/sqlite3';

export interface SqliteCli {
  readonly dbPath: string;
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  exec(script: string): Promise<string>;
}

const MAX_BUFFER = 64 * 1024 * 1024;

export function createSqliteCli(opts: { dbPath: string; bin?: string; timeoutMs?: number }): SqliteCli {
  const { dbPath } = opts;
  const bin = opts.bin ?? SQLITE3_BIN;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return {
    dbPath,

    query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      const run = (args: string[], retryCantOpen: boolean) => new Promise<T[]>((resolve, reject) => {
        execFile(
          bin,
          args,
          { maxBuffer: MAX_BUFFER, timeout: timeoutMs, encoding: 'utf8' },
          (err, stdout, stderr) => {
            if (err) {
              // A WAL database whose -shm file is gone (the last writer closed cleanly, e.g.
              // Wispr is not running) cannot be opened with -readonly at all: SQLITE_CANTOPEN
              // (exit 14), because a read-only connection may not create the -shm. Retry as
              // a read-write connection that refuses writes; it recreates -shm/-wal, exactly
              // what Wispr itself does on open, and leaves the data untouched.
              const code: unknown = (err as { code?: unknown }).code;
              if (retryCantOpen && code === 14 && !fs.existsSync(`${dbPath}-shm`)) {
                run(['-batch', '-json', '-cmd', '.timeout 5000', '-cmd', 'PRAGMA query_only=1', dbPath, sql], false).then(resolve, reject);
                return;
              }
              reject(new Error(`sqlite3 query failed: ${(stderr || err.message).trim()}`));
              return;
            }
            // `-json` prints nothing at all for an empty result set.
            const text = stdout.trim();
            if (!text) { resolve([]); return; }
            try {
              resolve(JSON.parse(text) as T[]);
            } catch (e) {
              reject(new Error(`sqlite3 query returned non-JSON output: ${(e as Error).message}`));
            }
          },
        );
      });
      return run(['-readonly', '-batch', '-json', '-cmd', '.timeout 5000', dbPath, sql], true);
    },

    exec(script: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const child = spawn(bin, ['-batch', '-bail', dbPath], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(() => reject(new Error(`sqlite3 exec timed out after ${timeoutMs} ms`)));
        }, timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d: string) => { stdout += d; });
        child.stderr.on('data', (d: string) => { stderr += d; });
        child.on('error', (err) => finish(() => reject(err)));
        child.on('close', (code) => {
          finish(() => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`sqlite3 exec failed (exit ${code}): ${stderr.trim()}`));
          });
        });
        // An EPIPE from a child that already died is reported through 'close' instead.
        child.stdin.on('error', () => {});
        child.stdin.end(`.timeout 5000\n${script}\n`);
      });
    },
  };
}

/** One SQL literal. Strings are single-quoted with quotes doubled; NUL can't round-trip, so it throws. */
export function sqlLit(v: string | number | boolean | null): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`sqlLit: non-finite number ${v}`);
    return String(v);
  }
  if (v.includes('\0')) throw new Error('sqlLit: string contains NUL');
  return `'${v.replace(/'/g, "''")}'`;
}
