// Repair of the local network link a remote peer's ssh rides on. A peer whose
// ProxyCommand goes through a userspace Tailscale daemon (`tailscale
// --socket=… nc %h %p`) is dead in the water when that daemon is not running
// (it does not survive a reboot unless something starts it), and ssh then only
// says "Could not resolve hostname". Here the app notices that case, starts the
// daemon itself, and otherwise says in plain words what is wrong.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { RemotePeerSpec } from '../../shared/types';
import { cliEnv } from './remote-exec';

export interface TailscaleLink { bin: string; socket: string }

export interface LinkRepair {
  // The link was down and is up now: the caller should try ssh again.
  repaired: boolean;
  // What is wrong, for the user, when the link is down and could not be fixed.
  note?: string;
}

const SOCKET_PROBE_MS = 1_500;
const DAEMON_START_WAIT_MS = 12_000;
// Something else may own the daemon (a launchd agent restarts it within about
// ten seconds). Give it that long to come back before starting a second copy.
const SELF_RECOVERY_WAIT_MS = 12_000;

// The Tailscale CLI and daemon socket named by the peer's ProxyCommand, or
// null when the peer does not go through a userspace Tailscale daemon.
export function tailscaleLink(spec: Pick<RemotePeerSpec, 'sshArgs'>): TailscaleLink | null {
  for (const arg of spec.sshArgs) {
    const m = /^ProxyCommand=(.*)$/s.exec(arg);
    if (!m) continue;
    const words = m[1].trim().split(/\s+/);
    const bin = words[0] ?? '';
    if (path.basename(bin) !== 'tailscale' || !path.isAbsolute(bin)) continue;
    const sock = words.find((w) => w.startsWith('--socket='))?.slice('--socket='.length);
    if (sock && path.isAbsolute(sock)) return { bin, socket: sock };
  }
  return null;
}

// How to start the daemon behind a link: its binary sits beside the CLI and
// its state lives beside the socket.
export function daemonCommand(link: TailscaleLink): { bin: string; args: string[]; stateDir: string } {
  const stateDir = path.dirname(link.socket);
  return {
    bin: path.join(path.dirname(link.bin), 'tailscaled'),
    args: ['--tun=userspace-networking', `--statedir=${stateDir}`, `--socket=${link.socket}`],
    stateDir,
  };
}

export function socketAlive(socketPath: string, timeoutMs = SOCKET_PROBE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export interface LinkRepairDeps {
  alive: (socketPath: string) => Promise<boolean>;
  exists: (p: string) => boolean;
  // Starts the daemon detached; throws when it cannot be launched.
  start: (cmd: { bin: string; args: string[]; stateDir: string }) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const realDeps: LinkRepairDeps = {
  alive: socketAlive,
  exists: fs.existsSync,
  start: (cmd) => {
    const log = fs.openSync(path.join(cmd.stateDir, 'tailscaled.log'), 'a');
    try {
      const child = spawn(cmd.bin, cmd.args, { detached: true, stdio: ['ignore', log, log], env: cliEnv() });
      child.on('error', (err) => console.warn('[agentsflow][remote] tailscaled failed to start', { error: err.message }));
      child.unref();
    } finally {
      fs.closeSync(log);
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
};

// Called after an ssh probe failed. Never throws.
export async function repairLink(spec: Pick<RemotePeerSpec, 'sshArgs'>, deps: LinkRepairDeps = realDeps): Promise<LinkRepair> {
  const link = tailscaleLink(spec);
  if (!link) return { repaired: false };
  if (await deps.alive(link.socket)) return { repaired: false }; // Tailscale is up: the failure is ssh's own.
  const cmd = daemonCommand(link);
  // Only restart a daemon that has run here before: its saved login is what
  // lets it come back without the user signing in again.
  if (!deps.exists(cmd.bin) || !deps.exists(path.join(cmd.stateDir, 'tailscaled.state'))) {
    return { repaired: false, note: 'Tailscale is not running on this Mac' };
  }
  const waitAlive = async (ms: number): Promise<boolean> => {
    const deadline = deps.now() + ms;
    while (deps.now() < deadline) {
      await deps.sleep(500);
      if (await deps.alive(link.socket)) return true;
    }
    return false;
  };
  if (await waitAlive(SELF_RECOVERY_WAIT_MS)) return { repaired: true };
  try {
    console.log('[agentsflow][remote] tailscale daemon is down, starting it', { socket: link.socket });
    deps.start(cmd);
  } catch (err) {
    return { repaired: false, note: `Tailscale is not running on this Mac and could not be started (${err instanceof Error ? err.message : String(err)})` };
  }
  if (await waitAlive(DAEMON_START_WAIT_MS)) return { repaired: true };
  return { repaired: false, note: 'Tailscale is not running on this Mac and did not come up after being started' };
}
