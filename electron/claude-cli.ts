import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

interface ClaudeAgentJsonRow {
  pid: number;
  cwd: string;
  kind: string;
  startedAt: number;
  sessionId: string;
  name?: string;
  status?: string;
}

export interface JobState {
  state?: string;
  detail?: string;
  tempo?: string;
  output?: { result?: string };
  intent?: string;
  name?: string;
  nameSource?: string;
  sessionId?: string;
  daemonShort?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  inFlight?: {
    tasks?: number;
    queued?: number;
    kinds?: string[];
  };
}

// Strip ANSI escape sequences. Claude emits colorized output when FORCE_COLOR is set
// (which npm sets for child processes), so we can't trust raw stdout to be plain text.
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean }
function runCmd(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    env.PATH = `${process.env.PATH}:${path.join(os.homedir(), '.local/bin')}`;
    // Belt-and-suspenders: ask child to not colorize. We still stripAnsi() the result
    // because not every CLI honors these.
    env.NO_COLOR = '1';
    delete env.FORCE_COLOR;
    delete env.CLICOLOR_FORCE;
    const child = spawn(CLAUDE_BIN, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout!.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr!.on('data', (d: Buffer) => stderrChunks.push(d));
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeoutMs) : null;
    const finish = (code: number) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on('close', (code) => finish(code ?? -1));
    child.on('error', () => finish(-1));
  });
}

let _listAgentsDebugCount = 0;
/**
 * Some Electron environments truncate the streamed stdout from `claude agents --json`
 * around the OS pipe buffer (~8 KB), producing parse failures. Writing claude's
 * stdout to a temp file via shell redirection and reading the file back avoids
 * the parent-side stream entirely.
 */
export async function listAgents(): Promise<ClaudeAgentJsonRow[]> {
  const tmpFile = path.join(os.tmpdir(), `agentsflow-list-${process.pid}.json`);
  const result = await runCmdToFile(['agents', '--json'], tmpFile, { timeoutMs: 30000 });
  if (result.timedOut) {
    if (_listAgentsDebugCount++ < 3) {
      console.error('[agentsflow][listAgents] TIMED OUT');
    }
    return [];
  }
  if (result.code !== 0) {
    if (_listAgentsDebugCount++ < 3) {
      console.error('[agentsflow][listAgents] non-zero exit', { code: result.code, stderr: result.stderr.slice(0, 200) });
    }
    return [];
  }
  let raw = '';
  try { raw = fs.readFileSync(tmpFile, 'utf8'); } catch (e) {
    console.error('[agentsflow][listAgents] failed to read tmp file', tmpFile, (e as Error).message);
    return [];
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
  const clean = stripAnsi(raw);
  try {
    const parsed = JSON.parse(clean) as ClaudeAgentJsonRow[];
    if (_listAgentsDebugCount++ < 3) {
      console.log('[agentsflow][listAgents] ok', { agents: parsed.length, bytesRead: raw.length });
    }
    return parsed;
  } catch (e) {
    if (_listAgentsDebugCount++ < 3) {
      console.error('[agentsflow][listAgents] parse failed', {
        err: (e as Error).message,
        rawLen: raw.length,
        lastChars: JSON.stringify(raw.slice(-200)),
      });
    }
    return [];
  }
}

function runCmdToFile(args: string[], outPath: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    env.PATH = `${process.env.PATH}:${path.join(os.homedir(), '.local/bin')}`;
    env.NO_COLOR = '1';
    delete env.FORCE_COLOR;
    delete env.CLICOLOR_FORCE;
    const out = fs.openSync(outPath, 'w');
    const child = spawn(CLAUDE_BIN, args, { cwd: opts.cwd, env, stdio: ['ignore', out, 'pipe'] });
    fs.closeSync(out);
    const stderrChunks: Buffer[] = [];
    child.stderr!.on('data', (d: Buffer) => stderrChunks.push(d));
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeoutMs) : null;
    const finish = (code: number) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stderr: Buffer.concat(stderrChunks).toString('utf8'), timedOut });
    };
    child.on('close', (code) => finish(code ?? -1));
    child.on('error', () => finish(-1));
  });
}

export function readJobState(daemonShort: string): JobState | null {
  if (!daemonShort) return null;
  const p = path.join(os.homedir(), '.claude', 'jobs', daemonShort, 'state.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as JobState;
  } catch {
    return null;
  }
}

export async function dispatchBackground(opts: {
  cwd: string;
  prompt: string;
}): Promise<{ daemonShort: string | null; raw: string }> {
  const args = ['--bg', '--permission-mode', 'bypassPermissions', opts.prompt];
  console.log('[agentsflow][dispatch] invoking claude', { bin: CLAUDE_BIN, cwd: opts.cwd, args });
  const { code, stdout, stderr } = await runCmd(args, { cwd: opts.cwd, timeoutMs: 15000 });
  const cleanStdout = stripAnsi(stdout);
  const cleanStderr = stripAnsi(stderr);
  console.log('[agentsflow][dispatch] result', {
    code,
    stdoutLen: stdout.length,
    stderrLen: stderr.length,
    stdoutSample: cleanStdout.slice(0, 300),
    stderrSample: cleanStderr.slice(0, 300),
  });
  const combined = cleanStdout + '\n' + cleanStderr;
  const m = combined.match(/backgrounded\s*·\s*([0-9a-f]{6,12})/i);
  if (!m) {
    console.error('[agentsflow][dispatch] could not parse daemonShort from output. raw:', combined);
  }
  return { daemonShort: m ? m[1] : null, raw: combined };
}

export async function resolveSessionByDaemonShort(daemonShort: string, maxWaitMs = 8000): Promise<ClaudeAgentJsonRow | null> {
  if (!daemonShort) return null;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const rows = await listAgents();
    const match = rows.find((r) => r.sessionId.startsWith(daemonShort));
    if (match) return match;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * Fallback used when `dispatchBackground` couldn't parse a daemonShort from stdout:
 * look for the most recently started session in the given cwd that wasn't running
 * before our dispatch began. Filters by sessionIds we haven't already claimed.
 */
export async function resolveLatestSessionInCwd(opts: {
  cwd: string;
  startedAfterMs: number;
  excludeSessionIds: Set<string>;
  maxWaitMs?: number;
}): Promise<ClaudeAgentJsonRow | null> {
  const start = Date.now();
  const max = opts.maxWaitMs ?? 8000;
  while (Date.now() - start < max) {
    const rows = await listAgents();
    const candidates = rows
      .filter((r) => r.cwd === opts.cwd)
      .filter((r) => r.startedAt >= opts.startedAfterMs - 1000)
      .filter((r) => !opts.excludeSessionIds.has(r.sessionId))
      .sort((a, b) => b.startedAt - a.startedAt);
    if (candidates.length > 0) return candidates[0];
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export async function stopAgent(daemonShort: string): Promise<void> {
  if (!daemonShort) return;
  await runCmd(['stop', daemonShort], { timeoutMs: 5000 });
}

export async function removeAgent(daemonShort: string): Promise<void> {
  if (!daemonShort) return;
  await runCmd(['rm', daemonShort], { timeoutMs: 5000 });
}
