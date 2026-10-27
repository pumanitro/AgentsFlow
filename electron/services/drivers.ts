// How each kind of managed service is looked at, started and stopped.
//
// process        — a program Peers Flow spawns itself (the atlas dashboard API):
//                  found by who LISTENs on its ports, started detached with its
//                  output appended to a log file, stopped TERM → KILL.
// compose        — a Docker compose project: `docker compose -p … start|stop`,
//                  or `docker start|stop <names>` when a config file is gone.
// containers     — supabase-CLI projects and loose containers, by name only.
// docker-desktop — `docker desktop start|stop`.
//
// Every external command goes through the injected `exec` with a timeout, so
// tests record each argv and nothing here ever runs synchronously. Containers
// are only ever started or stopped: never `down`, `rm`, `prune` or `docker kill`,
// and nothing here runs `ssh`.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { SERVICE_DEFAULTS } from '../../shared/services';
import type { ManagedService, ServiceKind, ServicePort, ServiceSpecCompose, ServiceSpecContainers, ServiceSpecProcess } from '../../shared/services';
import { parseDockerPsJson } from '../guard/docker-inventory';
import type { ContainerInfo, Exec, StatsRow } from '../guard/docker-inventory';
import { isActive, pathWithin } from '../guard/use-ladder';

export interface ProbeResult {
  awake: boolean; pids: number[]; cpuPct: number | null; memMB: number | null; conns: number; detail: string; runningContainers?: string[];
  /** Docker kinds only: any running container of the service passed `isActive` (cpu, network delta, open connection). */
  active?: boolean;
}
export interface Driver {
  probe(svc: ManagedService, ctx: ProbeCtx): Promise<ProbeResult>;
  start(svc: ManagedService): Promise<{ ok: boolean; error?: string }>;   // resolves when ready (health 2xx / port accepts / all containers running / `docker info` ok) or on timeout
  stop(svc: ManagedService): Promise<{ ok: boolean; error?: string }>;    // graceful then forced; resolves when gone or on timeout
}
export interface ProbeCtx { conns: Map<number, number>; dockerUp: boolean; ps: ContainerInfo[] | null; stats: StatsRow[] | null; prevStats: Map<string, StatsRow> }  // conns = parseEstablishedPorts(netstat) taken once per tick by the loop

/** How long each wait lasts. Defaults come from SERVICE_DEFAULTS; tests shrink them. */
export interface DriverTiming {
  pollMs: number; wakeTimeoutMs: number; stopGraceMs: number; stopKillMs: number;
  containersStartTimeoutMs: number; dockerStartTimeoutMs: number; dockerStopTimeoutMs: number; dockerPollMs: number;
}
export interface DriverDeps {
  exec: Exec; env: () => NodeJS.ProcessEnv; log: (msg: string, detail?: Record<string, unknown>) => void;
  spawnDetached?: (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }) => { pid: number };
  now?: () => number;
  // Additions beyond C4, all optional (tests only):
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;   // default process.kill; signal 0 = "is it alive"
  sleep?: (ms: number) => Promise<void>;
  timing?: Partial<DriverTiming>;
  fileExists?: (p: string) => boolean;
}

const DEFAULT_TIMING: DriverTiming = {
  pollMs: 500,
  wakeTimeoutMs: SERVICE_DEFAULTS.wakeTimeoutMs,
  stopGraceMs: SERVICE_DEFAULTS.stopGraceMs,
  stopKillMs: SERVICE_DEFAULTS.stopKillMs,
  containersStartTimeoutMs: 60_000,
  dockerStartTimeoutMs: SERVICE_DEFAULTS.dockerStartTimeoutMs,
  dockerStopTimeoutMs: SERVICE_DEFAULTS.dockerStopTimeoutMs,
  dockerPollMs: 2_000,
};

const PS_TIMEOUT_MS = 5_000;
const DOCKER_TIMEOUT_MS = 20_000;
const DOCKER_INFO_TIMEOUT_MS = 10_000;
const CONTAINER_START_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 2_000;

const SSH_LIKE = /(^|\/)ssh$/;

/** pgrep -q com.docker.backend AND `docker info` exits 0 (10 s timeout). */
export async function dockerDesktopUp(exec: Exec): Promise<boolean> {
  // Ask the CLI only when the backend runs — otherwise it hangs on a dead socket.
  if ((await exec('pgrep', ['-q', 'com.docker.backend'], PS_TIMEOUT_MS)) === null) return false;
  return (await exec('docker', ['info', '--format', '{{.ServerVersion}}'], DOCKER_INFO_TIMEOUT_MS)) !== null;
}

/** `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` → [pid…], excluding process.pid (the wake proxy's own listener). */
export function listeningPids(lsofOut: string): number[] {
  const out = new Set<number>();
  for (const line of (lsofOut || '').split('\n')) {
    const m = /^p(\d+)\s*$/.exec(line.trim());
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid > 1 && pid !== process.pid) out.add(pid);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/** `ps -o pid=,%cpu=,rss= -p …` → cpu summed (%), rss summed (KiB → MB). */
function parsePsUsage(text: string): { cpuPct: number; memMB: number } | null {
  let cpu = 0;
  let rssKb = 0;
  let rows = 0;
  for (const line of (text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3) continue;
    const c = Number.parseFloat(f[1]);
    const r = Number.parseFloat(f[2]);
    if (!Number.isFinite(c) || !Number.isFinite(r)) continue;
    cpu += c;
    rssKb += r;
    rows++;
  }
  return rows ? { cpuPct: cpu, memMB: rssKb / 1024 } : null;
}

/** `ps -o pid=,pgid= -p …` → pid → pgid. */
function parsePgids(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of (text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    const pid = Number(f[0]);
    const pgid = Number(f[1]);
    if (Number.isInteger(pid) && Number.isInteger(pgid) && pid > 0 && pgid > 0) out.set(pid, pgid);
  }
  return out;
}

function defaultSpawnDetached(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }): { pid: number } {
  fs.mkdirSync(path.dirname(o.logFile), { recursive: true });
  const fd = fs.openSync(o.logFile, 'a');
  try {
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env,
      // detached + unref: the service must outlive Electron, and its own group lets a stop reach its children.
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.on('error', (error: Error) => console.warn(`[agentsflow][services] ${cmd} failed to start: ${error.message}`));
    child.unref();
    if (!child.pid) throw new Error(`${cmd} did not produce a process`);
    return { pid: child.pid };
  } finally {
    fs.closeSync(fd);
  }
}

function httpOk(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let req: http.ClientRequest;
    try {
      req = http.get(url, { timeout: HEALTH_TIMEOUT_MS }, (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
      });
    } catch {
      resolve(false);
      return;
    }
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => { s.destroy(); resolve(ok); };
    s.setTimeout(HEALTH_TIMEOUT_MS, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function sumConns(ports: ServicePort[], conns: Map<number, number>): number {
  return ports.reduce((n, p) => n + (conns.get(p.port) ?? 0), 0);
}

export function createDrivers(d: DriverDeps): Record<ServiceKind, Driver> {
  const t: DriverTiming = { ...DEFAULT_TIMING, ...(d.timing ?? {}) };
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => { const h = setTimeout(r, ms); h.unref?.(); }));
  const kill = d.kill ?? ((pid: number, sig: NodeJS.Signals | 0) => { process.kill(pid, sig); });
  const spawnDetached = d.spawnDetached ?? defaultSpawnDetached;
  const fileExists = d.fileExists ?? fs.existsSync;
  // Process groups this session spawned: a stop signals the whole group, so
  // children of a wrapper (npm, tsx) go too. Anything else gets its own pid only.
  const ourGroups = new Set<number>();

  function alive(pid: number): boolean {
    try { kill(pid, 0); return true; } catch { return false; }
  }

  /** Polls `fn` every `every` ms until it is true or `timeoutMs` has passed. */
  async function until(fn: () => Promise<boolean>, timeoutMs: number, every: number): Promise<boolean> {
    const deadline = now() + timeoutMs;
    for (;;) {
      if (await fn()) return true;
      if (now() >= deadline) return false;
      await sleep(every);
    }
  }

  // ---- process -----------------------------------------------------------

  async function pidsOn(ports: ServicePort[]): Promise<number[]> {
    const all = new Set<number>();
    for (const p of ports) {
      // lsof exits 1 when nothing listens → null → no pids.
      const out = await d.exec('lsof', ['-nP', `-iTCP:${p.port}`, '-sTCP:LISTEN', '-Fp'], PS_TIMEOUT_MS);
      for (const pid of listeningPids(out ?? '')) all.add(pid);
    }
    return Array.from(all).sort((a, b) => a - b);
  }

  /** Listening pids, or — for a service with no ports — the groups we spawned that still live. */
  async function processPids(svc: ManagedService): Promise<number[]> {
    if (svc.ports.length) return pidsOn(svc.ports);
    return Array.from(ourGroups).filter(alive);
  }

  function refuse(spec: ServiceSpecProcess): string | null {
    if (SSH_LIKE.test(spec.cmd.trim())) return `refused: ${spec.cmd} is not something Peers Flow starts`;
    if (!path.isAbsolute(spec.cwd) || !pathWithin(spec.cwd, os.homedir())) return `refused: ${spec.cwd} is outside the home folder`;
    return null;
  }

  async function processReady(svc: ManagedService, spec: ServiceSpecProcess): Promise<boolean> {
    if (spec.health) return httpOk(spec.health);
    if (!svc.ports.length) return true;
    for (const p of svc.ports) if (!(await portAccepts(p.port))) return false;
    return true;
  }

  const processDriver: Driver = {
    async probe(svc, ctx) {
      const pids = await processPids(svc);
      const conns = sumConns(svc.ports, ctx.conns);
      if (!pids.length) return { awake: false, pids, cpuPct: null, memMB: null, conns, detail: 'not running' };
      const usage = parsePsUsage((await d.exec('ps', ['-o', 'pid=,%cpu=,rss=', '-p', pids.join(',')], PS_TIMEOUT_MS)) ?? '');
      const portsText = svc.ports.map((p) => `:${p.port}`).join(' ');
      return {
        awake: true, pids, conns,
        cpuPct: usage ? usage.cpuPct : null,
        memMB: usage ? usage.memMB : null,
        detail: `running as pid ${pids.join(', ')}${portsText ? ` on ${portsText}` : ''}${conns ? `, ${conns} open connection${conns === 1 ? '' : 's'}` : ''}`,
      };
    },

    async start(svc) {
      if (svc.spec.kind !== 'process') return { ok: false, error: `not a process service: ${svc.id}` };
      const spec = svc.spec;
      const why = refuse(spec);
      if (why) return { ok: false, error: why };
      if ((await processPids(svc)).length && (await processReady(svc, spec))) return { ok: true };

      let pid: number;
      try {
        pid = spawnDetached(spec.cmd, spec.args, { cwd: spec.cwd, env: { ...d.env(), ...(spec.env ?? {}) }, logFile: spec.logFile }).pid;
      } catch (error) {
        return { ok: false, error: `could not start ${spec.cmd}: ${(error as Error).message}` };
      }
      ourGroups.add(pid);
      d.log(`started ${svc.id} as pid ${pid}`, { cmd: spec.cmd, cwd: spec.cwd });

      let exited = false;
      const ready = await until(async () => {
        if (!alive(pid)) { exited = true; return true; }
        return processReady(svc, spec);
      }, t.wakeTimeoutMs, t.pollMs);
      if (exited) {
        ourGroups.delete(pid);
        return { ok: false, error: `${spec.cmd} exited before it was ready — see ${spec.logFile}` };
      }
      if (!ready) return { ok: false, error: `not ready after ${Math.round(t.wakeTimeoutMs / 1000)} s — see ${spec.logFile}` };
      return { ok: true };
    },

    async stop(svc) {
      const pids = await processPids(svc);
      if (!pids.length) return { ok: true };
      const pgids = parsePgids((await d.exec('ps', ['-o', 'pid=,pgid=', '-p', pids.join(',')], PS_TIMEOUT_MS)) ?? '');
      // A pid in a group we spawned → signal the group; otherwise the pid alone.
      const targets = new Set<number>();
      for (const pid of pids) {
        const g = pgids.get(pid);
        targets.add(g && ourGroups.has(g) ? -g : pid);
      }
      const signal = (sig: NodeJS.Signals): void => {
        for (const target of targets) {
          if (Math.abs(target) <= 1 || Math.abs(target) === process.pid) continue;
          try { kill(target, sig); } catch { /* already gone */ }
        }
      };
      const gone = async (): Promise<boolean> => (await processPids(svc)).length === 0;

      signal('SIGTERM');
      if (await until(gone, t.stopGraceMs, t.pollMs)) return { ok: true };
      d.log(`${svc.id} ignored SIGTERM for ${Math.round(t.stopGraceMs / 1000)} s — SIGKILL`, { targets: Array.from(targets) });
      signal('SIGKILL');
      if (await until(gone, t.stopKillMs, t.pollMs)) return { ok: true };
      return { ok: false, error: `still running after SIGKILL (pid ${(await processPids(svc)).join(', ')})` };
    },
  };

  // ---- compose / containers ----------------------------------------------

  function containerProbe(svc: ManagedService, names: string[], ctx: ProbeCtx): ProbeResult {
    const conns = sumConns(svc.ports, ctx.conns);
    if (!ctx.dockerUp || !ctx.ps) return { awake: false, pids: [], cpuPct: null, memMB: null, conns, detail: 'Docker is off', runningContainers: [], active: false };
    const wanted = new Set(names);
    const running = ctx.ps.filter((c) => wanted.has(c.name) && c.running).map((c) => c.name);
    if (!running.length) return { awake: false, pids: [], cpuPct: null, memMB: null, conns, detail: 'all containers stopped', runningContainers: [], active: false };
    let cpu: number | null = null;
    let mem: number | null = null;
    let active = conns > 0;
    for (const n of running) {
      const cur = ctx.stats?.find((s) => s.name === n) ?? null;
      if (cur) { cpu = (cpu ?? 0) + cur.cpuPct; mem = (mem ?? 0) + cur.memMB; }
      if (isActive(ctx.prevStats.get(n) ?? null, cur, 0)) active = true;
    }
    return {
      awake: true, pids: [], cpuPct: cpu, memMB: mem, conns, runningContainers: running, active,
      detail: `${running.length} of ${names.length} container${names.length === 1 ? '' : 's'} running${active ? ', busy' : ''}`,
    };
  }

  /** `docker compose -p P -f a -f b` when every config file exists; null = fall back to names. */
  function composeBase(spec: ServiceSpecCompose): string[] | null {
    if (!spec.configFiles.length || !spec.configFiles.every((f) => fileExists(f))) return null;
    return ['compose', '-p', spec.project, ...spec.configFiles.flatMap((f) => ['-f', f])];
  }

  async function runningOf(names: string[]): Promise<Set<string> | null> {
    const out = await d.exec('docker', ['ps', '-a', '--format', '{{json .}}'], DOCKER_TIMEOUT_MS);
    if (out === null) return null;
    return new Set(parseDockerPsJson(out).filter((c) => c.running && names.includes(c.name)).map((c) => c.name));
  }

  function containerDriver(argv: (spec: ServiceSpecCompose | ServiceSpecContainers, verb: 'start' | 'stop') => string[]): Driver {
    const specOf = (svc: ManagedService): ServiceSpecCompose | ServiceSpecContainers | null =>
      svc.spec.kind === 'compose' || svc.spec.kind === 'containers' ? svc.spec : null;
    return {
      async probe(svc, ctx) {
        const spec = specOf(svc);
        return containerProbe(svc, spec ? spec.containers : [], ctx);
      },
      async start(svc) {
        const spec = specOf(svc);
        if (!spec) return { ok: false, error: `not a Docker service: ${svc.id}` };
        if (!spec.containers.length) return { ok: false, error: 'no containers known for this project yet' };
        const out = await d.exec('docker', argv(spec, 'start'), CONTAINER_START_TIMEOUT_MS);
        if (out === null) return { ok: false, error: `docker ${argv(spec, 'start').join(' ')} failed` };
        let last: Set<string> | null = null;
        await until(async () => {
          last = await runningOf(spec.containers);
          return !!last && last.size === spec.containers.length;
        }, t.containersStartTimeoutMs, t.pollMs);
        const up: Set<string> = last ?? new Set();
        const down = spec.containers.filter((n) => !up.has(n));
        // Started is started: a container that exits again by itself is reported, not retried.
        if (down.length) d.log(`${svc.id} started, but not running: ${down.join(', ')}`);
        return down.length ? { ok: true, error: `not running after start: ${down.join(', ')}` } : { ok: true };
      },
      async stop(svc) {
        const spec = specOf(svc);
        if (!spec) return { ok: false, error: `not a Docker service: ${svc.id}` };
        if (!spec.containers.length) return { ok: true };
        const out = await d.exec('docker', argv(spec, 'stop'), (SERVICE_DEFAULTS.composeStopSeconds + 30) * 1000);
        return out === null ? { ok: false, error: `docker ${argv(spec, 'stop').join(' ')} failed` } : { ok: true };
      },
    };
  }

  const stopFlags = ['-t', String(SERVICE_DEFAULTS.composeStopSeconds)];
  const byNames = (names: string[], verb: 'start' | 'stop'): string[] => (verb === 'stop' ? ['stop', ...stopFlags, ...names] : ['start', ...names]);

  const composeDriver = containerDriver((spec, verb) => {
    const base = spec.kind === 'compose' ? composeBase(spec) : null;
    if (!base) return byNames(spec.containers, verb);
    return verb === 'stop' ? [...base, 'stop', ...stopFlags] : [...base, 'start'];
  });
  const containersDriver = containerDriver((spec, verb) => byNames(spec.containers, verb));

  // ---- docker-desktop ----------------------------------------------------

  const dockerDriver: Driver = {
    async probe(_svc, ctx) {
      // The loop asks dockerDesktopUp once per tick; no second round of commands here.
      const up = ctx.dockerUp;
      const running = up && ctx.ps ? ctx.ps.filter((c) => c.running).map((c) => c.name) : [];
      return {
        awake: up, pids: [], cpuPct: null, memMB: null, conns: 0, runningContainers: running,
        detail: up ? `running, ${running.length} container${running.length === 1 ? '' : 's'} up` : 'off',
      };
    },
    async start() {
      if (await dockerDesktopUp(d.exec)) return { ok: true };
      // The command may return before the engine answers; `docker info` is the real gate.
      const out = await d.exec('docker', ['desktop', 'start'], t.dockerStartTimeoutMs);
      if (out === null) d.log('docker desktop start returned an error — waiting for the engine anyway');
      if (await until(() => dockerDesktopUp(d.exec), t.dockerStartTimeoutMs, t.dockerPollMs)) return { ok: true };
      return { ok: false, error: `Docker Desktop did not come up within ${Math.round(t.dockerStartTimeoutMs / 1000)} s` };
    },
    async stop() {
      const backend = async (): Promise<boolean> => (await d.exec('pgrep', ['-q', 'com.docker.backend'], PS_TIMEOUT_MS)) !== null;
      if (!(await backend())) return { ok: true };
      const out = await d.exec('docker', ['desktop', 'stop'], t.dockerStopTimeoutMs);
      if (out === null) d.log('docker desktop stop returned an error — waiting for the backend to go anyway');
      if (await until(async () => !(await backend()), t.dockerStopTimeoutMs, t.dockerPollMs)) return { ok: true };
      return { ok: false, error: `Docker Desktop still running after ${Math.round(t.dockerStopTimeoutMs / 1000)} s` };
    },
  };

  return { process: processDriver, compose: composeDriver, containers: containersDriver, 'docker-desktop': dockerDriver };
}
