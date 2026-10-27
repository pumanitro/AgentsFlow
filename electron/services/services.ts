// Sleeping services: the loop that puts unused services to sleep and wakes them.
//
// Every SERVICES_TICK_MS it reads the registry (services.json, late — a hand
// edit takes effect on the very next tick), asks whether Docker Desktop is up,
// takes the Docker inventory and one `netstat`, probes every service through its
// driver (drivers.ts), stamps "last used" for whatever is busy right now and
// gives each one a verdict (use.ts). In `live` mode it then:
//   - under memory pressure (the memory guard's level is warn|closed|critical)
//     puts exactly ONE service to sleep early — the least recently used one that
//     has been unused for the pressure floor (30 min);
//   - puts at most SERVICE_DEFAULTS.maxSleepsPerTick services to sleep in all,
//     oldest idle first;
//   - keeps the wake proxy (wake-proxy.ts) listening on the ports of every
//     sleeping service, so the first request wakes it;
//   - stops Docker Desktop once no container has run for its idle limit (15 min)
//     and nothing unmanaged runs in it.
// In `watch` mode it computes and shows all of that and does none of it.
//
// Sleeping and waking are serialised per service: one operation in flight at a
// time, a second request for the same thing joins the first. Clocks (last used,
// slept, woken, Docker quiet since) persist in services-state.json, so an app
// restart does not reset "used 3 h ago". Nothing is ever done to a service that
// is not in the registry, and nothing here is synchronous (execFile only).

import { execFile } from 'child_process';
import {
  MEM_PRESSURE_LEVELS, SERVICE_DEFAULTS,
  type ManagedService, type ServiceActionResult, type ServiceKind, type ServiceLogBy, type ServiceLogEntry, type ServiceLogEvent,
  type ServiceRow, type ServiceState, type ServicesMode, type ServicesRegistryFile, type ServicesSnapshot, type ServicesStateFile,
} from '../../shared/services';
import type { MemLevel } from '../../shared/types';
import { parseDockerPsJson, parseEstablishedPorts, parseStatsRows, STATS_FORMAT } from '../guard/docker-inventory';
import type { ContainerInfo, Exec, StatsRow } from '../guard/docker-inventory';
import { collectDockerDiscovery } from './discovery';
import { createDrivers, dockerDesktopUp } from './drivers';
import type { Driver, ProbeCtx, ProbeResult } from './drivers';
import { mergeDiscovered, readRegistry, writeRegistry } from './registry';
import { appendServiceLog, readServiceLogTail } from './services-log';
import { emptyState, readState, writeState } from './state';
import { fmtMinutes, pressureQueue, processActive, serviceVerdict } from './use';
import type { UseVerdict } from './use';
import { createWakeProxy } from './wake-proxy';
import type { WakeProxy } from './wake-proxy';

export interface ServicesDeps {
  files: { registry: string; state: string; log: string };
  notify: (t: string, b: string) => void;
  onSnapshot: (s: ServicesSnapshot) => void;
  exec?: Exec; env?: () => NodeJS.ProcessEnv; now?: () => number;
  drivers?: Record<ServiceKind, Driver>; proxy?: WakeProxy; seed?: () => ManagedService[];
  /** The memory guard's level and the containers it has already noticed for stopping. Default: unknown, none. */
  guard?: () => { level: MemLevel; stopping: string[] };
}

export const SERVICES_TICK_MS = 60_000;

const FIRST_TICK_DELAY_MS = 5_000;
const DISCOVER_EVERY_TICKS = 5;
const PS_TIMEOUT_MS = 5_000;
const DOCKER_TIMEOUT_MS = 20_000;
const LOG_PREFIX = '[agentsflow][services]';

/** The default exec: async, bounded, null on any failure. An empty stdout is a success (`pgrep -q`). */
const defaultExec: Exec = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs }, (err, stdout) => {
        resolve(err ? null : String(stdout ?? ''));
      });
    } catch {
      resolve(null);
    }
  });

const isDockerKind = (k: ServiceKind): k is 'compose' | 'containers' => k === 'compose' || k === 'containers';
const containersOf = (s: ManagedService): string[] => (s.spec.kind === 'compose' || s.spec.kind === 'containers' ? s.spec.containers : []);
const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const portsText = (ports: number[]): string => ports.map((p) => `:${p}`).join(', ');

type OpKind = 'waking' | 'sleeping';
interface Op { kind: OpKind; p: Promise<ServiceActionResult> }
interface Judged { svc: ManagedService; probe: ProbeResult | undefined; state: ServiceState; v: UseVerdict; row: ServiceRow; clock: number }

// ── loop state (module-level, like the guard) ─────────────────────────────

let deps: ServicesDeps | null = null;
let timer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
let inflight = false;
let tick = 0;
let proxy: WakeProxy | null = null;
let drivers: Record<ServiceKind, Driver> | null = null;
let registry: ServicesRegistryFile | null = null;
let state: ServicesStateFile | null = null;
let dockerUp: boolean | null = null;
let dockerOp: 'starting' | 'stopping' | null = null;
let prevStats = new Map<string, StatsRow>();
let pressureNotified = false;
let memory: ServicesSnapshot['memory'] = { level: 'unknown', pressure: false, queue: [] };
let snapshot: ServicesSnapshot | null = null;
const probes = new Map<string, ProbeResult>();
// id → when this process first saw it awake (or last woke it): the 30-min observation window
const observed = new Map<string, number>();
const ops = new Map<string, Op>();
// id → operations finished; a probe that straddles one is stale and dropped
const opEpoch = new Map<string, number>();
// id → last logged arm outcome, so a port that stays taken is logged once, not every tick
const armLogged = new Map<string, string>();

function log(msg: string, detail?: Record<string, unknown>): void {
  if (detail) console.log(`${LOG_PREFIX} ${msg}`, detail);
  else console.log(`${LOG_PREFIX} ${msg}`);
}

function nowMs(): number {
  return deps?.now?.() ?? Date.now();
}
function execOf(): Exec {
  return deps?.exec ?? defaultExec;
}
function guardOf(): { level: MemLevel; stopping: string[] } {
  try {
    return deps?.guard?.() ?? { level: 'unknown', stopping: [] };
  } catch {
    return { level: 'unknown', stopping: [] };
  }
}

function init(d: ServicesDeps): void {
  deps = d;
  if (!state) state = readState(d.files.state);
  if (!drivers) drivers = d.drivers ?? createDrivers({ exec: execOf(), env: d.env ?? (() => process.env), log, now: d.now });
  if (!proxy) {
    proxy = d.proxy ?? createWakeProxy({
      onWake: async (id) => (await wakeService(id, 'request')).ok,
      log,
      holdMs: SERVICE_DEFAULTS.holdMs,
    });
  }
}

function currentRegistry(): ServicesRegistryFile {
  if (!registry && deps) registry = readRegistry(deps.files.registry, deps.seed);
  return registry ?? { version: 1, mode: 'live', services: [] };
}

function saveRegistry(r: ServicesRegistryFile): void {
  registry = r;
  if (!deps) return;
  try {
    writeRegistry(r, deps.files.registry);
  } catch (err) {
    console.warn(`${LOG_PREFIX} could not write the registry`, { error: String(err) });
  }
}

function saveState(): void {
  if (!deps || !state) return;
  try {
    writeState(state, deps.files.state);
  } catch (err) {
    console.warn(`${LOG_PREFIX} could not write the state file`, { error: String(err) });
  }
}

function logEvent(svc: { id: string; name: string }, event: ServiceLogEvent, by: ServiceLogBy, detail: string): void {
  const e: ServiceLogEntry = { at: new Date(nowMs()).toISOString(), id: svc.id, name: svc.name, event, by, detail };
  log(`${event} ${svc.id} (${by})${detail ? `: ${detail}` : ''}`);
  if (!deps) return;
  try {
    appendServiceLog(e, deps.files.log);
  } catch (err) {
    console.warn(`${LOG_PREFIX} could not append to the services log`, { error: String(err) });
  }
}

function notify(title: string, body: string): void {
  try {
    deps?.notify(title, body);
  } catch {
    /* a notification must never break the loop */
  }
}

// ── verdicts and rows ─────────────────────────────────────────────────────

function opOf(id: string, kind: ServiceKind): OpKind | null {
  if (kind === 'docker-desktop' && dockerOp) return dockerOp === 'starting' ? 'waking' : 'sleeping';
  return ops.get(id)?.kind ?? null;
}

function judgeAll(now: number): Judged[] {
  const reg = currentRegistry();
  const st = state ?? emptyState();
  const g = guardOf();
  const pressure = MEM_PRESSURE_LEVELS.includes(g.level);
  const pressureIdleMinutes = reg.pressureIdleMinutes ?? SERVICE_DEFAULTS.pressureIdleMinutes;

  // What Docker Desktop is judged on: managed Docker projects awake, and running containers nobody here manages.
  const managedDocker = reg.services.filter((s) => s.managed && isDockerKind(s.spec.kind));
  const dockerServicesAwake = managedDocker.filter((s) => probes.get(s.id)?.awake).length;
  const ours = new Set(managedDocker.flatMap(containersOf));

  const out: Judged[] = [];
  for (const svc of reg.services) {
    const probe = probes.get(svc.id);
    const op = opOf(svc.id, svc.spec.kind);
    const rowState: ServiceState = op ?? (probe === undefined ? 'unknown' : probe.awake ? 'awake' : 'asleep');
    const isDD = svc.spec.kind === 'docker-desktop';
    const lastUsedAt = isDD ? st.dockerQuietSince : st.lastUsedAt[svc.id] ?? null;
    // Docker Desktop follows its own quiet clock (no container for its idle limit),
    // not the 30-min observation window the services get.
    const seen = observed.get(svc.id) ?? now;
    const observedSince = isDD ? Math.min(seen, now - SERVICE_DEFAULTS.minObservationMs) : seen;

    let v: UseVerdict;
    if (probe === undefined && !op && svc.managed) {
      v = { verdict: 'unknown', note: 'not checked yet', idleForMinutes: null, early: false };
    } else {
      const activeNow = !probe || !probe.awake ? false
        : svc.spec.kind === 'process' ? processActive(probe.cpuPct, probe.conns)
          : isDockerKind(svc.spec.kind) ? probe.active === true : false;
      v = serviceVerdict({
        kind: svc.spec.kind, managed: svc.managed, pinned: svc.pinned, awake: probe?.awake ?? false, inflight: op,
        activeNow, activeDetail: probe?.detail ?? '', lastUsedAt, observedSince, idleMinutes: svc.idleMinutes, now,
        memPressure: pressure, pressureIdleMinutes,
        dockerServicesAwake: isDD ? dockerServicesAwake : undefined,
        runningContainersOutside: isDD ? (probe?.runningContainers ?? []).filter((n) => !ours.has(n)) : undefined,
      });
    }

    const guarded = proxy?.guarded(svc.id) ?? [];
    let note = v.note;
    let since: number | null = null;
    if (rowState === 'awake') since = observed.get(svc.id) ?? null;
    if (rowState === 'asleep') {
      const slept = st.sleptAt[svc.id];
      since = slept && slept >= (st.wokeAt[svc.id] ?? 0) ? slept : null;
      if (v.verdict === 'asleep' && !isDD) {
        const at = since ? ` since ${hhmm(since)}` : '';
        const want = svc.ports.map((p) => p.port);
        const free = want.filter((p) => !guarded.includes(p));
        if (guarded.length && !free.length) note = `asleep${at} — wakes on the first request to ${portsText(guarded)} or when you click Wake`;
        else if (guarded.length) note = `asleep${at} — wakes on the first request to ${portsText(guarded)} or when you click Wake (${portsText(free)} is taken by another program)`;
        else if (want.length && reg.mode === 'live') note = `asleep${at} — ${portsText(want)} is not watched right now; wakes when you click Wake`;
        else note = `asleep${at} — wakes when you click Wake`;
      }
    }

    const running = probe?.runningContainers?.length ?? 0;
    const row: ServiceRow = {
      id: svc.id, name: svc.name, kind: svc.spec.kind, state: rowState, verdict: v.verdict, note,
      pinned: svc.pinned, managed: svc.managed, idleMinutes: svc.idleMinutes, idleForMinutes: v.idleForMinutes,
      ports: svc.ports.map((p) => ({ ...p })), guardedPorts: guarded,
      lastUsedAt: lastUsedAt ? new Date(lastUsedAt).toISOString() : null,
      since: since ? new Date(since).toISOString() : null,
      cpuPct: probe?.cpuPct ?? null, memMB: probe?.memMB ?? null, establishedConns: probe?.conns ?? 0,
      canWake: svc.managed && !op && rowState === 'asleep',
      canSleep: svc.managed && !op && rowState === 'awake' && (!isDD || running === 0),
    };
    out.push({ svc, probe, state: rowState, v, row, clock: lastUsedAt ?? observedSince });
  }
  // Docker Desktop's row last.
  return [...out.filter((j) => j.svc.spec.kind !== 'docker-desktop'), ...out.filter((j) => j.svc.spec.kind === 'docker-desktop')];
}

function computeMemory(judged: Judged[]): ServicesSnapshot['memory'] {
  const g = guardOf();
  const pressure = MEM_PRESSURE_LEVELS.includes(g.level);
  const queue = pressureQueue(judged.map((j) => ({
    id: j.svc.id,
    early: j.v.early,
    lastUsedAt: j.svc.spec.kind === 'docker-desktop' ? null : state?.lastUsedAt[j.svc.id] ?? null,
    observedSince: observed.get(j.svc.id) ?? nowMs(),
    // Already in motion, or the memory guard has already given notice on one of its containers.
    skip: j.state === 'waking' || j.state === 'sleeping' || (isDockerKind(j.svc.spec.kind) && containersOf(j.svc).some((n) => g.stopping.includes(n))),
  })));
  return { level: g.level, pressure, queue };
}

function dockerWord(): ServicesSnapshot['docker'] {
  if (dockerOp) return dockerOp;
  if (dockerUp === null) return 'unknown';
  return dockerUp ? 'up' : 'down';
}

function buildSnapshot(now: number, judged: Judged[]): ServicesSnapshot {
  const files = deps?.files ?? { registry: '', state: '', log: '' };
  return {
    at: new Date(now).toISOString(),
    mode: currentRegistry().mode,
    docker: dockerWord(),
    memory,
    services: judged.map((j) => j.row),
    recent: files.log ? readServiceLogTail(files.log, SERVICE_DEFAULTS.recentMax) : [],
    files,
  };
}

function publish(): ServicesSnapshot {
  const now = nowMs();
  const judged = judgeAll(now);
  memory = computeMemory(judged);
  snapshot = buildSnapshot(now, judged);
  try {
    deps?.onSnapshot(snapshot);
  } catch {
    /* a torn-down window must not break the loop */
  }
  return snapshot;
}

// ── proxies ───────────────────────────────────────────────────────────────

async function armFor(svc: ManagedService, by: ServiceLogBy): Promise<void> {
  if (!proxy || !svc.ports.length) return;
  const want = svc.ports.map((p) => p.port);
  const have = proxy.guarded(svc.id);
  if (want.every((p) => have.includes(p))) return;
  let res: Awaited<ReturnType<WakeProxy['arm']>>;
  try {
    res = await proxy.arm(svc.id, svc.ports);
  } catch (err) {
    res = { armed: [], failed: svc.ports.map((port) => ({ port, error: String(err) })) };
  }
  // A wake in flight holds the episode: not armed, still waking — nothing to report.
  const failed = res.failed.filter((f) => f.error !== 'waking');
  const sig = JSON.stringify({ a: res.armed.map((p) => p.port), f: failed.map((f) => [f.port.port, f.error]) });
  if (armLogged.get(svc.id) === sig) return;
  armLogged.set(svc.id, sig);
  if (res.armed.length) logEvent(svc, 'proxy-armed', by, `wakes on the first request to ${portsText(res.armed.map((p) => p.port))}`);
  for (const f of failed) logEvent(svc, 'proxy-failed', by, `:${f.port.port} — ${f.error}`);
}

async function disarmFor(id: string): Promise<void> {
  armLogged.delete(id);
  try {
    await proxy?.disarm(id);
  } catch {
    /* disarm never matters enough to fail an operation */
  }
}

// ── operations ────────────────────────────────────────────────────────────

/** One operation per id. The same operation again joins the one in flight; the other kind waits for it. */
function serial(id: string, kind: OpKind, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<ServiceActionResult> {
  const cur = ops.get(id);
  if (cur && cur.kind === kind) return cur.p;
  const prev = cur?.p ?? Promise.resolve(null);
  const p: Promise<ServiceActionResult> = prev
    .catch(() => null)
    .then(async () => {
      publish();
      let r: { ok: boolean; error?: string };
      try {
        r = await fn();
      } catch (err) {
        r = { ok: false, error: String(err) };
      }
      return r;
    })
    .then((r) => {
      if (ops.get(id)?.p === p) ops.delete(id);
      opEpoch.set(id, (opEpoch.get(id) ?? 0) + 1);
      saveState();
      const snap = publish();
      return r.error !== undefined ? { ok: r.ok, error: r.error, snapshot: snap } : { ok: r.ok, snapshot: snap };
    });
  ops.set(id, { kind, p });
  return p;
}

function refuse(error: string): Promise<ServiceActionResult> {
  return Promise.resolve({ ok: false, error, snapshot: getServicesSnapshot() });
}

function findService(id: string): ManagedService | null {
  return currentRegistry().services.find((s) => s.id === id) ?? null;
}

const asleepProbe = (detail: string): ProbeResult => ({ awake: false, pids: [], cpuPct: null, memMB: null, conns: 0, detail, runningContainers: [], active: false });

async function ensureDocker(by: ServiceLogBy, forName: string): Promise<{ ok: boolean; error?: string }> {
  const exec = execOf();
  if (await dockerDesktopUp(exec)) { dockerUp = true; return { ok: true }; }
  const dd = currentRegistry().services.find((s) => s.spec.kind === 'docker-desktop');
  if (dd && !dd.managed) return { ok: false, error: 'Docker Desktop is off and is set to be left alone' };
  const ddSvc = dd ?? { id: 'docker-desktop', name: 'Docker Desktop', spec: { kind: 'docker-desktop' }, ports: [], idleMinutes: SERVICE_DEFAULTS.dockerDesktopIdleMinutes, pinned: false, managed: true, source: 'seed' } as ManagedService;
  dockerOp = 'starting';
  publish();
  let r: { ok: boolean; error?: string };
  try {
    r = await drivers!['docker-desktop'].start(ddSvc);
  } catch (err) {
    r = { ok: false, error: String(err) };
  } finally {
    dockerOp = null;
  }
  if (!r.ok) return { ok: false, error: `Docker Desktop did not start: ${r.error ?? 'unknown error'}` };
  dockerUp = true;
  const now = nowMs();
  observed.set(ddSvc.id, now);
  if (state) { state.wokeAt[ddSvc.id] = now; state.dockerQuietSince = null; }
  probes.set(ddSvc.id, { awake: true, pids: [], cpuPct: null, memMB: null, conns: 0, detail: 'running', runningContainers: [] });
  logEvent(ddSvc, 'docker-started', by, `for ${forName}`);
  return { ok: true };
}

/** Docker discovery merged into the registry; returns the ids it added. Changes nothing when Docker is down. */
async function discover(by: ServiceLogBy): Promise<string[]> {
  const found = await collectDockerDiscovery(execOf());
  if (found === null) return [];
  const before = currentRegistry();
  const { registry: merged, added } = mergeDiscovered(before, found);
  if (JSON.stringify(merged) !== JSON.stringify(before)) saveRegistry(merged);
  for (const id of added) {
    const s = merged.services.find((x) => x.id === id);
    if (s) logEvent(s, 'discovered', by, s.ports.length ? `publishes ${portsText(s.ports.map((p) => p.port))}` : 'no published ports');
  }
  return added;
}

/**
 * Disarm the proxy → (Docker kinds: Docker Desktop up first) → driver.start →
 * stamp used/woken → log 'woke'. On failure: log 'wake-failed', notify, re-arm.
 * A request wake comes from the proxy itself, which has already closed its
 * listeners and re-arms by itself if the wake fails.
 */
export function wakeService(id: string, by: ServiceLogBy): Promise<ServiceActionResult> {
  if (!deps || !drivers) return refuse('sleeping services are not running');
  const found = findService(id);
  if (!found) return refuse(`unknown service: ${id}`);
  if (!found.managed) return refuse(`${found.name} is listed only — Peers Flow does not start it`);
  return serial(id, 'waking', async () => {
    let svc = findService(id) ?? found;
    if (by !== 'request') await disarmFor(id);
    const fail = async (error: string): Promise<{ ok: false; error: string }> => {
      logEvent(svc, 'wake-failed', by, error);
      notify('Peers Flow could not wake a service', `${svc.name}: ${error}`);
      if (by !== 'request' && svc.spec.kind !== 'docker-desktop' && currentRegistry().mode === 'live') await armFor(svc, by);
      return { ok: false, error };
    };

    if (svc.spec.kind === 'docker-desktop') {
      const r = await ensureDocker(by, 'a click');
      return r.ok ? { ok: true } : fail(r.error ?? 'Docker Desktop did not start');
    }
    if (isDockerKind(svc.spec.kind)) {
      const d = await ensureDocker(by, svc.name);
      if (!d.ok) return fail(d.error ?? 'Docker Desktop did not start');
      // Never seen with Docker up: learn its containers first.
      if (!containersOf(svc).length) {
        await discover(by);
        svc = findService(id) ?? svc;
      }
    }

    let r: { ok: boolean; error?: string };
    try {
      r = await drivers![svc.spec.kind].start(svc);
    } catch (err) {
      r = { ok: false, error: String(err) };
    }
    if (!r.ok) return fail(r.error ?? 'did not start');

    const now = nowMs();
    if (state) { state.lastUsedAt[id] = now; state.wokeAt[id] = now; }
    observed.set(id, now);
    probes.set(id, { ...(probes.get(id) ?? asleepProbe('')), awake: true, detail: 'just woken' });
    logEvent(svc, 'woke', by, r.error ? `started — ${r.error}` : 'started');
    return { ok: true };
  });
}

/**
 * driver.stop → stamp slept → log 'slept' → arm the proxy on its ports (log
 * 'proxy-armed' / 'proxy-failed'). Docker Desktop logs 'docker-stopped' and is
 * refused while any container still runs in it.
 */
export function sleepService(id: string, by: ServiceLogBy, detail?: string): Promise<ServiceActionResult> {
  if (!deps || !drivers) return refuse('sleeping services are not running');
  const found = findService(id);
  if (!found) return refuse(`unknown service: ${id}`);
  if (!found.managed) return refuse(`${found.name} is listed only — Peers Flow does not stop it`);
  if (found.spec.kind === 'docker-desktop') {
    const running = probes.get(id)?.runningContainers ?? [];
    if (running.length) return refuse(`${running.length} container${running.length === 1 ? ' is' : 's are'} still running in Docker (${running[0]}) — put those to sleep first`);
  }
  return serial(id, 'sleeping', async () => {
    const svc = findService(id) ?? found;
    const isDD = svc.spec.kind === 'docker-desktop';
    if (isDD) { dockerOp = 'stopping'; publish(); }
    let r: { ok: boolean; error?: string };
    try {
      r = await drivers![svc.spec.kind].stop(svc);
    } catch (err) {
      r = { ok: false, error: String(err) };
    } finally {
      if (isDD) dockerOp = null;
    }
    if (!r.ok) {
      const error = r.error ?? 'did not stop';
      logEvent(svc, 'sleep-failed', by, error);
      notify('Peers Flow could not put a service to sleep', `${svc.name}: ${error}`);
      return { ok: false, error };
    }
    const now = nowMs();
    if (state) state.sleptAt[id] = now;
    observed.delete(id);
    probes.set(id, asleepProbe(isDD ? 'off' : 'asleep'));
    const why = detail ?? (by === 'click' ? 'put to sleep by hand' : 'put to sleep');
    if (isDD) {
      dockerUp = false;
      if (state) state.dockerQuietSince = null;
      for (const s of currentRegistry().services) if (isDockerKind(s.spec.kind)) probes.set(s.id, asleepProbe('Docker is off'));
      logEvent(svc, 'docker-stopped', by, why);
    } else {
      logEvent(svc, 'slept', by, why);
      await armFor(svc, by);
    }
    return { ok: true };
  });
}

// ── the tick ──────────────────────────────────────────────────────────────

async function pass(d: ServicesDeps): Promise<void> {
  init(d);
  const exec = execOf();
  // Read as late as possible: a hand edit (or 'watch') takes effect on this very tick.
  registry = readRegistry(d.files.registry, d.seed);
  const st = state!;

  dockerUp = await dockerDesktopUp(exec);
  let ps: ContainerInfo[] | null = null;
  let stats: StatsRow[] | null = null;
  if (dockerUp) {
    const [psOut, statsOut] = await Promise.all([
      exec('docker', ['ps', '-a', '--format', '{{json .}}'], DOCKER_TIMEOUT_MS),
      exec('docker', ['stats', '--no-stream', '--format', STATS_FORMAT], DOCKER_TIMEOUT_MS),
    ]);
    ps = psOut === null ? null : parseDockerPsJson(psOut);
    stats = statsOut === null ? null : parseStatsRows(statsOut);
    if (tick % DISCOVER_EVERY_TICKS === 0) {
      await discover(tick === 0 ? 'startup' : 'docker');
    }
  }
  const netstat = await exec('netstat', ['-anp', 'tcp'], PS_TIMEOUT_MS);
  const conns = netstat === null ? new Map<number, number>() : parseEstablishedPorts(netstat);
  const ctx: ProbeCtx = { conns, dockerUp, ps, stats, prevStats };

  const now = nowMs();
  for (const svc of currentRegistry().services) {
    // Docker up but its listing failed: no trustworthy reading — leave the row as it was.
    if (isDockerKind(svc.spec.kind) && dockerUp && ps === null) continue;
    if (svc.spec.kind === 'docker-desktop' && dockerUp && ps === null) continue;
    const epoch = opEpoch.get(svc.id) ?? 0;
    let probe: ProbeResult;
    try {
      probe = await drivers![svc.spec.kind].probe(svc, ctx);
    } catch (err) {
      console.warn(`${LOG_PREFIX} probe failed for ${svc.id}`, { error: String(err) });
      probes.delete(svc.id);
      continue;
    }
    // An operation owns the row and the clocks while it runs, and its own result beats a reading taken before it ended.
    if (ops.has(svc.id) || (opEpoch.get(svc.id) ?? 0) !== epoch) continue;
    probes.set(svc.id, probe);
    if (probe.awake) {
      if (!observed.has(svc.id)) observed.set(svc.id, now);
      // First sight with no history: the idle clock starts now, so a service is
      // judged idle only after its full idle limit, not after the 30-min window.
      if (svc.spec.kind !== 'docker-desktop' && st.lastUsedAt[svc.id] === undefined) st.lastUsedAt[svc.id] = now;
      const busy = svc.spec.kind === 'process' ? processActive(probe.cpuPct, probe.conns) : isDockerKind(svc.spec.kind) ? probe.active === true : false;
      if (busy) st.lastUsedAt[svc.id] = now;
    } else {
      observed.delete(svc.id);
    }
  }
  // Docker's quiet clock: since when no container has been running.
  if (dockerUp && ps !== null) {
    if (ps.some((c) => c.running)) st.dockerQuietSince = null;
    else if (st.dockerQuietSince === null) st.dockerQuietSince = now;
  } else if (!dockerUp) {
    st.dockerQuietSince = null;
  }
  if (stats) prevStats = new Map(stats.map((s) => [s.name, s]));

  let judged = judgeAll(now);
  memory = computeMemory(judged);
  const reg = currentRegistry();
  const firstPass = tick === 0;
  tick++;

  // Proxies on a service that is awake (or no longer ours) are released, in any mode.
  for (const j of judged) {
    const guarded = proxy?.guarded(j.svc.id) ?? [];
    if (guarded.length && !ops.has(j.svc.id) && (j.state === 'awake' || !j.svc.managed)) await disarmFor(j.svc.id);
  }

  if (reg.mode === 'live') {
    // Without netstat (or Docker's stats for its projects), "no connections" is no reading: sleep nothing.
    const trusted = (j: Judged): boolean => netstat !== null && (!isDockerKind(j.svc.spec.kind) || stats !== null);
    const byId = new Map(judged.map((j) => [j.svc.id, j]));
    const slept = new Set<string>();
    let budget = SERVICE_DEFAULTS.maxSleepsPerTick;

    if (memory.pressure && memory.queue.length) {
      const j = byId.get(memory.queue[0]);
      if (j && trusted(j)) {
        const idle = j.v.idleForMinutes ?? 0;
        const r = await sleepService(j.svc.id, 'pressure', `memory ${memory.level} — least recently used (idle ${fmtMinutes(idle)})`);
        budget--;
        slept.add(j.svc.id);
        if (r.ok && !pressureNotified) {
          pressureNotified = true;
          notify('Memory is tight', `Peers Flow put ${j.svc.name} to sleep early — it wakes up on the next request.`);
        }
      }
    }

    const idle = judged
      // An early candidate that is also past its own idle limit is an ordinary one.
      .filter((j) => j.v.verdict === 'idle' && (!j.v.early || (j.v.idleForMinutes ?? 0) >= j.svc.idleMinutes) && j.svc.spec.kind !== 'docker-desktop' && !slept.has(j.svc.id) && trusted(j))
      .sort((a, b) => a.clock - b.clock || (a.svc.id < b.svc.id ? -1 : 1));
    for (const j of idle) {
      if (budget <= 0) break;
      budget--;
      await sleepService(j.svc.id, 'idle', `not used for ${fmtMinutes(j.v.idleForMinutes ?? 0)}`);
    }

    // Every sleeping service keeps its ports watched.
    judged = judgeAll(nowMs());
    for (const j of judged) {
      if (j.state === 'asleep' && j.svc.managed && j.svc.spec.kind !== 'docker-desktop') await armFor(j.svc, firstPass ? 'startup' : 'idle');
    }

    // Docker Desktop: only when it is up, nothing runs in it, and that has held for its idle limit.
    const dd = judged.find((j) => j.svc.spec.kind === 'docker-desktop');
    const dockerBusy = Array.from(ops.keys()).some((id) => { const s = findService(id); return !!s && isDockerKind(s.spec.kind); });
    if (dd && dd.v.verdict === 'idle' && dockerUp && ps !== null && !ps.some((c) => c.running) && !dockerBusy) {
      await sleepService(dd.svc.id, 'idle', `no container ran for ${fmtMinutes(dd.v.idleForMinutes ?? 0)}`);
    }
  }
  if (!memory.pressure) pressureNotified = false;

  saveState();
  publish();
}

// ── public surface ────────────────────────────────────────────────────────

export function startServices(d: ServicesDeps): void {
  if (timer || firstTimer) return;
  init(d);
  // Not on the launch burst itself: the first pass waits a few seconds.
  firstTimer = setTimeout(() => {
    firstTimer = null;
    void runServicesOnce(d);
  }, FIRST_TICK_DELAY_MS);
  firstTimer.unref?.();
  timer = setInterval(() => void runServicesOnce(d), SERVICES_TICK_MS);
  timer.unref?.();
}

/** Clears the timers and closes the wake proxy. Services stay exactly as they are. */
export async function stopServices(): Promise<void> {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
  const p = proxy;
  proxy = null;
  try {
    await p?.close();
  } catch {
    /* quitting */
  }
}

/** One pass. Never throws. A pass still running (a slow docker) makes the next one a no-op. */
export async function runServicesOnce(d: ServicesDeps): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    await pass(d);
  } catch (err) {
    console.warn(`${LOG_PREFIX} tick failed`, { error: String(err) });
  } finally {
    inflight = false;
  }
}

export function getServicesSnapshot(): ServicesSnapshot {
  if (snapshot) return snapshot;
  const now = nowMs();
  const judged = deps ? judgeAll(now) : [];
  return buildSnapshot(now, judged);
}

function patchService(id: string, patch: (s: ManagedService) => void): ServicesSnapshot {
  if (!deps) return getServicesSnapshot();
  const reg = readRegistry(deps.files.registry, deps.seed);
  const svc = reg.services.find((s) => s.id === id);
  if (!svc) return getServicesSnapshot();
  patch(svc);
  saveRegistry(reg);
  return publish();
}

export function setServicePin(id: string, pinned: boolean): ServicesSnapshot {
  return patchService(id, (s) => { s.pinned = pinned === true; });
}

export function setServiceIdle(id: string, idleMinutes: number): ServicesSnapshot {
  if (typeof idleMinutes !== 'number' || !Number.isFinite(idleMinutes) || idleMinutes <= 0) return getServicesSnapshot();
  return patchService(id, (s) => { s.idleMinutes = idleMinutes; });
}

export function setServiceManaged(id: string, managed: boolean): ServicesSnapshot {
  return patchService(id, (s) => { s.managed = managed === true; });
}

export function setServicesMode(mode: ServicesMode): ServicesSnapshot {
  if (!deps || (mode !== 'live' && mode !== 'watch')) return getServicesSnapshot();
  const reg = readRegistry(deps.files.registry, deps.seed);
  if (reg.mode !== mode) log(`mode ${reg.mode} → ${mode}`);
  saveRegistry({ ...reg, mode });
  return publish();
}

/** Looks for new Docker projects now (Docker must be up), then runs one pass so they get a state. */
export async function rediscoverServices(): Promise<ServicesSnapshot> {
  if (!deps) return getServicesSnapshot();
  init(deps);
  registry = readRegistry(deps.files.registry, deps.seed);
  await discover('click');
  await runServicesOnce(deps);
  return publish();
}

/** Test seam: reset the module's loop state between cases. */
export function __resetServicesForTests(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
  deps = null;
  inflight = false;
  tick = 0;
  proxy = null;
  drivers = null;
  registry = null;
  state = null;
  dockerUp = null;
  dockerOp = null;
  prevStats = new Map();
  pressureNotified = false;
  memory = { level: 'unknown', pressure: false, queue: [] };
  snapshot = null;
  probes.clear();
  observed.clear();
  ops.clear();
  opEpoch.clear();
  armLogged.clear();
}
