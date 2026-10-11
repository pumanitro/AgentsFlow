import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentEnvironment } from './cli-environment';
import { pinCodexCli, pinnedCodexCli } from './codex-cli';
import { CODEX_DEFAULT_APPROVAL_POLICY, CODEX_DEFAULT_SANDBOX } from './codex-permissions';
import { WsClient } from './ws-client';

// Where the Codex app-server runs, and who owns it.
//
// The app used to spawn `codex app-server --stdio` as an Electron child, so
// every Codex thread died with the app. The daemon model instead puts the
// server behind a unix socket that outlives us: it keeps executing turns with
// zero subscribers, and a later run of the app — or a `codex resume --remote`
// in a terminal — reconnects to the same threads.
//
// We host it ourselves rather than using `codex app-server daemon start`. That
// command only works on the standalone installer's fixed binary path and fails
// outright on an npm/nvm install, which is how most people have Codex. Owning
// the process also means the socket is ours: the ChatGPT desktop app and the
// IDE extension share the managed daemon, and a `daemon restart` by any of them
// would drop every one of our threads.

/** `<userData>/codex` — holds the socket, the pidfile and the server log. */
export function codexServerDir(userData: string): string {
  return path.join(userData, 'codex');
}

/** The socket both this app and `codex resume --remote unix://…` dial. */
export function codexSocketPath(userData: string): string {
  return path.join(codexServerDir(userData), 'app-server.sock');
}

export function codexPidPath(userData: string): string {
  return path.join(codexServerDir(userData), 'app-server.pid');
}

export function codexLogPath(userData: string): string {
  return path.join(codexServerDir(userData), 'app-server.log');
}

export const CLIENT_INFO = { name: 'peers_flow', title: 'Peers Flow', version: '10.1.0' };
/** Shared by the liveness probe and by `CodexRpc`, so both introduce the same client. */
export const INITIALIZE_PARAMS = { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } };

/** How long a single liveness probe waits for the `initialize` reply. */
const PROBE_TIMEOUT_MS = 3_000;
/** How long a freshly spawned server gets to start accepting connections. */
const READY_TIMEOUT_MS = 15_000;

export interface EnsureCodexServerOptions {
  /** Electron's `userData` directory. Pass it explicitly; there is no good default here. */
  userData: string;
  /** Extra environment for a newly spawned server, merged over `agentEnvironment()`. */
  env?: NodeJS.ProcessEnv;
}

export interface CodexServerHandle {
  socketPath: string;
  /** The pid we spawned, or the one recorded in the pidfile. 0 when unknown. */
  pid: number;
  /** True when this call spawned the server, false when an existing one was reused. */
  started: boolean;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function readCodexPid(userData: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(codexPidPath(userData), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

/**
 * Does this `ps` command line belong to an app-server listening on our socket?
 * Extracted so the ownership rule is testable without a live process: nothing
 * is ever signalled unless this returns true.
 */
export function describesOurServer(command: string, socketPath: string): boolean {
  if (!command) return false;
  return command.includes('app-server') && command.includes(`unix://${socketPath}`);
}

function ownsProcess(pid: number, socketPath: string): boolean {
  let command = '';
  try { command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); }
  catch { return false; }
  return describesOurServer(command.trim(), socketPath);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * One WebSocket handshake plus one `initialize` round trip. A socket file that
 * merely exists proves nothing — a crashed server leaves one behind — so
 * liveness is always "did it answer", never "is the file there".
 */
export async function probeCodexServer(socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return (await probeCodexServerVersion(socketPath, timeoutMs)) !== null;
}

/**
 * The same probe, returning which Codex answered: '' when it did not say, null
 * when nothing answered. `initialize` replies with a user agent that leads with
 * `<client name>/<codex version>`, and that — not a file this app wrote — is
 * the ground truth for what a long-running server is.
 */
export async function probeCodexServerVersion(socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
  let client: WsClient;
  try { client = await WsClient.connect({ path: socketPath, timeoutMs }); }
  catch { return null; }
  try {
    const result = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('initialize timed out')), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const settle = (error?: Error, value?: Record<string, unknown>) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      client.on('error', (error: Error) => settle(error));
      client.on('close', () => settle(new Error('socket closed during initialize')));
      client.on('message', (text: string) => {
        try {
          const message = JSON.parse(text);
          if (message.id !== 1 || message.method) return;
          settle(message.error ? new Error(String(message.error.message ?? 'initialize failed')) : undefined, message.result);
        } catch { /* not our reply */ }
      });
      client.send(JSON.stringify({ id: 1, method: 'initialize', params: INITIALIZE_PARAMS }));
    });
    return codexVersionOf(String(result?.userAgent ?? ''));
  } catch {
    return null;
  } finally {
    try { client.close(); } catch { /* already gone */ }
  }
}

/** `peers_flow/0.154.0 (Mac OS …) …` → `0.154.0`; '' when the agent string has no version. */
export function codexVersionOf(userAgent: string): string {
  return /^[^/\s]+\/(\d+\.\d+\.\d+[^\s]*)/.exec(userAgent)?.[1] ?? '';
}

// Two callers racing to ensure the same socket must not spawn two servers.
const inflight = new Map<string, Promise<CodexServerHandle>>();

/**
 * Reuse the running app-server, or spawn a detached one and wait for it.
 * Resolves only once the socket actually answers `initialize`.
 */
export function ensureCodexServer(options: EnsureCodexServerOptions): Promise<CodexServerHandle> {
  const socketPath = codexSocketPath(options.userData);
  const running = inflight.get(socketPath);
  if (running) return running;
  const attempt = ensure(options, socketPath).finally(() => {
    if (inflight.get(socketPath) === attempt) inflight.delete(socketPath);
  });
  inflight.set(socketPath, attempt);
  return attempt;
}

async function ensure(options: EnsureCodexServerOptions, socketPath: string): Promise<CodexServerHandle> {
  const { userData } = options;
  fs.mkdirSync(codexServerDir(userData), { recursive: true });

  if (await probeCodexServer(socketPath)) {
    // A server from before CLI pinning has no record of what it runs. Adopt it
    // now, while the install is known good, not at the first chat opened after
    // an update has already replaced it.
    void pinnedCodexCli(codexServerDir(userData)).catch((error: Error) =>
      console.warn('[agentsflow][codex-cli] cannot pin a CLI for the running app-server', error.message));
    return { socketPath, pid: readCodexPid(userData) ?? 0, started: false };
  }

  // Nothing answered, so any socket file left here is a corpse. `bind` on an
  // existing path fails with EADDRINUSE, so the server cannot start without this.
  try { fs.unlinkSync(socketPath); } catch { /* nothing to remove */ }

  // Pinned, not `codex` on PATH: see codex-cli.ts. Throws a reinstall hint when
  // neither the global install nor a kept snapshot runs.
  const cli = await pinCodexCli(codexServerDir(userData));
  const logFd = fs.openSync(codexLogPath(userData), 'a');
  let spawnError: Error | null = null;
  let exitedWith: string | null = null;
  let pid = 0;
  try {
    const child = spawn(
      cli.bin,
      ['app-server', '--listen', `unix://${socketPath}`,
        '-c', `approval_policy="${CODEX_DEFAULT_APPROVAL_POLICY}"`,
        '-c', `sandbox_mode="${CODEX_DEFAULT_SANDBOX}"`],
      {
        // detached + unref is the whole point: the server must outlive Electron.
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...agentEnvironment(), ...(options.env ?? {}) },
      },
    );
    child.on('error', (error: Error) => { spawnError = error; });
    child.on('exit', (code, signal) => { exitedWith = signal ? `signal ${signal}` : `code ${code}`; });
    child.unref();
    pid = child.pid ?? 0;
  } finally {
    fs.closeSync(logFd);
  }

  if (!pid) {
    throw new Error(`Cannot start Codex app-server: ${cli.bin} did not produce a process. Check CODEX_BIN or your Codex CLI installation.`);
  }
  fs.writeFileSync(codexPidPath(userData), `${pid}\n`, 'utf8');

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (spawnError) {
      throw new Error(`Cannot start Codex app-server: ${(spawnError as Error).message}. Check CODEX_BIN or your Codex CLI installation.`);
    }
    if (await probeCodexServer(socketPath, 1_500)) return { socketPath, pid, started: true };
    if (exitedWith) {
      throw new Error(`Codex app-server exited immediately (${exitedWith}). See ${codexLogPath(userData)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Codex app-server did not accept connections on ${socketPath} within ${READY_TIMEOUT_MS / 1000}s. See ${codexLogPath(userData)}`);
    }
    await delay(200);
  }
}

/**
 * Stop the server this app started, and only that one. The pid has to be in our
 * pidfile AND `ps` has to agree it is an app-server on our socket, so a recycled
 * pid cannot cost somebody else their process.
 */
export async function stopCodexServer(userData: string): Promise<void> {
  const socketPath = codexSocketPath(userData);
  const pid = readCodexPid(userData);
  if (pid && ownsProcess(pid, socketPath)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 50 && alive(pid); i++) await delay(100);
  }
  try { fs.unlinkSync(codexPidPath(userData)); } catch { /* nothing to remove */ }
  try { fs.unlinkSync(socketPath); } catch { /* nothing to remove */ }
}
