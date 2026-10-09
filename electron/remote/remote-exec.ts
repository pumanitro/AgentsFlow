// SSH transport for remote peers. Every byte the app exchanges with a remote
// peer's machine goes through `/usr/bin/ssh` built here, never through a local
// shell: argv arrays in, one ControlMaster per host so a status tick does not
// pay a fresh handshake. The pure builders (shellQuote … ptySpec) are the one
// place remote command lines are assembled, so quoting lives in exactly one spot.
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RemotePeerSpec } from '../../shared/types';
import { hostKeyOf } from '../../shared/remote';
import { cliPath } from '../cli-environment';
import { withUtf8Locale } from '../locale';

export interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean }

// The environment ssh (and the user's ProxyCommand, run by /bin/sh) sees.
// GUI-launched Electron has neither a useful PATH nor a UTF-8 locale.
export function cliEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.PATH = cliPath();
  env.NO_COLOR = '1';
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  return withUtf8Locale(env);
}

// The ControlMaster socket. Keyed by instance too, so a second app instance
// (separate userData) never shares — or closes — the first one's master.
// Kept short under tmpdir: unix socket paths cap at ~104 bytes on macOS.
export function controlPath(spec: RemotePeerSpec, instanceId: string): string {
  const dir = path.join(os.tmpdir(), 'peersflow-ssh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = crypto.createHash('sha1').update(instanceId + '\0' + hostKeyOf(spec)).digest('hex').slice(0, 16);
  return path.join(dir, id + '.ctl');
}

export function sshArgv(spec: RemotePeerSpec, instanceId: string, opts: { before?: string[]; command?: string } = {}): string[] {
  return [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath(spec, instanceId)}`, '-o', 'ControlPersist=600',
    ...spec.sshArgs, ...(opts.before ?? []), `${spec.user}@${spec.host}`, ...(opts.command ? [opts.command] : []),
  ];
}

// POSIX single-quoting: safe for any byte string, including quotes and newlines.
export function shellQuote(s: string): string {
  if (s === '') return "''";
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

// `~` must expand on the REMOTE side, so it becomes "$HOME" and the rest is quoted.
function remotePathExpr(p: string): string {
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return '"$HOME"/' + shellQuote(p.slice(2));
  return shellQuote(p);
}

// sshd runs commands in a non-login shell: no Homebrew/~/.local PATH, often a C
// locale, and no token. This prefix makes every remote command see what a
// login would, plus the user's env file (CLAUDE_CODE_OAUTH_TOKEN lives there).
export function remoteBootstrap(spec: RemotePeerSpec): string {
  const pathPart = [...spec.extraPath.map(remotePathExpr), '"$PATH"'].join(':');
  let out = `export PATH=${pathPart}; export LANG=en_US.UTF-8 LC_CTYPE=en_US.UTF-8; `;
  if (spec.envFile) {
    const f = remotePathExpr(spec.envFile);
    out += `if [ -f ${f} ]; then set -a; . ${f}; set +a; fi; `;
  }
  return out;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function remoteCommand(spec: RemotePeerSpec, argv: string[], opts: { cwd?: string; exec?: boolean; env?: Record<string, string> } = {}): string {
  let out = remoteBootstrap(spec);
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    // A key is spliced in raw; refuse anything that is not a plain identifier.
    if (!ENV_KEY_RE.test(k)) throw new Error(`invalid env var name: ${k}`);
    out += `export ${k}=${shellQuote(v)}; `;
  }
  if (opts.cwd) out += `cd ${shellQuote(opts.cwd)} && `;
  if (opts.exec) out += 'exec ';
  return out + argv.map(shellQuote).join(' ');
}

// After `exit`, give stdio this long to drain before resolving anyway. When
// this invocation is the one that starts the ControlMaster, ssh forks the
// persistent master; it detaches stdio on current OpenSSH, but if one ever
// keeps a pipe open, `close` would never fire and every command would hang.
const CLOSE_GRACE_MS = 250;

// One ssh invocation, collected. Never rejects: spawn errors come back as
// code -1 so callers have one shape to branch on.
function runSsh(argv: string[], opts: { stdin?: string | Buffer; timeoutMs?: number } = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let timer: NodeJS.Timeout | null = null;
    let grace: NodeJS.Timeout | null = null;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve({ code, stdout, stderr, timedOut });
    };
    let child: ChildProcess;
    try {
      child = spawn('ssh', argv, { stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: cliEnv() });
    } catch (err) {
      stderr = err instanceof Error ? err.message : String(err);
      finish(-1);
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { stdout += d; });
    child.stderr?.on('data', (d: string) => { stderr += d; });
    child.on('error', (err) => {
      stderr += (stderr ? '\n' : '') + err.message;
      finish(-1);
    });
    child.on('exit', (code, signal) => {
      exitCode = code ?? (signal ? 128 : -1);
      grace = setTimeout(() => finish(exitCode ?? -1), CLOSE_GRACE_MS);
    });
    child.on('close', (code, signal) => finish(exitCode ?? code ?? (signal ? 128 : -1)));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    if (opts.stdin !== undefined && child.stdin) {
      // EPIPE when the remote side exits before reading everything; the exit
      // code already tells the story.
      child.stdin.on('error', () => {});
      child.stdin.end(opts.stdin);
    }
  });
}

export function runRemote(spec: RemotePeerSpec, instanceId: string, command: string, opts: { stdin?: string | Buffer; timeoutMs?: number } = {}): Promise<RunResult> {
  return runSsh(sshArgv(spec, instanceId, { command }), opts);
}

// The agent channel. Returned raw: the host client owns framing, restarts and
// teardown, so nothing here may add listeners that outlive its decisions.
export function openChannel(spec: RemotePeerSpec, instanceId: string, command: string): ChildProcess {
  return spawn('ssh', sshArgv(spec, instanceId, { command }), { stdio: ['pipe', 'pipe', 'pipe'], env: cliEnv() });
}

// argv for node-pty: `ssh -tt` gives the remote side a real TTY (claude attach's TUI needs one).
export function ptySpec(spec: RemotePeerSpec, instanceId: string, command: string): { bin: string; args: string[] } {
  return { bin: 'ssh', args: sshArgv(spec, instanceId, { before: ['-tt'], command }) };
}

// Control commands talk to the running master (`-O`), so they need one: the
// caller makes sure some runRemote ran first (ControlMaster=auto starts it).
function controlArgv(spec: RemotePeerSpec, instanceId: string, op: string, extra: string[] = []): string[] {
  return sshArgv(spec, instanceId, { before: ['-O', op, ...extra] });
}

// The delegation bridge: a unix socket on the remote host that tunnels back to
// the laptop's bridge. ssh refuses to bind over a stale socket file, so the
// caller removes one first.
export function addReverseForward(spec: RemotePeerSpec, instanceId: string, remoteSock: string, localSock: string): Promise<RunResult> {
  return runSsh(controlArgv(spec, instanceId, 'forward', ['-R', `${remoteSock}:${localSock}`]), { timeoutMs: 15_000 });
}

export function cancelReverseForward(spec: RemotePeerSpec, instanceId: string, remoteSock: string, localSock: string): Promise<RunResult> {
  return runSsh(controlArgv(spec, instanceId, 'cancel', ['-R', `${remoteSock}:${localSock}`]), { timeoutMs: 15_000 });
}

export async function masterAlive(spec: RemotePeerSpec, instanceId: string): Promise<boolean> {
  const r = await runSsh(controlArgv(spec, instanceId, 'check'), { timeoutMs: 10_000 });
  return r.code === 0;
}

export async function closeMaster(spec: RemotePeerSpec, instanceId: string): Promise<void> {
  await runSsh(controlArgv(spec, instanceId, 'exit'), { timeoutMs: 10_000 });
}

// Upload through the existing master: content rides stdin, so nothing user-
// controlled lands on a command line. remotePath must be absolute (no `~`):
// shellQuote keeps `$HOME` literal.
export function putFile(spec: RemotePeerSpec, instanceId: string, remotePath: string, content: Buffer | string, mode = 0o600): Promise<RunResult> {
  const dir = path.posix.dirname(remotePath);
  const q = shellQuote(remotePath);
  return runRemote(spec, instanceId, `mkdir -p ${shellQuote(dir)} && cat > ${q} && chmod ${mode.toString(8)} ${q}`, { stdin: content });
}
