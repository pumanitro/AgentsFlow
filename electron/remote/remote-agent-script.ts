// The agent script Peers Flow runs on a remote peer's machine, over one
// long-lived `ssh … node remote-agent-script.js` channel. Commands arrive as
// NDJSON on stdin, events leave as NDJSON on stdout (see shared/remote.ts).
//
// It is copied to the host as a single file and run by whatever `node` lives
// there, so: Node built-ins only, and `import type` only from shared/* — a
// value import would compile to a require() of a file that is not shipped.
// stdout carries events and nothing else; anything diagnostic goes to stderr.
//
// Much of this mirrors a local module of the app (claude-cli, git, search,
// workspace-trust, the skills reader in main.ts). The logic is COPIED, not
// imported, for the same single-file reason; keep the copies in step.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type {
  AgentCommand, AgentEvent, AgentRow, JobStateJson, REMOTE_PROTOCOL_VERSION, StatResult, TranscriptRecord,
} from '../../shared/remote';
import type {
  FileEntry, GitEntry, GitEntryStatus, GitStatusResult, RemotePeerCache, RemotePeerSkill,
  SearchFileResult, SearchMatchLine, SearchResult, SlashCommand,
} from '../../shared/types';

// Mirrors REMOTE_PROTOCOL_VERSION; the type annotation makes tsc fail if they drift.
const PROTOCOL: typeof REMOTE_PROTOCOL_VERSION = 1;

const HOME = os.homedir();
const CLAUDE_BIN = process.env.PEERSFLOW_CLAUDE_BIN || 'claude';
const CLAUDE_HOME = process.env.PEERSFLOW_CLAUDE_HOME || path.join(HOME, '.claude');
const CLAUDE_CONFIG = process.env.PEERSFLOW_CLAUDE_CONFIG || path.join(HOME, '.claude.json');

function log(...args: unknown[]): void {
  // stderr only: stdout is the event channel and a stray line would be misparsed.
  console.error('[peersflow][agent]', ...args);
}

function emit(ev: AgentEvent): void {
  process.stdout.write(JSON.stringify(ev) + '\n');
}

// ---- child processes --------------------------------------------------------

// Claude colours its output when FORCE_COLOR leaks in from the ssh environment;
// NO_COLOR asks it not to, and the strip below catches whatever slips through.
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  // sshd's non-login env may carry no locale; claude then mangles non-ASCII
  // prompts. The bootstrap normally sets LANG; this is only the fallback.
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'en_US.UTF-8';
  return env;
}

interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean }
interface RunOpts { cwd?: string; timeoutMs?: number; stdoutFile?: string; maxBytes?: number }

// Live children, so a shutdown can take them down instead of orphaning them.
const liveChildren = new Set<ReturnType<typeof spawn>>();

/**
 * Runs a command to completion. Never rejects: a spawn failure (missing binary,
 * missing cwd) is code -1 with the reason in stderr. With `stdoutFile`, stdout
 * goes straight to that file — see `listAgents` for why.
 */
function run(bin: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const max = opts.maxBytes ?? 4 * 1024 * 1024;
    let outFd: number | null = null;
    if (opts.stdoutFile) outFd = fs.openSync(opts.stdoutFile, 'w');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd, env: childEnv(), stdio: ['ignore', outFd ?? 'pipe', 'pipe'],
      });
    } catch (e) {
      if (outFd !== null) fs.closeSync(outFd);
      resolve({ code: -1, stdout: '', stderr: (e as Error).message, timedOut: false });
      return;
    }
    if (outFd !== null) fs.closeSync(outFd);
    liveChildren.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    child.stdout?.on('data', (b: Buffer) => { if (outLen < max) { out.push(b); outLen += b.length; } });
    child.stderr?.on('data', (b: Buffer) => { if (errLen < max) { err.push(b); errLen += b.length; } });
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeoutMs)
      : null;
    let settled = false;
    const finish = (code: number, extraErr = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      liveChildren.delete(child);
      const cap = (bufs: Buffer[]) => Buffer.concat(bufs).subarray(0, max).toString('utf8');
      resolve({ code, stdout: cap(out), stderr: cap(err) + extraErr, timedOut });
    };
    child.on('error', (e) => finish(-1, e.message));
    child.on('close', (code) => finish(timedOut ? -1 : code ?? -1));
  });
}

// ---- claude version (asked once; it does not change under a live channel) ---

let versionPromise: Promise<string> | null = null;
function claudeVersion(): Promise<string> {
  if (!versionPromise) {
    versionPromise = run(CLAUDE_BIN, ['--version'], { timeoutMs: 10_000 }).then((r) => {
      if (r.code !== 0) {
        // Do not cache a failure: a PATH fix on the host should show up next time.
        versionPromise = null;
        return '';
      }
      return (stripAnsi(r.stdout).split('\n')[0] ?? '').trim();
    });
  }
  return versionPromise;
}

// ---- agents -----------------------------------------------------------------

const AGENTS_FRESH_MS = 2_000;
let agentsCache: { at: number; rows: AgentRow[] } | null = null;
let agentsInFlight: Promise<{ at: number; rows: AgentRow[] }> | null = null;
let tmpCounter = 0;

/**
 * `claude agents --json` with stdout sent to a temp file, not a pipe: with a
 * pipe the CLI exits before the reader drains past ~8 KB and the JSON arrives
 * truncated (same caveat as runListAgentsOnce in claude-cli.ts). Single-flight
 * with a short freshness window, because both the laptop's poll and the 5 s
 * push ask for it and each run costs a node startup on the host.
 */
function listAgents(): Promise<{ at: number; rows: AgentRow[] }> {
  if (agentsCache && Date.now() - agentsCache.at < AGENTS_FRESH_MS) return Promise.resolve(agentsCache);
  if (agentsInFlight) return agentsInFlight;
  agentsInFlight = (async () => {
    const tmp = path.join(os.tmpdir(), `peersflow-agents-${process.pid}-${++tmpCounter}.json`);
    try {
      const r = await run(CLAUDE_BIN, ['agents', '--json'], { timeoutMs: 30_000, stdoutFile: tmp });
      if (r.timedOut) throw new Error('claude agents --json timed out');
      if (r.code !== 0) throw new Error(`claude agents --json exited ${r.code}: ${stripAnsi(r.stderr).slice(0, 200)}`);
      const raw = fs.readFileSync(tmp, 'utf8');
      const rows = JSON.parse(stripAnsi(raw)) as AgentRow[];
      if (!Array.isArray(rows)) throw new Error('claude agents --json: not an array');
      agentsCache = { at: Date.now(), rows };
      return agentsCache;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* never created */ }
    }
  })().finally(() => { agentsInFlight = null; });
  return agentsInFlight;
}

// While the laptop watches jobs it also wants the live agent list (state,
// waitingFor) without polling over ssh, so the script pushes it.
let agentsPushTimer: NodeJS.Timeout | null = null;
function syncAgentsPush(): void {
  if (watched.size > 0 && !agentsPushTimer) {
    agentsPushTimer = setInterval(() => {
      listAgents()
        .then((c) => emit({ t: 'agents', id: '', at: c.at, rows: c.rows }))
        .catch((e) => log('agents push failed', (e as Error).message));
    }, 5_000);
    agentsPushTimer.unref();
  } else if (watched.size === 0 && agentsPushTimer) {
    clearInterval(agentsPushTimer);
    agentsPushTimer = null;
  }
}

// ---- job watching -----------------------------------------------------------

// Shorts and session ids become path segments; refuse anything that could walk.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
function safeId(v: string, what: string): string {
  if (!SAFE_ID.test(v)) throw new Error(`bad ${what}: ${JSON.stringify(v)}`);
  return v;
}

function jobDir(short: string): string {
  return path.join(CLAUDE_HOME, 'jobs', short);
}

function readJob(short: string): { state: JobStateJson | null; mtimeMs: number } {
  const file = path.join(jobDir(short), 'state.json');
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return { state: null, mtimeMs: 0 }; }
  try {
    return { state: JSON.parse(fs.readFileSync(file, 'utf8')) as JobStateJson, mtimeMs };
  } catch {
    // Mid-write or corrupt: report "unreadable", the next change pushes again.
    return { state: null, mtimeMs };
  }
}

function pushJob(short: string, id = ''): void {
  const { state, mtimeMs } = readJob(short);
  emit({ t: 'job', id, short, state, mtimeMs });
}

interface JobWatch { watcher: fs.FSWatcher | null; retry: NodeJS.Timeout | null; debounce: NodeJS.Timeout | null }
const watched = new Map<string, JobWatch>();

function startJobWatch(short: string, w: JobWatch): void {
  try {
    // The DIRECTORY, not state.json: claude writes tmp + rename, which replaces
    // the inode and silently ends a file-level watcher (see poller.ts).
    w.watcher = fs.watch(jobDir(short), { persistent: false }, () => {
      if (w.debounce) clearTimeout(w.debounce);
      w.debounce = setTimeout(() => {
        w.debounce = null;
        if (watched.get(short) === w) pushJob(short);
      }, 30);
      w.debounce.unref();
    });
    w.watcher.on('error', () => {
      // The job dir was removed (claude rm) — fall back to waiting for it.
      w.watcher?.close();
      w.watcher = null;
      scheduleJobRetry(short, w);
    });
  } catch {
    // Not created yet: the spawn that names this short may still be starting.
    w.watcher = null;
    scheduleJobRetry(short, w);
  }
}

function scheduleJobRetry(short: string, w: JobWatch): void {
  if (w.retry) return;
  w.retry = setInterval(() => {
    if (watched.get(short) !== w) return;
    if (!fs.existsSync(jobDir(short))) return;
    if (w.retry) clearInterval(w.retry);
    w.retry = null;
    startJobWatch(short, w);
    if (w.watcher) pushJob(short);
  }, 10_000);
  w.retry.unref();
}

function stopJobWatch(w: JobWatch): void {
  w.watcher?.close();
  if (w.retry) clearInterval(w.retry);
  if (w.debounce) clearTimeout(w.debounce);
  w.watcher = null; w.retry = null; w.debounce = null;
}

function setWatched(jobs: string[]): string[] {
  const next = new Set(jobs.map((s) => safeId(s, 'job short')));
  for (const [short, w] of watched) {
    if (!next.has(short)) { stopJobWatch(w); watched.delete(short); }
  }
  const added: string[] = [];
  for (const short of next) {
    if (watched.has(short)) continue;
    const w: JobWatch = { watcher: null, retry: null, debounce: null };
    watched.set(short, w);
    startJobWatch(short, w);
    added.push(short);
  }
  syncAgentsPush();
  return added;
}

// ---- workspace trust (mirrors electron/workspace-trust.ts) --------------------

function trustDir(dir: string): boolean {
  // The CLI keys projects by its physical cwd, which is the resolved path.
  let key = path.resolve(dir);
  try { key = fs.realpathSync(key); } catch { /* missing dir — the spawn will say so */ }
  let config: Record<string, unknown>;
  let raw: string | null = null;
  try { raw = fs.readFileSync(CLAUDE_CONFIG, 'utf8'); } catch (e) {
    // A host where claude never ran interactively has no config yet; starting
    // one is what the trust prompt itself would do.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (raw === null) config = {};
  else {
    try { config = JSON.parse(raw) as Record<string, unknown>; } catch {
      // Possibly mid-write by a running claude: never overwrite what we cannot read.
      throw new Error(`cannot parse ${CLAUDE_CONFIG}`);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${CLAUDE_CONFIG} is not an object`);
  }
  const projects = (config.projects && typeof config.projects === 'object' ? config.projects : {}) as Record<string, Record<string, unknown> | undefined>;
  const entry = projects[key];
  // `--bg --permission-mode bypassPermissions` is refused until the bypass
  // disclaimer was accepted once interactively, which a remote spawn cannot do;
  // the CLI records that as this top-level flag, so it is set alongside trust.
  const trusted = entry?.hasTrustDialogAccepted === true;
  const bypassAccepted = config.bypassPermissionsModeAccepted === true;
  if (trusted && bypassAccepted) return false;
  const next = {
    ...config,
    bypassPermissionsModeAccepted: true,
    projects: trusted ? projects : { ...projects, [key]: { ...entry, hasTrustDialogAccepted: true } },
  };
  const tmp = `${CLAUDE_CONFIG}.peersflow.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CLAUDE_CONFIG);
  log('accepted workspace trust', key, { trustChanged: !trusted, bypassChanged: !bypassAccepted });
  return true;
}

// ---- skills (mirrors readClaudeScope in main.ts / readProjectSkills in registry.ts)

function describeMarkdown(filePath: string): string {
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '---') break;
      const m = /^description\s*:\s*(.+)$/i.exec(t);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
    const end = lines.indexOf('---', 1);
    for (let i = end + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t && !t.startsWith('#')) return t;
    }
    return '';
  }
  for (const line of lines) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t;
  }
  return '';
}

/** Commands under `commandsDir` (recursive, ':'-namespaced) + `<skillsDir>/<name>/SKILL.md`. */
function readScope(commandsDir: string, skillsDirs: string[], scope: 'user' | 'project'): SlashCommand[] {
  const out: SlashCommand[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, `${prefix}${ent.name}:`);
      else if (ent.isFile() && ent.name.endsWith('.md')) {
        const name = `${prefix}${ent.name.replace(/\.md$/, '')}`;
        out.push({ name, invocation: `/${name}`, description: describeMarkdown(full), scope, kind: 'command', source: full });
      }
    }
  };
  walk(commandsDir, '');
  for (const skillsDir of skillsDirs) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { /* no skills dir */ }
    for (const ent of entries) {
      // Symlinked skill dirs are common (shared skill repos); SKILL.md decides.
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const skillFile = path.join(skillsDir, ent.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      // First skills dir wins inside one scope (.claude/skills over .agents/skills).
      if (out.some((s) => s.name === ent.name && s.kind === 'skill')) continue;
      out.push({ name: ent.name, invocation: `/${ent.name}`, description: describeMarkdown(skillFile), scope, kind: 'skill', source: skillFile });
    }
  }
  return out;
}

function projectScope(dir: string): SlashCommand[] {
  const claudeDir = path.join(dir, '.claude');
  return readScope(path.join(claudeDir, 'commands'), [path.join(claudeDir, 'skills'), path.join(dir, '.agents', 'skills')], 'project');
}

function listSkills(dir: string | null): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  // User scope first so project entries overwrite (shadow) same-named ones.
  for (const c of readScope(path.join(CLAUDE_HOME, 'commands'), [path.join(CLAUDE_HOME, 'skills')], 'user')) byName.set(c.name, c);
  if (dir) for (const c of projectScope(dir)) byName.set(c.name, c);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

const MAX_SKILLS_PER_PEER = 24;

async function peerInfo(dir: string): Promise<Omit<RemotePeerCache, 'refreshedAt'>> {
  let exists = false;
  try { exists = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
  const has = (rel: string) => exists && fs.existsSync(path.join(dir, rel));
  const skills: RemotePeerSkill[] = exists
    ? projectScope(dir)
      .map((s) => ({ name: s.name, description: s.description, kind: s.kind }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_SKILLS_PER_PEER)
    : [];
  return {
    exists,
    hasClaudeMd: has('CLAUDE.md'),
    hasAgentsMd: has('AGENTS.md'),
    hasProjectMcp: has('.mcp.json'),
    hasCodexConfig: has(path.join('.codex', 'config.toml')),
    skills,
    hostname: os.hostname(),
    home: HOME,
    claudeVersion: await claudeVersion(),
    nodeVersion: process.version,
  };
}

// ---- transcript tailing -----------------------------------------------------

interface Tail { sessionId: string; cwd: string; file: string | null; offset: number; partial: Buffer; seen: Set<string>; timer: NodeJS.Timeout | null; stopped: boolean }
const tails = new Map<string, Tail>();
const TRANSCRIPT_BATCH = 50;
const TRANSCRIPT_TEXT_MAX = 4000;

function findTranscript(sessionId: string, cwd: string): string | null {
  const projects = path.join(CLAUDE_HOME, 'projects');
  // Claude names the project dir after the cwd with every non-alphanumeric → '-'.
  const direct = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  // The cwd the laptop knows may differ (symlinked home, worktree): scan.
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(projects); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(projects, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function recordFromLine(line: string, seen: Set<string>): TranscriptRecord | null {
  let entry: { type?: unknown; uuid?: unknown; timestamp?: unknown; message?: { content?: unknown } };
  try { entry = JSON.parse(line); } catch { return null; }
  if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) return null;
  const content = entry.message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((p): p is { type: 'text'; text: string } => !!p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  } else return null;
  // Tool-result-only turns carry no text worth showing.
  if (!text.trim()) return null;
  if (typeof entry.uuid === 'string') {
    if (seen.has(entry.uuid)) return null;
    seen.add(entry.uuid);
  }
  return {
    type: entry.type,
    text: text.length > TRANSCRIPT_TEXT_MAX ? text.slice(0, TRANSCRIPT_TEXT_MAX) : text,
    at: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
  };
}

function pollTail(t: Tail): void {
  if (t.stopped) return;
  let delay = 500;
  try {
    if (!t.file) {
      t.file = findTranscript(t.sessionId, t.cwd);
      if (!t.file) { delay = 2_000; return; }
    }
    let size: number;
    try { size = fs.statSync(t.file).size; } catch {
      // Vanished (moved / cleaned up): look for it again.
      t.file = null; t.offset = 0; t.partial = Buffer.alloc(0); delay = 2_000; return;
    }
    if (size < t.offset) { t.offset = 0; t.partial = Buffer.alloc(0); } // rewritten in place
    if (size === t.offset) return;
    const fd = fs.openSync(t.file, 'r');
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(size - t.offset);
      const n = fs.readSync(fd, chunk, 0, chunk.length, t.offset);
      chunk = chunk.subarray(0, n);
    } finally { fs.closeSync(fd); }
    t.offset += chunk.length;
    // Split on bytes, not chars, so a multi-byte char cut by the writer survives.
    const buf = t.partial.length ? Buffer.concat([t.partial, chunk]) : chunk;
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) { t.partial = buf; return; }
    t.partial = Buffer.from(buf.subarray(lastNl + 1));
    const records: TranscriptRecord[] = [];
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = recordFromLine(line, t.seen);
      if (r) records.push(r);
    }
    for (let i = 0; i < records.length; i += TRANSCRIPT_BATCH) {
      emit({ t: 'transcript', id: '', sessionId: t.sessionId, records: records.slice(i, i + TRANSCRIPT_BATCH) });
    }
  } catch (e) {
    log('tail poll failed', t.sessionId, (e as Error).message);
  } finally {
    if (!t.stopped) {
      t.timer = setTimeout(() => pollTail(t), delay);
      t.timer.unref();
    }
  }
}

function startTail(sessionId: string, cwd: string): void {
  // Idempotent: a second tail for the same session would replay it from byte 0.
  if (tails.has(sessionId)) return;
  const t: Tail = { sessionId, cwd, file: null, offset: 0, partial: Buffer.alloc(0), seen: new Set(), timer: null, stopped: false };
  tails.set(sessionId, t);
  // Next tick, so the `done` reply leaves before the first transcript batch.
  setImmediate(() => pollTail(t));
}

function stopTail(sessionId: string): void {
  const t = tails.get(sessionId);
  if (!t) return;
  t.stopped = true;
  if (t.timer) clearTimeout(t.timer);
  tails.delete(sessionId);
}

// ---- git / files (mirrors electron/git.ts and electron/search.ts) ------------

function runGit(args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    // Optional locks off: a status poll must never contend with the user's git.
    const env = { ...childEnv(), GIT_OPTIONAL_LOCKS: '0' };
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    liveChildren.add(child);
    const o: Buffer[] = [];
    const e: Buffer[] = [];
    child.stdout!.on('data', (b: Buffer) => o.push(b));
    child.stderr!.on('data', (b: Buffer) => e.push(b));
    child.on('close', (code) => { liveChildren.delete(child); resolve({ code: code ?? -1, stdout: Buffer.concat(o).toString('utf8'), stderr: Buffer.concat(e).toString('utf8'), timedOut: false }); });
    child.on('error', () => { liveChildren.delete(child); resolve({ code: -1, stdout: '', stderr: '', timedOut: false }); });
  });
}

/** Walks up for a `.git` dir or gitlink file, like probeRepo in git.ts. */
function isInRepo(cwd: string): boolean {
  let dir = cwd;
  for (let i = 0; i < 64; i++) {
    try {
      const st = fs.statSync(path.join(dir, '.git'));
      if (st.isDirectory() || st.isFile()) return true;
    } catch { /* not at this level */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function classify(xy: string): GitEntryStatus {
  if (xy === '??') return 'untracked';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('A')) return 'added';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('M')) return 'modified';
  return 'unknown';
}

/** Copy of parsePorcelainV1Z in git.ts (`git status --porcelain=v1 -z --branch`). */
function parsePorcelainV1Z(buf: string): { branch?: string; entries: GitEntry[] } {
  const entries: GitEntry[] = [];
  let branch: string | undefined;
  let i = 0;
  if (buf.startsWith('## ')) {
    const end = buf.indexOf('\0');
    const header = end === -1 ? buf.slice(3) : buf.slice(3, end);
    if (header.startsWith('HEAD (no branch)')) branch = 'HEAD';
    else {
      // "main", "main...origin/main", "main...origin/main [ahead 1]", "No commits yet on main"
      const noCommits = /^No commits yet on (.+)$/.exec(header);
      const h = noCommits ? noCommits[1] : header;
      const dotIdx = h.indexOf('...');
      const spaceIdx = h.indexOf(' ');
      let cut = h.length;
      if (dotIdx >= 0) cut = Math.min(cut, dotIdx);
      if (spaceIdx >= 0) cut = Math.min(cut, spaceIdx);
      branch = h.slice(0, cut);
    }
    i = end === -1 ? buf.length : end + 1;
  }
  while (i < buf.length) {
    const xy = buf.slice(i, i + 2);
    i += 3;
    let pathEnd = buf.indexOf('\0', i);
    if (pathEnd === -1) pathEnd = buf.length;
    const filePath = buf.slice(i, pathEnd);
    i = pathEnd + 1;
    let oldPath: string | undefined;
    if (xy.includes('R')) {
      let oldEnd = buf.indexOf('\0', i);
      if (oldEnd === -1) oldEnd = buf.length;
      oldPath = buf.slice(i, oldEnd);
      i = oldEnd + 1;
    }
    if (!filePath) continue;
    entries.push({ path: filePath, status: classify(xy), staged: xy[0] !== ' ' && xy[0] !== '?', unstaged: xy[1] !== ' ' && xy[1] !== '?', oldPath });
  }
  return { branch, entries };
}

async function gitStatus(cwd: string): Promise<GitStatusResult> {
  try { fs.accessSync(cwd); } catch { return { isRepo: false, entries: [] }; }
  if (!isInRepo(cwd)) return { isRepo: false, entries: [] };
  const r = await runGit(['status', '--porcelain=v1', '--untracked-files=all', '--branch', '-z'], cwd);
  if (r.code !== 0) return { isRepo: true, entries: [] };
  const { branch, entries } = parsePorcelainV1Z(r.stdout);
  return { isRepo: true, branch, entries };
}

const parseZ = (s: string): string[] => (s ? s.split('\0').filter(Boolean) : []);

const WALK_MAX_ENTRIES = 5000;
const WALK_MAX_DEPTH = 6;
const WALK_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', '.cache', '.turbo',
  '__pycache__', '.venv', 'venv', '.gradle', '.idea', 'DerivedData',
]);
// Bounded so a huge non-repo folder (~/Desktop) cannot stall the channel.
function walkFs(cwd: string, sub = '', acc: FileEntry[] = [], depth = 0): FileEntry[] {
  if (acc.length >= WALK_MAX_ENTRIES || depth > WALK_MAX_DEPTH) return acc;
  const here = sub ? path.join(cwd, sub) : cwd;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    if (acc.length >= WALK_MAX_ENTRIES) break;
    if (WALK_SKIP_DIRS.has(ent.name)) continue;
    const rel = sub ? path.join(sub, ent.name) : ent.name;
    if (ent.isDirectory()) walkFs(cwd, rel, acc, depth + 1);
    else acc.push({ path: rel, isIgnored: false });
  }
  return acc;
}

async function listFiles(cwd: string): Promise<FileEntry[]> {
  try { fs.accessSync(cwd); } catch { return []; }
  if (!isInRepo(cwd)) return walkFs(cwd);
  const a = await runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd);
  if (a.code !== 0) return walkFs(cwd);
  const ignored = await runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], cwd);
  const out: FileEntry[] = parseZ(a.stdout).map((p) => ({ path: p, isIgnored: false }));
  for (const p of new Set(parseZ(ignored.stdout))) out.push({ path: p, isIgnored: true });
  return out;
}

const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_MAX_FILES = 5000;
const SEARCH_MAX_TOTAL_MATCHES = 2000;
const SEARCH_MAX_MATCHES_PER_FILE = 200;
const SEARCH_MAX_LINE_LENGTH = 500;

function matchLine(line: string, re: RegExp): { text: string; ranges: [number, number][] } | null {
  re.lastIndex = 0;
  const ranges: [number, number][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (start < SEARCH_MAX_LINE_LENGTH) ranges.push([start, Math.min(end, SEARCH_MAX_LINE_LENGTH)]);
    if (m[0].length === 0) re.lastIndex++; // zero-width match would loop forever
    if (ranges.length >= 1000) break;
  }
  if (ranges.length === 0) return null;
  const text = line.length > SEARCH_MAX_LINE_LENGTH ? line.slice(0, SEARCH_MAX_LINE_LENGTH) + '…' : line;
  return { text, ranges };
}

async function searchInFiles(dir: string, query: string, caseSensitive?: boolean, isRegex?: boolean): Promise<SearchResult> {
  const empty: SearchResult = { files: [], totalMatches: 0, filesScanned: 0, truncated: false };
  if (!query) return empty;
  let re: RegExp;
  try {
    re = new RegExp(isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  } catch (err) {
    return { ...empty, error: `Invalid pattern: ${(err as Error).message}` };
  }
  try { fs.accessSync(dir); } catch { return empty; }
  const entries = (await listFiles(dir)).filter((e) => !e.isIgnored);
  const files: SearchFileResult[] = [];
  let totalMatches = 0;
  let filesScanned = 0;
  let truncated = false;
  for (const entry of entries) {
    if (filesScanned >= SEARCH_MAX_FILES || totalMatches >= SEARCH_MAX_TOTAL_MATCHES) { truncated = true; break; }
    const full = path.join(dir, entry.path);
    let buf: Buffer;
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > SEARCH_MAX_FILE_BYTES) continue;
      buf = await fs.promises.readFile(full);
    } catch { continue; }
    if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) continue; // binary
    filesScanned++;
    const lines = buf.toString('utf8').split('\n');
    const matches: SearchMatchLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      const res = matchLine(lines[i], re);
      if (!res) continue;
      matches.push({ line: i + 1, text: res.text, ranges: res.ranges });
      totalMatches++;
      if (matches.length >= SEARCH_MAX_MATCHES_PER_FILE || totalMatches >= SEARCH_MAX_TOTAL_MATCHES) { truncated = true; break; }
    }
    if (matches.length > 0) files.push({ path: entry.path, matches });
  }
  return { files, totalMatches, filesScanned, truncated };
}

// ---- fs watching for the file sidebar ----------------------------------------

const FS_IGNORE = ['/node_modules/', '/.git/objects', '/dist/', '/.next/', '/.agentsflow/'];
const fsWatchers = new Map<string, { watcher: fs.FSWatcher; timer: NodeJS.Timeout | null }>();

function startFsWatch(dir: string): void {
  if (fsWatchers.has(dir)) return;
  const entry: { watcher: fs.FSWatcher; timer: NodeJS.Timeout | null } = {
    timer: null,
    watcher: fs.watch(dir, { recursive: true, persistent: false }, (_ev, filename) => {
      if (filename) {
        const rel = '/' + String(filename).replace(/\\/g, '/');
        if (FS_IGNORE.some((p) => rel.includes(p))) return;
      }
      // Coalesce a burst (git checkout, build) into one refresh on the laptop.
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => { entry.timer = null; emit({ t: 'fsevent', id: '', dir }); }, 150);
      entry.timer.unref();
    }),
  };
  entry.watcher.on('error', (e) => { log('fswatch error', dir, e.message); stopFsWatch(dir); });
  fsWatchers.set(dir, entry);
}

function stopFsWatch(dir: string): void {
  const e = fsWatchers.get(dir);
  if (!e) return;
  e.watcher.close();
  if (e.timer) clearTimeout(e.timer);
  fsWatchers.delete(dir);
}

// ---- command dispatch ---------------------------------------------------------

const EXEC_CAP = 256 * 1024;
const READ_DEFAULT_MAX = 2 * 1024 * 1024;
// No caller-given timeout must still not pin a child (and the channel) forever.
const EXEC_DEFAULT_TIMEOUT_MS = 120_000;

function req<T>(msg: Record<string, unknown>, key: string, type: 'string' | 'number' | 'object'): T {
  const v = msg[key];
  if (type === 'object' ? !Array.isArray(v) : typeof v !== type) throw new Error(`missing or bad field: ${key}`);
  return v as T;
}

function absPath(p: string): string {
  if (!path.isAbsolute(p)) throw new Error(`path must be absolute: ${p}`);
  return p;
}

async function dispatch(msg: AgentCommand): Promise<void> {
  const id = msg.id;
  const m = msg as unknown as Record<string, unknown>;
  switch (msg.cmd) {
    case 'hello':
      emit({ t: 'hello', id, protocol: PROTOCOL, hostname: os.hostname(), home: HOME, pid: process.pid, claudeVersion: await claudeVersion(), nodeVersion: process.version });
      return;
    case 'agents': {
      const c = await listAgents();
      emit({ t: 'agents', id, at: c.at, rows: c.rows });
      return;
    }
    case 'watch': {
      const jobs = req<string[]>(m, 'jobs', 'object');
      const added = setWatched(jobs.map(String));
      emit({ t: 'done', id });
      for (const short of added) pushJob(short);
      return;
    }
    case 'job':
      pushJob(safeId(req<string>(m, 'short', 'string'), 'job short'), id);
      return;
    case 'spawn': {
      const cwd = req<string>(m, 'cwd', 'string');
      const prompt = req<string>(m, 'prompt', 'string');
      const args = (req<unknown[]>(m, 'args', 'object')).map(String);
      // Never log the prompt body (log-storm incident) — its length is enough.
      log('spawn', { cwd, args, promptLength: prompt.length });
      const r = await run(CLAUDE_BIN, ['--bg', ...args, prompt], { cwd, timeoutMs: 20_000 });
      const combined = stripAnsi(`${r.stdout}\n${r.stderr}`).trim();
      const mm = /backgrounded\s*·\s*([0-9a-f]{6,12})/i.exec(combined);
      emit({ t: 'spawned', id, daemonShort: mm ? mm[1] : null, raw: combined.slice(0, 2000), code: r.code });
      return;
    }
    case 'stop':
    case 'rm': {
      const short = safeId(req<string>(m, 'short', 'string'), 'job short');
      const r = await run(CLAUDE_BIN, [msg.cmd, short], { timeoutMs: 10_000 });
      if (r.code !== 0) throw new Error(`claude ${msg.cmd} ${short} exited ${r.code}${r.timedOut ? ' (timeout)' : ''}: ${stripAnsi(r.stderr || r.stdout).trim().slice(0, 300)}`);
      emit({ t: 'done', id });
      return;
    }
    case 'trust':
      emit({ t: 'done', id, changed: trustDir(req<string>(m, 'dir', 'string')) });
      return;
    case 'skills': {
      const dir = m.dir == null ? null : req<string>(m, 'dir', 'string');
      emit({ t: 'skills', id, entries: listSkills(dir) });
      return;
    }
    case 'peerinfo':
      emit({ t: 'peerinfo', id, cache: await peerInfo(req<string>(m, 'dir', 'string')) });
      return;
    case 'tail': {
      const sessionId = safeId(req<string>(m, 'sessionId', 'string'), 'sessionId');
      const cwd = req<string>(m, 'cwd', 'string');
      emit({ t: 'done', id });
      startTail(sessionId, cwd);
      return;
    }
    case 'untail':
      stopTail(req<string>(m, 'sessionId', 'string'));
      emit({ t: 'done', id });
      return;
    case 'write': {
      const p = absPath(req<string>(m, 'path', 'string'));
      const mode = typeof m.mode === 'number' ? m.mode : 0o600;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(req<string>(m, 'contentBase64', 'string'), 'base64'), { mode });
      // writeFileSync's mode only applies on create; an existing file keeps its own.
      fs.chmodSync(p, mode);
      emit({ t: 'done', id });
      return;
    }
    case 'read': {
      const p = absPath(req<string>(m, 'path', 'string'));
      const maxBytes = typeof m.maxBytes === 'number' && m.maxBytes >= 0 ? m.maxBytes : READ_DEFAULT_MAX;
      const size = fs.statSync(p).size;
      const want = Math.min(size, maxBytes);
      const buf = Buffer.alloc(want);
      const fd = fs.openSync(p, 'r');
      let n = 0;
      try { n = want ? fs.readSync(fd, buf, 0, want, 0) : 0; } finally { fs.closeSync(fd); }
      emit({ t: 'file', id, contentBase64: buf.subarray(0, n).toString('base64'), size, truncated: size > maxBytes });
      return;
    }
    case 'stat': {
      const p = absPath(req<string>(m, 'path', 'string'));
      let result: StatResult;
      try {
        const st = fs.statSync(p);
        result = { exists: true, isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        result = { exists: false, isFile: false, isDirectory: false, size: 0, mtimeMs: 0 };
      }
      emit({ t: 'stat', id, result });
      return;
    }
    case 'list':
      emit({ t: 'list', id, entries: await listFiles(absPath(req<string>(m, 'dir', 'string'))) });
      return;
    case 'gitstatus':
      emit({ t: 'gitstatus', id, result: await gitStatus(absPath(req<string>(m, 'dir', 'string'))) });
      return;
    case 'mkfile':
      fs.writeFileSync(absPath(req<string>(m, 'path', 'string')), '', { flag: 'wx' });
      emit({ t: 'done', id });
      return;
    case 'rename': {
      const from = absPath(req<string>(m, 'from', 'string'));
      const to = absPath(req<string>(m, 'to', 'string'));
      let targetExists = true;
      try { fs.lstatSync(to); } catch { targetExists = false; }
      if (targetExists) throw new Error(`rename: target exists: ${to}`);
      fs.renameSync(from, to);
      emit({ t: 'done', id });
      return;
    }
    case 'remove': {
      const p = absPath(req<string>(m, 'path', 'string'));
      // Same guard as files:remove in main.ts: never nuke a root or a short path.
      if (p === '/' || p.split(path.sep).filter(Boolean).length < 2) throw new Error(`remove: refusing to delete suspicious path ${p}`);
      fs.rmSync(p, { recursive: true, force: false });
      emit({ t: 'done', id });
      return;
    }
    case 'search': {
      const dir = absPath(req<string>(m, 'dir', 'string'));
      const query = req<string>(m, 'query', 'string');
      emit({ t: 'search', id, result: await searchInFiles(dir, query, m.caseSensitive === true, m.isRegex === true) });
      return;
    }
    case 'fswatch':
      startFsWatch(absPath(req<string>(m, 'dir', 'string')));
      emit({ t: 'done', id });
      return;
    case 'fsunwatch':
      stopFsWatch(req<string>(m, 'dir', 'string'));
      emit({ t: 'done', id });
      return;
    case 'exec': {
      const argv = req<unknown[]>(m, 'argv', 'object').map(String);
      if (argv.length === 0) throw new Error('exec: empty argv');
      const cwd = typeof m.cwd === 'string' ? m.cwd : undefined;
      const timeoutMs = typeof m.timeoutMs === 'number' && m.timeoutMs > 0 ? m.timeoutMs : EXEC_DEFAULT_TIMEOUT_MS;
      const r = await run(argv[0], argv.slice(1), { cwd, timeoutMs, maxBytes: EXEC_CAP });
      emit({ t: 'exec', id, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut });
      return;
    }
    default:
      throw new Error(`unknown command: ${String((msg as { cmd?: unknown }).cmd)}`);
  }
}

// ---- stdin loop and lifecycle ---------------------------------------------------

let pending = 0;
let closing = false;

function handle(line: string): void {
  if (!line.trim()) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    emit({ t: 'error', id: '', message: 'bad json' });
    return;
  }
  const id = msg && typeof msg.id === 'string' ? msg.id : '';
  if (!msg || typeof msg !== 'object' || typeof msg.cmd !== 'string') {
    emit({ t: 'error', id, message: 'missing cmd' });
    return;
  }
  pending++;
  // A bad command answers `error` and the channel lives on: one malformed
  // request must not take down every watcher the laptop depends on.
  dispatch({ ...msg, id } as unknown as AgentCommand)
    .catch((e: unknown) => emit({ t: 'error', id, message: e instanceof Error ? e.message : String(e) }))
    .finally(() => { pending--; if (closing && pending === 0) shutdown(); });
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const w of watched.values()) stopJobWatch(w);
  for (const d of [...fsWatchers.keys()]) stopFsWatch(d);
  for (const s of [...tails.keys()]) stopTail(s);
  if (agentsPushTimer) clearInterval(agentsPushTimer);
  for (const c of liveChildren) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  // stdout to a pipe is async on macOS: exit only once queued events are flushed.
  process.stdout.write('', () => process.exit(0));
}

// The laptop gone (ssh dropped) turns stdout into EPIPE; nobody is listening.
process.stdout.on('error', () => process.exit(0));

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', handle);
// The laptop closing the channel (app quit, ssh drop) ends stdin: answer what is
// already in flight, then exit so no orphan agent lingers on the host.
rl.on('close', () => { closing = true; if (pending === 0) shutdown(); });
process.on('SIGTERM', shutdown);
