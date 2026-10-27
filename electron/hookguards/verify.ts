// Checking one installed guard: its entry must exist and be executable, then
// its selftest (`bash <installDir>/<selftest>`, cwd = installDir) must exit 0;
// a guard without a selftest gets a syntax check instead.
//
// Every command goes through an async exec with a timeout — never a sync child
// process (a synchronous probe has frozen this app's main thread before).

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { HookGuardSpec } from './manifest';

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }
export type Exec = (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;

export const SELFTEST_TIMEOUT_MS = 120_000;
const SYNTAX_TIMEOUT_MS = 15_000;
const DETAIL_MAX = 300;

/** Async execFile resolved (never rejected) into an ExecResult; timedOut = killed by the timeout. */
export const defaultExec: Exec = (cmd, args, o) =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { cwd: o.cwd, env: o.env, timeout: o.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null }) | null;
        const timedOut = !!e && !!e.killed && e.signal === 'SIGTERM';
        let code = 0;
        if (e) code = typeof e.code === 'number' ? e.code : e.code === 'ENOENT' ? 127 : 1;
        const errText = e && typeof e.code !== 'number' && !timedOut ? `${e.message}\n` : '';
        resolve({ code, stdout: String(stdout ?? ''), stderr: errText + String(stderr ?? ''), timedOut });
      });
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false });
    }
  });

/** The last 3 non-empty lines of stdout + stderr, at most 300 chars. */
export function tailDetail(stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = lines.slice(-3).join('\n');
  return out.length > DETAIL_MAX ? out.slice(out.length - DETAIL_MAX) : out;
}

export async function verifyGuard(spec: HookGuardSpec, installDir: string, exec: Exec, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail: string; ms: number }> {
  const started = Date.now();
  const done = (ok: boolean, detail: string) => ({ ok, detail, ms: Date.now() - started });
  const entry = path.join(installDir, spec.files[0]);
  try {
    fs.accessSync(entry, fs.constants.X_OK);
  } catch {
    return done(false, fs.existsSync(entry) ? `${spec.files[0]} is not executable` : `${spec.files[0]} is missing`);
  }

  let cmd: string;
  let args: string[];
  let timeoutMs = SYNTAX_TIMEOUT_MS;
  if (spec.selftest) {
    cmd = 'bash';
    args = [path.join(installDir, spec.selftest)];
    timeoutMs = SELFTEST_TIMEOUT_MS;
  } else if (spec.syntaxCheck === 'python') {
    cmd = 'python3';
    args = ['-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', entry];
  } else if (spec.syntaxCheck === 'bash') {
    cmd = 'bash';
    args = ['-n', entry];
  } else {
    return done(true, '');
  }

  const r = await exec(cmd, args, { cwd: installDir, env, timeoutMs });
  if (r.timedOut) return done(false, `timed out after ${Math.round(timeoutMs / 1000)}s${tailDetail(r.stdout, r.stderr) ? `\n${tailDetail(r.stdout, r.stderr)}` : ''}`);
  const detail = tailDetail(r.stdout, r.stderr);
  if (r.code !== 0) return done(false, detail || `exit ${r.code}`);
  return done(true, detail);
}
