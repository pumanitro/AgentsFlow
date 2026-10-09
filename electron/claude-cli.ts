import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withUtf8Locale } from './locale';
import { getRemoteHosts } from './remote/remote-hosts';
import type { AgentRow } from '../shared/remote';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

export interface ClaudeAgentJsonRow {
  pid: number;
  cwd: string;
  kind: string;
  startedAt: number;
  sessionId: string;
  name?: string;
  // Live, real-time signals `claude agents --json` reports (CLI ≥ 2.1.x).
  // `state` is the logical turn state (working | blocked | done | …), carried on
  // background-daemon rows. `status` is the OS process's liveness
  // (busy | idle | waiting) and only exists while a process is actually running
  // — it is the real-time truth and beats a possibly-stale state.json (an
  // interactive `--resume` keeps working but never rewrites its --bg daemon's
  // state.json). `waitingFor` explains a `waiting` status, e.g. "permission
  // prompt".
  state?: string;
  status?: string;
  waitingFor?: string;
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
  // Daemon writes these when a turn ends on AskUserQuestion. `state`/`detail`
  // are sometimes left stale ("working" / "starting…") in that case, so the
  // presence of `block.questions` or `needs` is the authoritative signal.
  needs?: string;
  block?: {
    questions?: { question?: string; options?: { label?: string; description?: string }[] }[];
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
    // GUI-launched Electron inherits no LANG, so claude would run in the C locale
    // and mangle multibyte UTF-8 (Polish chars, accents) in prompts/output.
    withUtf8Locale(env);
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

export type ListAgentsResult =
  | { ok: true; rows: ClaudeAgentJsonRow[] }
  | { ok: false; reason: 'timeout' | 'exit' | 'read' | 'parse' };

let _listAgentsDebugCount = 0;
let _tmpCounter = 0;
let _inFlightListAgents: Promise<ListAgentsResult> | null = null;

// Short freshness cache. The single-flight below already collapses *concurrent*
// callers, but a spawn burst also produces callers a few hundred ms apart — the
// periodic poll tick, each spawn's detached `refreshNow`, and a `term:attach` —
// that would otherwise each launch a fresh `claude agents --json`, and every
// extra spawn inflates the latency of all the others. Serving a very recent
// successful result to callers inside this window collapses those clusters to a
// single spawn. The window is far below both the 5s poll cadence and the 1.2s
// delegation-poll cadence, so neither of those paths ever rides a stale result
// in steady state — only genuine sub-window bursts coalesce. Failures are never
// cached, so a transient CLI choke is always re-attempted immediately.
//
// The 750 ms floor is calibrated for a healthy machine, where the call costs
// ~350 ms. Under a large fleet the same call has been measured at 3-18 s, and a
// freshness window an order of magnitude shorter than the operation it guards
// stops coalescing anything: callers a second apart each launch another spawn,
// and each extra spawn makes all the others slower still. So the window also
// tracks the last observed duration — never re-spawn more often than the call
// itself takes to return. The poll cadence backs off to several times that
// duration (see adaptiveFastTickMs in poller.ts), so no polling path ever ends
// up riding a cached result in steady state.
const LIST_AGENTS_FRESH_MS = Number(process.env.AGENTSFLOW_LIST_AGENTS_FRESH_MS) || 750;
const LIST_AGENTS_FRESH_MAX_MS = 20_000;
let _lastListAgents: { at: number; result: ListAgentsResult } | null = null;
let _lastListAgentsMs = 0;

function listAgentsFreshWindowMs(): number {
  return Math.min(LIST_AGENTS_FRESH_MAX_MS, Math.max(LIST_AGENTS_FRESH_MS, _lastListAgentsMs));
}

/**
 * Some Electron environments truncate the streamed stdout from `claude agents --json`
 * around the OS pipe buffer (~8 KB), producing parse failures. Writing claude's
 * stdout to a temp file via shell redirection and reading the file back avoids
 * the parent-side stream entirely.
 *
 * Concurrent callers (the poller's fallback tick + a user-initiated `term:attach`)
 * share a single in-flight invocation via singleflight; both get the same result
 * instead of racing the temp file. Failed calls return ok:false so callers can
 * distinguish "no agents running" from "the CLI choked" — the poller uses this
 * to avoid mutating state on transient failures.
 */
//
// `host` (a remote peer's hostKey) routes to that host's cached listing instead;
// undefined keeps the local path exactly as it always was.
export function listAgentsResult(host?: string): Promise<ListAgentsResult> {
  if (host) return listRemoteAgentsResult(host);
  if (_inFlightListAgents) return _inFlightListAgents;
  const cached = _lastListAgents;
  if (cached && cached.result.ok && Date.now() - cached.at < listAgentsFreshWindowMs()) {
    return Promise.resolve(cached.result);
  }
  const startedAt = Date.now();
  _inFlightListAgents = runListAgentsOnce()
    .then((result) => {
      _lastListAgentsMs = Date.now() - startedAt;
      // Only remember successful listings; a failed call must not suppress the
      // next real attempt (the poller relies on fresh failures to avoid mutating
      // state on a transient CLI choke).
      if (result.ok) _lastListAgents = { at: Date.now(), result };
      return result;
    })
    .finally(() => { _inFlightListAgents = null; });
  return _inFlightListAgents;
}

// ---------- Remote listing ----------
// A remote host's `claude agents --json` is run by its agent script and pushed
// (or answered) over the host's NDJSON channel; RemoteHosts keeps the latest
// rows. Serving rows up to this old straight from that cache keeps a poll tick
// from costing an ssh round-trip per host per tick — the agent script pushes
// fresh rows on its own cadence, so the cache is normally far younger than this.
const REMOTE_ROWS_FRESH_MS = 10_000;

// Same fields, two declarations (shared/remote.ts must stay dependency-free);
// copying field by field keeps a remote row from smuggling extra keys into
// places that only ever saw the local shape.
function fromAgentRow(r: AgentRow): ClaudeAgentJsonRow {
  const row: ClaudeAgentJsonRow = { pid: r.pid, cwd: r.cwd, kind: r.kind, startedAt: r.startedAt, sessionId: r.sessionId };
  if (r.name !== undefined) row.name = r.name;
  if (r.state !== undefined) row.state = r.state;
  if (r.status !== undefined) row.status = r.status;
  if (r.waitingFor !== undefined) row.waitingFor = r.waitingFor;
  return row;
}

// Every failure collapses to `exit`: the poller only needs to know the listing
// is unknown (so it must not count misses or reap), not why. A host that is not
// connected is exactly that — unknown, not empty.
async function listRemoteAgentsResult(host: string): Promise<ListAgentsResult> {
  const rh = getRemoteHosts();
  if (!rh) return { ok: false, reason: 'exit' };
  try {
    const cached = rh.agentsRows(host);
    if (cached && Date.now() - cached.at <= REMOTE_ROWS_FRESH_MS) {
      return { ok: true, rows: cached.rows.map(fromAgentRow) };
    }
    const rows = await rh.refreshAgents(host);
    return { ok: true, rows: rows.map(fromAgentRow) };
  } catch {
    return { ok: false, reason: 'exit' };
  }
}

// Bypasses the freshness cache. The resolve loops below wait for a session that
// was spawned a moment ago; a cached listing from before the spawn would hide it
// for up to REMOTE_ROWS_FRESH_MS — longer than those loops wait.
async function listRemoteAgentsFresh(host: string): Promise<ClaudeAgentJsonRow[]> {
  const rh = getRemoteHosts();
  if (!rh) return [];
  try {
    return (await rh.refreshAgents(host)).map(fromAgentRow);
  } catch {
    return [];
  }
}

async function runListAgentsOnce(): Promise<ListAgentsResult> {
  const tmpFile = path.join(os.tmpdir(), `agentsflow-list-${process.pid}-${++_tmpCounter}.json`);
  const result = await runCmdToFile(['agents', '--json'], tmpFile, { timeoutMs: 30000 });
  if (result.timedOut) {
    if (_listAgentsDebugCount++ < 3) {
      console.error('[agentsflow][listAgents] TIMED OUT');
    }
    try { fs.unlinkSync(tmpFile); } catch {}
    return { ok: false, reason: 'timeout' };
  }
  if (result.code !== 0) {
    if (_listAgentsDebugCount++ < 3) {
      console.error('[agentsflow][listAgents] non-zero exit', { code: result.code, stderr: result.stderr.slice(0, 200) });
    }
    try { fs.unlinkSync(tmpFile); } catch {}
    return { ok: false, reason: 'exit' };
  }
  let raw = '';
  try { raw = fs.readFileSync(tmpFile, 'utf8'); } catch (e) {
    console.error('[agentsflow][listAgents] failed to read tmp file', tmpFile, (e as Error).message);
    return { ok: false, reason: 'read' };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
  const clean = stripAnsi(raw);
  try {
    const parsed = JSON.parse(clean) as ClaudeAgentJsonRow[];
    if (_listAgentsDebugCount++ < 3) {
      console.log('[agentsflow][listAgents] ok', { agents: parsed.length, bytesRead: raw.length });
    }
    return { ok: true, rows: parsed };
  } catch (e) {
    if (_listAgentsDebugCount++ < 3) {
      console.error('[agentsflow][listAgents] parse failed', {
        err: (e as Error).message,
        rawLen: raw.length,
        lastChars: JSON.stringify(raw.slice(-200)),
      });
    }
    return { ok: false, reason: 'parse' };
  }
}

/**
 * Convenience wrapper that flattens the discriminated result back to a bare
 * rows array — callers that don't care about ok/failed (the polling resolve
 * loops below) can use this. New callers that need to react to transient CLI
 * failures should call `listAgentsResult()` directly.
 */
export async function listAgents(host?: string): Promise<ClaudeAgentJsonRow[]> {
  const r = await listAgentsResult(host);
  return r.ok ? r.rows : [];
}

function runCmdToFile(args: string[], outPath: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    env.PATH = `${process.env.PATH}:${path.join(os.homedir(), '.local/bin')}`;
    env.NO_COLOR = '1';
    delete env.FORCE_COLOR;
    delete env.CLICOLOR_FORCE;
    withUtf8Locale(env);
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

// Remote: answered from the host's cache, never over the wire — this runs on
// the poller's per-conversation hot path and must stay synchronous. The agent
// script pushes every watched job's state.json as it changes.
export function readJobState(daemonShort: string, host?: string): JobState | null {
  if (!daemonShort) return null;
  if (host) return getRemoteHosts()?.jobState(host, daemonShort)?.state ?? null;
  const p = path.join(os.homedir(), '.claude', 'jobs', daemonShort, 'state.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as JobState;
  } catch {
    return null;
  }
}

// When state.json last changed — the reaper's "quiet for how long" signal.
// Exposed so a remote conversation can answer it from the host's cache instead
// of a local stat. 0 = unknown.
export function jobStateMtimeMs(daemonShort: string, host?: string): number {
  if (!daemonShort) return 0;
  if (host) return getRemoteHosts()?.jobState(host, daemonShort)?.mtimeMs ?? 0;
  try {
    return fs.statSync(path.join(os.homedir(), '.claude', 'jobs', daemonShort, 'state.json')).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------- Session cwd from the transcript ----------
// `claude agents --json` only knows about *live* daemons, so once a chat's
// daemon exits its cwd — and with it, which worktree the chat was working in —
// is no longer reported. The transcript keeps it: Claude Code stamps `cwd` on
// every entry and re-homes the file under a project directory slugged from that
// cwd, so the LAST occurrence is the session's final working directory.
//
// The slug is lossy (both `/` and `.` become `-`), so it can't be decoded back
// into a path. We don't need to: the transcript is found by scanning project
// directories for `<sessionId>.jsonl`, and the answer is read from the file's
// own contents rather than inferred from its name.
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

function projectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Locate `<sessionId>.jsonl` across the project dirs. Null if absent. */
function findTranscript(sessionId: string): string | null {
  if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) return null; // never build paths from unvalidated ids
  const root = projectsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const p = path.join(root, ent.name, `${sessionId}.jsonl`);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* unreadable project dir — keep looking */
    }
  }
  return null;
}

/**
 * The working directory a session was last running in, per its transcript.
 * Returns null when there's no transcript or it carries no `cwd`.
 *
 * Reads only the tail: a long transcript runs to many MB and the newest entry
 * is what we want, so pulling the whole file in would be pure waste on a path
 * that runs while the user is opening a chat.
 */
export function readSessionCwdFromTranscript(sessionId: string): string | null {
  const file = findTranscript(sessionId);
  if (!file) return null;
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    // Last match wins — the tail may span several entries.
    const matches = buf.toString('utf8').match(/"cwd":"((?:[^"\\]|\\.)*)"/g);
    if (!matches || matches.length === 0) return null;
    const raw = matches[matches.length - 1];
    const value = raw.slice('"cwd":"'.length, -1);
    // The field is JSON-escaped (Windows separators, quotes in odd dir names).
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

export async function dispatchBackground(opts: {
  cwd: string;
  prompt: string;
  // Path to the AgentsFlow `--mcp-config` JSON (adds the sibling-agent /
  // delegate tools). Merged with the target dir's own MCP config.
  mcpConfigPath?: string;
  // Registry snapshot appended to the session's system prompt at boot.
  appendSystemPrompt?: string;
  // Model alias/name for `claude --model` (e.g. 'fable', 'opus', 'sonnet').
  // Omitted ⇒ the CLI falls back to the user's configured default model.
  model?: string;
  // hostKey of a remote peer to spawn on; undefined = this machine.
  host?: string;
}): Promise<{ daemonShort: string | null; raw: string; code: number | null }> {
  if (opts.host) return dispatchRemote({ ...opts, host: opts.host });
  // The prompt must stay the final positional argument.
  const args = ['--bg', '--permission-mode', 'bypassPermissions'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath);
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  args.push(opts.prompt);
  // The prompt itself never goes to the log. A handover seeds a session with a
  // condensed transcript — up to 12 k characters — and one line per spawn of
  // that is how an unrotated main.log has frozen this app before (see the
  // log-storm incident). Its length is the part worth keeping.
  console.log('[agentsflow][dispatch] invoking claude', {
    bin: CLAUDE_BIN,
    cwd: opts.cwd,
    args: args.slice(0, -1),
    promptChars: opts.prompt.length,
  });
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
  return { daemonShort: m ? m[1] : null, raw: combined, code };
}

// The remote twin of the spawn above. The prompt travels inside the host's
// NDJSON channel as data (never through a remote shell), and the agent script
// runs `claude --bg <args...> <prompt>` — so `args` is the local argv minus
// `--bg` and the prompt, in the same order.
async function dispatchRemote(opts: {
  cwd: string; prompt: string; mcpConfigPath?: string; appendSystemPrompt?: string; model?: string; host: string;
}): Promise<{ daemonShort: string | null; raw: string; code: number | null }> {
  const args = ['--permission-mode', 'bypassPermissions'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath);
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  // Same log-storm rule as the local path: prompt length, never the prompt.
  // The system prompt is multi-KB registry text, so it is elided too.
  console.log('[agentsflow][dispatch] invoking claude on remote host', {
    host: opts.host,
    cwd: opts.cwd,
    args: args.map((a, i) => (args[i - 1] === '--append-system-prompt' ? `<${a.length} chars>` : a)),
    promptChars: opts.prompt.length,
  });
  const rh = getRemoteHosts();
  if (!rh) {
    console.error('[agentsflow][dispatch] remote hosts not started', { host: opts.host });
    return { daemonShort: null, raw: `remote hosts not started (host ${opts.host})`, code: -1 };
  }
  try {
    const r = await rh.spawn(opts.host, { cwd: opts.cwd, prompt: opts.prompt, args });
    console.log('[agentsflow][dispatch] remote result', { host: opts.host, code: r.code, daemonShort: r.daemonShort, rawLen: r.raw.length });
    return { daemonShort: r.daemonShort, raw: r.raw, code: r.code };
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    console.error('[agentsflow][dispatch] remote spawn failed', { host: opts.host, error: message });
    return { daemonShort: null, raw: message, code: -1 };
  }
}

export async function resolveSessionByDaemonShort(daemonShort: string, maxWaitMs = 8000, host?: string): Promise<ClaudeAgentJsonRow | null> {
  if (!daemonShort) return null;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const rows = host ? await listRemoteAgentsFresh(host) : await listAgents();
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
  host?: string;
}): Promise<ClaudeAgentJsonRow | null> {
  const start = Date.now();
  const max = opts.maxWaitMs ?? 8000;
  while (Date.now() - start < max) {
    const rows = opts.host ? await listRemoteAgentsFresh(opts.host) : await listAgents();
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

/**
 * Returns true if there's a running background/interactive daemon whose
 * sessionId either equals or starts with `sessionIdOrShort`. Used by
 * `term:attach` to decide between `claude attach` (live daemon) and
 * `claude --resume` (cold transcript on disk).
 *
 * Fail-open: when `listAgents` itself fails (timeout, parse error, etc.) we
 * return `true` so the attach path defaults to `claude attach`. Routing a
 * live session through `--resume` can fork the transcript, while attaching
 * to a dead session merely fails fast with a visible CLI error — so when in
 * doubt, prefer attach.
 */
export async function hasLiveDaemon(sessionIdOrShort: string, host?: string): Promise<boolean> {
  if (!sessionIdOrShort) return false;
  const matches = (rows: ClaudeAgentJsonRow[]) =>
    rows.some((row) => row.sessionId === sessionIdOrShort || row.sessionId.startsWith(sessionIdOrShort));
  const r = await listAgentsResult(host);
  if (!r.ok) return true;
  if (matches(r.rows)) return true;
  if (!host) return false;
  // A remote "no" may come from a cached listing up to 10 s old — older than a
  // session that was just spawned. Answering "dead" sends attach down the
  // --resume path, which can fork a live transcript, so confirm a miss against
  // a fresh listing; a failed refresh fails open like any other failure.
  const rh = getRemoteHosts();
  if (!rh) return true;
  try {
    return matches((await rh.refreshAgents(host)).map(fromAgentRow));
  } catch {
    return true;
  }
}

// Remote stop/rm go through the host's channel. Errors are swallowed exactly
// like the local path ignores `claude stop`'s exit code: both are best-effort
// and the reaper retries on its own backoff.
export async function stopAgent(daemonShort: string, host?: string): Promise<void> {
  if (!daemonShort) return;
  if (host) {
    try { await getRemoteHosts()?.stopJob(host, daemonShort); } catch { /* best-effort */ }
    return;
  }
  await runCmd(['stop', daemonShort], { timeoutMs: 5000 });
}

export async function removeAgent(daemonShort: string, host?: string): Promise<void> {
  if (!daemonShort) return;
  if (host) {
    try { await getRemoteHosts()?.rmJob(host, daemonShort); } catch { /* best-effort */ }
    return;
  }
  await runCmd(['rm', daemonShort], { timeoutMs: 5000 });
}
