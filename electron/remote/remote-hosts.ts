// RemoteHosts — one live connection per SSH host that owns a tracked remote
// peer. It deploys the agent script, keeps its NDJSON channel open, forwards
// the delegation bridge socket, and caches what the hot paths (poller ticks,
// claude-cli lookups) must read synchronously: agent rows and job states.
// Callers never talk ssh themselves; they ask this class by hostKey.
//
import type { ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentCommand, AgentEvent, AgentRow, JobStateJson, StatResult, TranscriptRecord } from '../../shared/remote';
import { hostKeyOf } from '../../shared/remote';
import type { FileEntry, GitStatusResult, RemoteHostState, RemoteHostStatus, RemotePeerCache, RemotePeerSpec, SearchOptions, SearchResult, SlashCommand, TrackedDirectory } from '../../shared/types';
import * as remoteExec from './remote-exec';
import type { RunResult } from './remote-exec';

export interface RemoteHostsDeps {
  instanceId: string;                              // app.getPath('userData')
  bundleRoot: string;                              // dist/electron (the dir that contains `electron/remote/remote-agent-script.js`); main passes path.join(__dirname, '..', '..')
  localBridgeSock: string;                         // bridgeSocketPath()
  getDirectories: () => TrackedDirectory[];
  updateDirectory: (id: string, patch: Partial<TrackedDirectory>) => void;   // persists remoteCache (store.setDirectories under the hood)
  onHostsChanged: (hosts: RemoteHostStatus[]) => void;
  onJobState: (hostKey: string, short: string, state: JobStateJson | null, mtimeMs: number) => void;
  onAgentsRows: (hostKey: string, rows: AgentRow[], at: number) => void;
  onTranscript?: (hostKey: string, sessionId: string, records: TranscriptRecord[]) => void;
  onFsEvent?: (hostKey: string, dir: string) => void;
  /** Tests inject fakes; defaults to the real ssh functions in remote-exec. */
  transport?: RemoteTransport;
}

// The slice of remote-exec this class uses, so tests can run it without ssh.
export interface RemoteTransport {
  run: (spec: RemotePeerSpec, instanceId: string, command: string, opts?: { stdin?: string | Buffer; timeoutMs?: number }) => Promise<RunResult>;
  openChannel: (spec: RemotePeerSpec, instanceId: string, command: string) => ChildProcess;
  putFile: (spec: RemotePeerSpec, instanceId: string, remotePath: string, content: Buffer | string, mode?: number) => Promise<RunResult>;
  addReverseForward: (spec: RemotePeerSpec, instanceId: string, remoteSock: string, localSock: string) => Promise<RunResult>;
  cancelReverseForward: (spec: RemotePeerSpec, instanceId: string, remoteSock: string, localSock: string) => Promise<RunResult>;
  masterAlive: (spec: RemotePeerSpec, instanceId: string) => Promise<boolean>;
  closeMaster: (spec: RemotePeerSpec, instanceId: string) => Promise<void>;
}

const realTransport: RemoteTransport = {
  run: remoteExec.runRemote,
  openChannel: remoteExec.openChannel,
  putFile: remoteExec.putFile,
  addReverseForward: remoteExec.addReverseForward,
  cancelReverseForward: remoteExec.cancelReverseForward,
  masterAlive: remoteExec.masterAlive,
  closeMaster: remoteExec.closeMaster,
};

// Shipped to `<home>/.peersflow/bundles/<sha1 of contents>/` once, marked by
// `.ok`. Relative to bundleRoot. The MCP server needs registry + locale beside it.
export const BUNDLE_FILES = ['electron/remote/remote-agent-script.js', 'electron/mcp/agentsflow-mcp-server.js', 'electron/registry.js', 'electron/locale.js'] as const;

const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const SPAWN_TIMEOUT_MS = 45_000;
// Rows older than this are not trusted by the poller: it falls back to a
// fresh `agents` request instead of deriving state from a dead snapshot.
const ROWS_STALE_MS = 30_000;
const SKILLS_TTL_MS = 30_000;
const STOP_BUDGET_MS = 5_000;
const STDERR_LINES_PER_MIN = 20;
// How often a ready host re-checks that its bridge socket still exists.
const BRIDGE_WATCHDOG_MS = 60_000;
const MASTER_RESET_BUDGET_MS = 5_000;

type Pending = { cmd: string; expect: AgentEvent['t']; resolve: (ev: AgentEvent) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
// Distributive Omit so each command variant keeps its own fields.
type CommandBody = AgentCommand extends infer C ? (C extends AgentCommand ? Omit<C, 'id'> : never) : never;

interface Host {
  key: string;
  spec: RemotePeerSpec;
  state: RemoteHostState;
  since: string;
  error?: string;
  hostname?: string;
  home?: string;
  claudeVersion?: string;
  nodeVersion?: string;
  bundleHash?: string;
  bridgeForwarded: boolean;
  agentPid?: number;
  channel: ChildProcess | null;
  pending: Map<string, Pending>;
  rows: { rows: AgentRow[]; at: number; receivedAt: number } | null;
  jobs: Map<string, { state: JobStateJson | null; mtimeMs: number }>;
  // Desired subscriptions; replayed on every (re)connect because the agent
  // process that held them died with the old channel.
  watched: string[];
  tails: Map<string, string>;
  fsWatches: Set<string>;
  skillsCache: Map<string, { at: number; entries: SlashCommand[] }>;
  backoffMs: number;
  retryTimer: NodeJS.Timeout | null;
  // Bumped whenever a connect attempt is superseded (reconnect, stop, drop),
  // so a slow attempt that finishes late cannot clobber newer state.
  gen: number;
  stderrWindowStart: number;
  stderrCount: number;
  // False until the first connect of this process closed any master left over
  // from a previous app run (same instanceId → same ControlPath).
  masterReset: boolean;
  bridgeWatchdog: NodeJS.Timeout | null;
  // Single-flight: connect, ensureBridgeForward and the watchdog may overlap.
  forwarding: Promise<boolean> | null;
}

// One line, bounded: the status shows up in a host card tooltip.
function oneLine(msg: string): string {
  const line = msg.split('\n').map((l) => l.trim()).find(Boolean) ?? msg.trim();
  return line.length > 200 ? line.slice(0, 199) + '…' : line;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function channelAlive(c: ChildProcess): boolean {
  return c.exitCode === null && c.signalCode === null;
}

// Bounds a best-effort step; never rejects.
function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    p.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function sameSpec(a: RemotePeerSpec, b: RemotePeerSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class RemoteHosts {
  // Public read-only so remote-fs can map a path back to its tracked dir
  // through the same directory source this class uses.
  readonly deps: RemoteHostsDeps;
  private readonly transport: RemoteTransport;
  private readonly hosts = new Map<string, Host>();
  private started = false;
  private seq = 0;

  constructor(deps: RemoteHostsDeps) {
    this.deps = deps;
    this.transport = deps.transport ?? realTransport;
  }

  /** Connect every host that owns a tracked remote dir. */
  start(): void {
    this.started = true;
    this.syncFromDirectories();
  }

  /** End channels, cancel forwards, close masters (best effort, ≤ 5 s). */
  async stop(): Promise<void> {
    this.started = false;
    const hosts = [...this.hosts.values()];
    this.hosts.clear();
    const work = hosts.map((h) => this.teardown(h));
    let timer: NodeJS.Timeout | null = null;
    await Promise.race([
      Promise.allSettled(work),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_BUDGET_MS); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Connect new hosts, drop hosts that own no dir any more. */
  syncFromDirectories(): void {
    const wanted = new Map<string, RemotePeerSpec>();
    for (const d of this.deps.getDirectories()) {
      if (!d.remote) continue;
      const key = hostKeyOf(d.remote);
      if (!wanted.has(key)) wanted.set(key, d.remote);
    }
    let changed = false;
    for (const [key, h] of [...this.hosts]) {
      if (wanted.has(key)) continue;
      this.hosts.delete(key);
      console.log('[agentsflow][remote] host dropped', { hostKey: key });
      void this.teardown(h);
      changed = true;
    }
    for (const [key, spec] of wanted) {
      const h = this.hosts.get(key);
      if (!h) {
        const fresh = this.newHost(key, spec);
        this.hosts.set(key, fresh);
        changed = true;
        if (this.started) void this.connect(fresh);
      } else if (!sameSpec(h.spec, spec)) {
        // Edited ssh args / binaries: the running channel was built from the
        // old spec, so start over with the new one.
        h.spec = spec;
        changed = true;
        if (this.started) void this.restart(h);
      }
    }
    if (changed) this.emit();
  }

  statuses(): RemoteHostStatus[] {
    return [...this.hosts.values()].map((h) => this.toStatus(h));
  }

  status(hostKey: string): RemoteHostStatus | null {
    const h = this.hosts.get(hostKey);
    return h ? this.toStatus(h) : null;
  }

  async reconnect(hostKey: string): Promise<void> {
    const h = this.hosts.get(hostKey);
    if (!h) throw new Error(`host ${hostKey} is unknown`);
    console.log('[agentsflow][remote] reconnect requested', { hostKey });
    h.backoffMs = BACKOFF_MIN_MS;
    await this.restart(h);
  }

  specFor(hostKey: string): RemotePeerSpec | null {
    return this.hosts.get(hostKey)?.spec ?? null;
  }

  hostKeyForDir(dir: TrackedDirectory): string | null { return dir.remote ? hostKeyOf(dir.remote) : null; }

  /** A remote tracked dir whose path === p or is a prefix (`${path}/`) AND no local tracked dir matches → its hostKey. */
  hostKeyForPath(p: string): string | null {
    let best: TrackedDirectory | null = null;
    for (const d of this.deps.getDirectories()) {
      if (p !== d.path && !p.startsWith(`${d.path}/`)) continue;
      // A path that also lives under a local peer is local: the laptop's
      // filesystem wins over a remote dir that happens to share the path.
      if (!d.remote) return null;
      if (!best || d.path.length > best.path.length) best = d;
    }
    return best?.remote ? hostKeyOf(best.remote) : null;
  }

  home(hostKey: string): string | null {
    return this.hosts.get(hostKey)?.home ?? null;
  }

  /** `${home}/.peersflow/bundles/${hash}` */
  bundlePath(hostKey: string): string | null {
    const h = this.hosts.get(hostKey);
    return h?.home && h.bundleHash ? `${h.home}/.peersflow/bundles/${h.bundleHash}` : null;
  }

  /** `${home}/.peersflow/bridge-${sha1(instanceId).slice(0, 8)}.sock` */
  remoteBridgeSock(hostKey: string): string | null {
    const h = this.hosts.get(hostKey);
    return h ? this.bridgeSockOf(h) : null;
  }

  // From the Host itself, not the map: teardown runs after the host left it.
  private bridgeSockOf(h: Host): string | null {
    if (!h.home) return null;
    const id = crypto.createHash('sha1').update(this.deps.instanceId).digest('hex').slice(0, 8);
    return `${h.home}/.peersflow/bridge-${id}.sock`;
  }

  /** `${home}/.peersflow/mcp-configs` */
  mcpConfigDir(hostKey: string): string | null {
    const home = this.home(hostKey);
    return home ? `${home}/.peersflow/mcp-configs` : null;
  }

  /** `${home}/.peersflow/attachments/${conversationId}` */
  attachmentsDir(hostKey: string, conversationId: string): string | null {
    const home = this.home(hostKey);
    return home ? `${home}/.peersflow/attachments/${conversationId}` : null;
  }

  async ensureBridgeForward(hostKey: string): Promise<boolean> {
    const h = this.hosts.get(hostKey);
    if (!h || h.state !== 'ready') return false;
    // A forward the master reports as set up can still be dead on the host
    // (sshd refused a duplicate listen path; the socket file was unlinked), so
    // trust only the socket file itself. One cheap round trip over the master.
    if (h.bridgeForwarded && await this.bridgeSockPresent(h)) return true;
    const before = h.bridgeForwarded;
    const ok = await this.forwardBridge(h);
    if (ok !== before || !ok) this.emit();
    return ok;
  }

  // Synchronous cache reads (poller / claude-cli hot paths).
  /** null when never received or older than 30 s. */
  agentsRows(hostKey: string): { rows: AgentRow[]; at: number } | null {
    const r = this.hosts.get(hostKey)?.rows;
    // Staleness is judged on the laptop's clock (receipt time) so a skewed
    // remote clock cannot keep a dead snapshot alive.
    if (!r || Date.now() - r.receivedAt > ROWS_STALE_MS) return null;
    return { rows: r.rows, at: r.at };
  }

  jobState(hostKey: string, short: string): { state: JobStateJson | null; mtimeMs: number } | null {
    return this.hosts.get(hostKey)?.jobs.get(short) ?? null;
  }

  // Commands — resolve on the matching event; reject with Error('host <key> is <state>')
  // when not ready, or on a 30 s timeout (spawn: 45 s).
  async refreshAgents(hostKey: string): Promise<AgentRow[]> {
    const ev = await this.request(hostKey, { cmd: 'agents' }, 'agents');
    return ev.t === 'agents' ? ev.rows : [];
  }

  /** Idempotent; re-sent after every reconnect. */
  setWatched(hostKey: string, shorts: string[]): void {
    const h = this.hosts.get(hostKey);
    if (!h) return;
    const next = [...new Set(shorts)].sort();
    if (next.length === h.watched.length && next.every((s, i) => s === h.watched[i])) return;
    h.watched = next;
    if (h.state === 'ready') this.sendWatch(h);
  }

  async spawn(hostKey: string, req: { cwd: string; prompt: string; args: string[] }): Promise<{ daemonShort: string | null; raw: string; code: number }> {
    // Lengths only: prompts and --append-system-prompt never reach the log.
    console.log('[agentsflow][remote] spawn', { hostKey, cwd: req.cwd, promptLength: req.prompt.length, argCount: req.args.length, argsLength: req.args.join(' ').length });
    const ev = await this.request(hostKey, { cmd: 'spawn', cwd: req.cwd, prompt: req.prompt, args: req.args }, 'spawned', SPAWN_TIMEOUT_MS);
    if (ev.t !== 'spawned') throw new Error('unexpected reply');
    return { daemonShort: ev.daemonShort, raw: ev.raw, code: ev.code };
  }

  async stopJob(hostKey: string, short: string): Promise<void> {
    await this.request(hostKey, { cmd: 'stop', short }, 'done');
  }

  async rmJob(hostKey: string, short: string): Promise<void> {
    await this.request(hostKey, { cmd: 'rm', short }, 'done');
  }

  /** true once the dir is trusted on the host (already was, or just marked). */
  async trust(hostKey: string, dir: string): Promise<boolean> {
    const ev = await this.request(hostKey, { cmd: 'trust', dir }, 'done');
    return ev.t === 'done';
  }

  /** Cached 30 s per (hostKey, dir). */
  async skills(hostKey: string, dir: string | null): Promise<SlashCommand[]> {
    const h = this.hosts.get(hostKey);
    const cacheKey = dir ?? '\0';
    const hit = h?.skillsCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SKILLS_TTL_MS) return hit.entries;
    const ev = await this.request(hostKey, { cmd: 'skills', dir }, 'skills');
    const entries = ev.t === 'skills' ? ev.entries : [];
    h?.skillsCache.set(cacheKey, { at: Date.now(), entries });
    return entries;
  }

  /** Also updateDirectory(remoteCache) for the matching tracked dir. */
  async peerInfo(hostKey: string, dir: string): Promise<RemotePeerCache> {
    const ev = await this.request(hostKey, { cmd: 'peerinfo', dir }, 'peerinfo');
    if (ev.t !== 'peerinfo') throw new Error('unexpected reply');
    const cache: RemotePeerCache = { ...ev.cache, refreshedAt: new Date().toISOString() };
    for (const d of this.deps.getDirectories()) {
      if (d.remote && hostKeyOf(d.remote) === hostKey && d.path === dir) this.deps.updateDirectory(d.id, { remoteCache: cache });
    }
    return cache;
  }

  async tail(hostKey: string, sessionId: string, cwd: string): Promise<void> {
    this.hosts.get(hostKey)?.tails.set(sessionId, cwd);
    await this.request(hostKey, { cmd: 'tail', sessionId, cwd }, 'done');
  }

  async untail(hostKey: string, sessionId: string): Promise<void> {
    this.hosts.get(hostKey)?.tails.delete(sessionId);
    await this.request(hostKey, { cmd: 'untail', sessionId }, 'done');
  }

  async writeFile(hostKey: string, path: string, content: Buffer | string, mode?: number): Promise<void> {
    const contentBase64 = (typeof content === 'string' ? Buffer.from(content, 'utf8') : content).toString('base64');
    await this.request(hostKey, { cmd: 'write', path, contentBase64, ...(mode !== undefined ? { mode } : {}) }, 'done');
  }

  async readFile(hostKey: string, path: string, maxBytes?: number): Promise<{ content: Buffer; size: number; truncated: boolean }> {
    const ev = await this.request(hostKey, { cmd: 'read', path, ...(maxBytes !== undefined ? { maxBytes } : {}) }, 'file');
    if (ev.t !== 'file') throw new Error('unexpected reply');
    return { content: Buffer.from(ev.contentBase64, 'base64'), size: ev.size, truncated: ev.truncated };
  }

  async stat(hostKey: string, path: string): Promise<StatResult> {
    const ev = await this.request(hostKey, { cmd: 'stat', path }, 'stat');
    if (ev.t !== 'stat') throw new Error('unexpected reply');
    return ev.result;
  }

  async listFiles(hostKey: string, dir: string): Promise<FileEntry[]> {
    const ev = await this.request(hostKey, { cmd: 'list', dir }, 'list');
    return ev.t === 'list' ? ev.entries : [];
  }

  async gitStatus(hostKey: string, dir: string): Promise<GitStatusResult> {
    const ev = await this.request(hostKey, { cmd: 'gitstatus', dir }, 'gitstatus');
    if (ev.t !== 'gitstatus') throw new Error('unexpected reply');
    return ev.result;
  }

  async createFile(hostKey: string, path: string): Promise<void> {
    await this.request(hostKey, { cmd: 'mkfile', path }, 'done');
  }

  async rename(hostKey: string, from: string, to: string): Promise<void> {
    await this.request(hostKey, { cmd: 'rename', from, to }, 'done');
  }

  async remove(hostKey: string, path: string): Promise<void> {
    await this.request(hostKey, { cmd: 'remove', path }, 'done');
  }

  async search(hostKey: string, dir: string, query: string, opts?: SearchOptions): Promise<SearchResult> {
    const ev = await this.request(hostKey, { cmd: 'search', dir, query, caseSensitive: opts?.caseSensitive, isRegex: opts?.isRegex }, 'search');
    if (ev.t !== 'search') throw new Error('unexpected reply');
    return ev.result;
  }

  async fsWatch(hostKey: string, dir: string): Promise<void> {
    this.hosts.get(hostKey)?.fsWatches.add(dir);
    await this.request(hostKey, { cmd: 'fswatch', dir }, 'done');
  }

  async fsUnwatch(hostKey: string, dir: string): Promise<void> {
    this.hosts.get(hostKey)?.fsWatches.delete(dir);
    await this.request(hostKey, { cmd: 'fsunwatch', dir }, 'done');
  }

  async exec(hostKey: string, argv: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<RunResult> {
    // The remote side enforces timeoutMs itself; the reply wait gets headroom
    // past it so a long exec is not reported as a lost channel.
    const wait = opts?.timeoutMs !== undefined ? Math.max(COMMAND_TIMEOUT_MS, opts.timeoutMs + 5_000) : COMMAND_TIMEOUT_MS;
    const ev = await this.request(hostKey, { cmd: 'exec', argv, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs }, 'exec', wait);
    if (ev.t !== 'exec') throw new Error('unexpected reply');
    return { code: ev.code, stdout: ev.stdout, stderr: ev.stderr, timedOut: ev.timedOut };
  }

  /** ptySpec(spec, instanceId, remoteCommand(spec, argv, { cwd, exec: true })) */
  ptyCommand(hostKey: string, argv: string[], opts?: { cwd?: string }): { bin: string; args: string[] } | null {
    const h = this.hosts.get(hostKey);
    if (!h || h.state !== 'ready') return null;
    return remoteExec.ptySpec(h.spec, this.deps.instanceId, remoteExec.remoteCommand(h.spec, argv, { cwd: opts?.cwd, exec: true }));
  }

  // ---- connection lifecycle -------------------------------------------------

  private newHost(key: string, spec: RemotePeerSpec): Host {
    return {
      key, spec, state: 'connecting', since: new Date().toISOString(), bridgeForwarded: false,
      channel: null, pending: new Map(), rows: null, jobs: new Map(), watched: [], tails: new Map(), fsWatches: new Set(),
      skillsCache: new Map(), backoffMs: BACKOFF_MIN_MS, retryTimer: null, gen: 0, stderrWindowStart: 0, stderrCount: 0,
      masterReset: false, bridgeWatchdog: null, forwarding: null,
    };
  }

  private toStatus(h: Host): RemoteHostStatus {
    const directoryIds = this.deps.getDirectories().filter((d) => d.remote && hostKeyOf(d.remote) === h.key).map((d) => d.id);
    return {
      hostKey: h.key, state: h.state, since: h.since,
      ...(h.error ? { error: h.error } : {}),
      ...(h.hostname ? { hostname: h.hostname } : {}),
      ...(h.home ? { home: h.home } : {}),
      ...(h.claudeVersion ? { claudeVersion: h.claudeVersion } : {}),
      ...(h.nodeVersion ? { nodeVersion: h.nodeVersion } : {}),
      ...(h.bundleHash ? { bundleHash: h.bundleHash } : {}),
      bridgeForwarded: h.bridgeForwarded,
      ...(h.agentPid !== undefined ? { agentPid: h.agentPid } : {}),
      directoryIds,
    };
  }

  private emit(): void {
    try { this.deps.onHostsChanged(this.statuses()); } catch (err) {
      console.warn('[agentsflow][remote] onHostsChanged threw', { error: errMsg(err) });
    }
  }

  private setState(h: Host, state: RemoteHostState, error?: string): void {
    const changed = h.state !== state || h.error !== error;
    if (h.state !== state) h.since = new Date().toISOString();
    h.state = state;
    if (error !== undefined) h.error = oneLine(error);
    else if (state === 'ready') delete h.error;
    if (changed) console.log('[agentsflow][remote] host state', { hostKey: h.key, state, error: h.error });
    this.emit();
  }

  // Supersede whatever is in flight and connect now.
  private async restart(h: Host): Promise<void> {
    h.gen++;
    if (h.retryTimer) { clearTimeout(h.retryTimer); h.retryTimer = null; }
    this.dropChannel(h, `host ${h.key} disconnected`);
    await this.connect(h);
  }

  private async connect(h: Host): Promise<void> {
    const gen = ++h.gen;
    if (h.retryTimer) { clearTimeout(h.retryTimer); h.retryTimer = null; }
    const live = () => gen === h.gen && this.hosts.get(h.key) === h;
    this.setState(h, 'connecting');
    const { spec } = h;
    const id = this.deps.instanceId;
    try {
      // (0) A master from a previous app run (killed without stop()) outlives
      // it for ControlPersist=600 and still owns that run's forwards; sshd then
      // refuses our identical -R listen path. Start each app run on a fresh
      // master. Safe: the single-instance lock means no live app shares instanceId.
      if (!h.masterReset) {
        h.masterReset = true;
        await withTimeout(this.transport.closeMaster(spec, id).catch(() => {}), MASTER_RESET_BUDGET_MS);
        if (!live()) return;
      }
      // (1) Probe before trusting anything; this also starts the master.
      const probe = await this.transport.run(spec, id, 'echo ok', { timeoutMs: 30_000 });
      if (!live()) return;
      if (probe.code !== 0 || probe.stdout.trim() !== 'ok') {
        throw new Error(probe.timedOut ? 'ssh probe timed out' : (probe.stderr.trim() || `ssh exited ${probe.code}`));
      }
      // (2) Where things live on that machine.
      const where = await this.transport.run(spec, id, `printf '%s\\n%s\\n' "$HOME" "$(hostname)"`);
      if (!live()) return;
      const [home, hostname] = where.stdout.split('\n').map((s) => s.trim());
      if (where.code !== 0 || !home || !home.startsWith('/')) throw new Error(`could not read remote $HOME: ${where.stderr.trim() || where.stdout.trim()}`);
      h.home = home;
      h.hostname = hostname || h.hostname;
      // (3) Ship the scripts once per content hash.
      await this.ensureBundle(h, live);
      if (!live()) return;
      // (4) Delegation bridge. Not fatal: spawns retry it via ensureBridgeForward.
      await this.forwardBridge(h);
      if (!live()) return;
      // (5) Agent channel + hello.
      const bundle = `${home}/.peersflow/bundles/${h.bundleHash}`;
      const command = remoteExec.remoteCommand(spec, [spec.nodeBin, `${bundle}/electron/remote/remote-agent-script.js`], { exec: true, env: { PEERSFLOW_CLAUDE_BIN: spec.claudeBin } });
      this.openAgentChannel(h, command);
      const hello = await this.send(h, { cmd: 'hello' }, 'hello', COMMAND_TIMEOUT_MS);
      if (!live()) return;
      if (hello.t === 'hello') {
        h.hostname = hello.hostname || h.hostname;
        h.home = hello.home || h.home;
        h.agentPid = hello.pid;
        h.claudeVersion = hello.claudeVersion;
        h.nodeVersion = hello.nodeVersion;
      }
      h.backoffMs = BACKOFF_MIN_MS;
      this.setState(h, 'ready');
      this.afterReady(h);
    } catch (err) {
      if (!live()) return;
      this.dropChannel(h, `host ${h.key} disconnected`);
      this.setState(h, 'unreachable', errMsg(err));
      this.scheduleRetry(h);
    }
  }

  // (6) Replay subscriptions and refresh peer info; failures here only log,
  // the next reconnect replays again.
  private afterReady(h: Host): void {
    const warn = (what: string) => (err: unknown) => console.warn('[agentsflow][remote] ' + what + ' failed', { hostKey: h.key, error: errMsg(err) });
    this.startBridgeWatchdog(h);
    if (h.watched.length) this.sendWatch(h);
    for (const [sessionId, cwd] of h.tails) this.send(h, { cmd: 'tail', sessionId, cwd }, 'done').catch(warn('tail replay'));
    for (const dir of h.fsWatches) this.send(h, { cmd: 'fswatch', dir }, 'done').catch(warn('fswatch replay'));
    for (const d of this.deps.getDirectories()) {
      if (d.remote && hostKeyOf(d.remote) === h.key) this.peerInfo(h.key, d.path).catch(warn('peerinfo'));
    }
  }

  private sendWatch(h: Host): void {
    this.send(h, { cmd: 'watch', jobs: h.watched }, 'done').catch((err) => {
      console.warn('[agentsflow][remote] watch failed', { hostKey: h.key, error: errMsg(err) });
    });
  }

  private scheduleRetry(h: Host): void {
    if (!this.started || this.hosts.get(h.key) !== h) return;
    const delay = h.backoffMs;
    h.backoffMs = Math.min(h.backoffMs * 2, BACKOFF_MAX_MS);
    console.log('[agentsflow][remote] reconnect scheduled', { hostKey: h.key, delayMs: delay });
    h.retryTimer = setTimeout(() => {
      h.retryTimer = null;
      void this.connect(h);
    }, delay);
  }

  // Bundle hash = sha1 over the concatenated contents of BUNDLE_FILES that
  // exist locally; a dev build may not have compiled all of them yet.
  private readBundle(): { hash: string; files: { rel: string; content: Buffer }[] } {
    const hash = crypto.createHash('sha1');
    const files: { rel: string; content: Buffer }[] = [];
    for (const rel of BUNDLE_FILES) {
      try {
        const content = fs.readFileSync(path.join(this.deps.bundleRoot, rel));
        hash.update(content);
        files.push({ rel, content });
      } catch (err) {
        console.warn('[agentsflow][remote] bundle file missing, skipped', { file: rel, error: errMsg(err) });
      }
    }
    return { hash: hash.digest('hex'), files };
  }

  private async ensureBundle(h: Host, live: () => boolean): Promise<void> {
    const { hash, files } = this.readBundle();
    const dir = `${h.home}/.peersflow/bundles/${hash}`;
    const id = this.deps.instanceId;
    const check = await this.transport.run(h.spec, id, `test -f ${remoteExec.shellQuote(`${dir}/.ok`)}`);
    if (!live()) return;
    if (check.code !== 0) {
      console.log('[agentsflow][remote] uploading bundle', { hostKey: h.key, hash, files: files.length, bytes: files.reduce((n, f) => n + f.content.length, 0) });
      for (const f of files) {
        const r = await this.transport.putFile(h.spec, id, `${dir}/${f.rel}`, f.content, 0o644);
        if (!live()) return;
        if (r.code !== 0) throw new Error(`bundle upload failed (${f.rel}): ${r.stderr.trim() || `exit ${r.code}`}`);
      }
      // `.ok` last: a half-uploaded bundle is never mistaken for a complete one.
      const ok = await this.transport.putFile(h.spec, id, `${dir}/.ok`, '', 0o644);
      if (ok.code !== 0) throw new Error(`bundle upload failed (.ok): ${ok.stderr.trim() || `exit ${ok.code}`}`);
      console.log('[agentsflow][remote] bundle uploaded', { hostKey: h.key, hash });
    }
    h.bundleHash = hash;
  }

  private forwardBridge(h: Host): Promise<boolean> {
    if (!h.forwarding) {
      h.forwarding = this.forwardBridgeOnce(h).finally(() => { h.forwarding = null; });
    }
    return h.forwarding;
  }

  // cancel → rm → add → verify, twice at most. `-O forward` exiting 0 proves
  // nothing (sshd can still refuse the listen), so bridgeForwarded is set only
  // from `test -S` on the host.
  private async forwardBridgeOnce(h: Host): Promise<boolean> {
    const sock = this.bridgeSockOf(h);
    if (!sock) return false;
    const id = this.deps.instanceId;
    let lastStderr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Drop any forward this master already holds for the path, then the
        // stale file: ssh refuses to bind over an existing socket.
        await this.transport.cancelReverseForward(h.spec, id, sock, this.deps.localBridgeSock).catch(() => undefined);
        await this.transport.run(h.spec, id, `rm -f ${remoteExec.shellQuote(sock)}`);
        const r = await this.transport.addReverseForward(h.spec, id, sock, this.deps.localBridgeSock);
        lastStderr = r.stderr;
        if (await this.bridgeSockPresent(h)) {
          h.bridgeForwarded = true;
          return true;
        }
        if (!lastStderr.trim()) lastStderr = `forward exited ${r.code} but ${sock} is missing`;
      } catch (err) {
        lastStderr = errMsg(err);
      }
    }
    h.bridgeForwarded = false;
    console.warn('[agentsflow][remote] bridge forward FAILED', { hostKey: h.key, sock, stderr: oneLine(lastStderr) });
    return false;
  }

  private async bridgeSockPresent(h: Host): Promise<boolean> {
    const sock = this.bridgeSockOf(h);
    if (!sock) return false;
    try {
      const r = await this.transport.run(h.spec, this.deps.instanceId, `test -S ${remoteExec.shellQuote(sock)}`, { timeoutMs: 15_000 });
      return r.code === 0;
    } catch {
      return false;
    }
  }

  // While ready, check once a minute that the bridge socket still exists and
  // re-forward if not. At most one attempt per tick; a slow one skips ticks.
  private startBridgeWatchdog(h: Host): void {
    this.stopBridgeWatchdog(h);
    h.bridgeWatchdog = setInterval(() => {
      if (h.state !== 'ready' || h.forwarding || this.hosts.get(h.key) !== h) return;
      void (async () => {
        if (await this.bridgeSockPresent(h)) {
          if (!h.bridgeForwarded) { h.bridgeForwarded = true; this.emit(); }
          return;
        }
        if (h.state !== 'ready') return;
        console.log('[agentsflow][remote] bridge socket missing, re-forwarding', { hostKey: h.key });
        await this.forwardBridge(h);
        this.emit();
      })();
    }, BRIDGE_WATCHDOG_MS);
  }

  private stopBridgeWatchdog(h: Host): void {
    if (h.bridgeWatchdog) { clearInterval(h.bridgeWatchdog); h.bridgeWatchdog = null; }
  }

  // ---- agent channel ---------------------------------------------------------

  private openAgentChannel(h: Host, command: string): void {
    const child = this.transport.openChannel(h.spec, this.deps.instanceId, command);
    h.channel = child;
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.onLine(h, line);
      }
    });
    let errBuf = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      errBuf += chunk;
      let nl: number;
      while ((nl = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, nl).trimEnd();
        errBuf = errBuf.slice(nl + 1);
        if (line) this.stderrLine(h, line);
      }
    });
    // A dead channel's stdin throws EPIPE on write; the exit handler reports it.
    child.stdin?.on('error', () => {});
    child.on('error', (err) => this.onChannelGone(h, child, `agent channel error: ${err.message}`));
    child.on('exit', (code, signal) => this.onChannelGone(h, child, `agent channel exited (${signal ?? code})`));
  }

  private onChannelGone(h: Host, child: ChildProcess, reason: string): void {
    if (h.channel !== child) return; // superseded; its replacement owns the state
    h.channel = null;
    this.stopBridgeWatchdog(h);
    h.bridgeForwarded = false;
    h.rows = null;
    this.rejectAll(h, new Error(`host ${h.key} disconnected`));
    if (this.hosts.get(h.key) !== h || !this.started) return;
    if (h.state === 'ready') {
      // While connecting, the failing step's catch reports and schedules.
      this.setState(h, 'connecting', reason);
      this.scheduleRetry(h);
    }
  }

  private dropChannel(h: Host, reason: string): void {
    const child = h.channel;
    h.channel = null;
    h.bridgeForwarded = false;
    this.stopBridgeWatchdog(h);
    this.rejectAll(h, new Error(reason));
    if (child && channelAlive(child)) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }

  private rejectAll(h: Host, err: Error): void {
    const pending = [...h.pending.values()];
    h.pending.clear();
    for (const p of pending) { clearTimeout(p.timer); p.reject(err); }
  }

  private stderrLine(h: Host, line: string): void {
    const now = Date.now();
    if (now - h.stderrWindowStart >= 60_000) { h.stderrWindowStart = now; h.stderrCount = 0; }
    if (++h.stderrCount > STDERR_LINES_PER_MIN) return;
    console.warn(`[agentsflow][remote-agent ${h.key}]`, line.length > 500 ? line.slice(0, 500) + '…' : line);
  }

  private onLine(h: Host, line: string): void {
    let ev: AgentEvent;
    try { ev = JSON.parse(line) as AgentEvent; } catch {
      this.stderrLine(h, `unparseable stdout line (${line.length} chars)`);
      return;
    }
    if (!ev || typeof ev !== 'object' || typeof (ev as { t?: unknown }).t !== 'string') return;
    const key = h.key;
    try {
      switch (ev.t) {
        case 'agents':
          h.rows = { rows: ev.rows, at: ev.at, receivedAt: Date.now() };
          this.deps.onAgentsRows(key, ev.rows, ev.at);
          break;
        case 'job':
          h.jobs.set(ev.short, { state: ev.state, mtimeMs: ev.mtimeMs });
          this.deps.onJobState(key, ev.short, ev.state, ev.mtimeMs);
          break;
        case 'transcript':
          this.deps.onTranscript?.(key, ev.sessionId, ev.records);
          break;
        case 'fsevent':
          this.deps.onFsEvent?.(key, ev.dir);
          break;
        default:
          break;
      }
    } catch (err) {
      console.warn('[agentsflow][remote] event callback threw', { hostKey: key, event: ev.t, error: errMsg(err) });
    }
    if (!ev.id) return;
    const p = h.pending.get(ev.id);
    if (!p) return;
    h.pending.delete(ev.id);
    clearTimeout(p.timer);
    if (ev.t === 'error') p.reject(new Error(ev.message));
    else if (ev.t !== p.expect) p.reject(new Error(`unexpected reply '${ev.t}' to ${p.cmd}`));
    else p.resolve(ev);
  }

  // ---- commands ---------------------------------------------------------------

  private request(hostKey: string, body: CommandBody, expect: AgentEvent['t'], timeoutMs = COMMAND_TIMEOUT_MS): Promise<AgentEvent> {
    const h = this.hosts.get(hostKey);
    if (!h) return Promise.reject(new Error(`host ${hostKey} is unknown`));
    if (h.state !== 'ready') return Promise.reject(new Error(`host ${hostKey} is ${h.state}`));
    return this.send(h, body, expect, timeoutMs);
  }

  // Lower level than request(): no readiness gate, because `hello` must go
  // out while the host is still connecting.
  private send(h: Host, body: CommandBody, expect: AgentEvent['t'], timeoutMs = COMMAND_TIMEOUT_MS): Promise<AgentEvent> {
    const child = h.channel;
    if (!child || !child.stdin || !channelAlive(child)) return Promise.reject(new Error(`host ${h.key} disconnected`));
    const id = String(++this.seq);
    const cmd = { ...body, id } as AgentCommand;
    return new Promise<AgentEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        h.pending.delete(id);
        reject(new Error(`remote command timed out: ${body.cmd}`));
      }, timeoutMs);
      h.pending.set(id, { cmd: body.cmd, expect, resolve, reject, timer });
      child.stdin!.write(JSON.stringify(cmd) + '\n');
    });
  }

  private async teardown(h: Host): Promise<void> {
    h.gen++;
    if (h.retryTimer) { clearTimeout(h.retryTimer); h.retryTimer = null; }
    const sock = this.bridgeSockOf(h);
    // The agent dies with its channel; nothing to say to it first. The -O
    // calls below fail fast when no master ever came up, so always try them.
    this.dropChannel(h, `host ${h.key} disconnected`);
    const id = this.deps.instanceId;
    try {
      if (sock) await this.transport.cancelReverseForward(h.spec, id, sock, this.deps.localBridgeSock);
    } catch { /* best effort */ }
    try { await this.transport.closeMaster(h.spec, id); } catch { /* best effort */ }
  }
}

// Process-wide singleton so claude-cli / poller / pty-manager can route by
// hostKey without main.ts threading the instance through every call.
let current: RemoteHosts | null = null;
export function setRemoteHosts(r: RemoteHosts | null): void { current = r; }
export function getRemoteHosts(): RemoteHosts | null { return current; }
