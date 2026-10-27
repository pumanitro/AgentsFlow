import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import type { ManagedService, ServiceKind, ServiceLogEntry, ServicePort, ServicesRegistryFile, ServicesSnapshot } from '../../shared/services';
import type { MemLevel } from '../../shared/types';
import type { Exec } from '../guard/docker-inventory';
import type { Driver, ProbeResult } from './drivers';
import {
  __resetServicesForTests, getServicesSnapshot, rediscoverServices, runServicesOnce, setServiceIdle, setServicePin, setServicesMode,
  sleepService, stopServices, wakeService,
} from './services';
import type { ServicesDeps } from './services';
import { readState } from './state';
import type { WakeProxy } from './wake-proxy';

// Everything here runs against a temp dir, fake drivers (start/stop only flip a
// flag in `world`), a fake wake proxy (records arm/disarm, binds nothing) and a
// fake exec that answers pgrep/docker/netstat from `world`. Any other command
// fails the test, so nothing real is ever started, stopped or bound.

const T0 = new Date(2026, 9, 26, 9, 0, 0).getTime();   // local 09:00, so HH:MM notes are predictable
const MIN = 60_000;

const logLines: string[] = [];
const realLog = console.log;
const realWarn = console.warn;
console.log = (...a: unknown[]) => { logLines.push(a.map(String).join(' ')); };
console.warn = (...a: unknown[]) => { logLines.push(a.map(String).join(' ')); };
after(() => { console.log = realLog; console.warn = realWarn; __resetServicesForTests(); });

interface SvcWorld { awake: boolean; cpu: number; conns: number; active: boolean; failStart?: string }
interface World { now: number; docker: boolean; containers: Map<string, boolean>; svcs: Map<string, SvcWorld>; level: MemLevel; stopping: string[]; taken: Set<number> }

interface Harness {
  dir: string; files: ServicesDeps['files']; world: World; deps: ServicesDeps;
  calls: string[][]; ops: string[]; arms: Array<[string, number[]]>; disarms: string[]; notes: Array<[string, string]>; snaps: ServicesSnapshot[];
  guarded: Map<string, number[]>;
  tick: (advanceMs?: number) => Promise<void>;
  log: () => ServiceLogEntry[];
  row: (id: string) => ServicesSnapshot['services'][number];
  stops: () => string[];
}

function proc(id: string, port: number, extra: Partial<ManagedService> = {}): ManagedService {
  return {
    id, name: `${id} service`, source: 'user', managed: true, pinned: false, idleMinutes: 240, ports: [{ port, host: '127.0.0.1' }],
    spec: { kind: 'process', cmd: 'node', args: ['server.mjs'], cwd: path.join(os.homedir(), 'x'), logFile: path.join(os.tmpdir(), 'x.log') },
    ...extra,
  };
}
function compose(id: string, containers: string[], port: number, extra: Partial<ManagedService> = {}): ManagedService {
  return {
    id, name: `${id} — Docker project`, source: 'discovered', managed: true, pinned: false, idleMinutes: 240, ports: [{ port, host: '0.0.0.0' }],
    spec: { kind: 'compose', project: id.replace(/^compose:/, ''), configFiles: ['/nope/compose.yml'], projectDir: null, containers },
    ...extra,
  };
}
const DD: ManagedService = { id: 'docker-desktop', name: 'Docker Desktop', source: 'seed', managed: true, pinned: false, idleMinutes: 15, ports: [], spec: { kind: 'docker-desktop' } };

function harness(services: ManagedService[], opts: { mode?: 'live' | 'watch'; docker?: boolean; dir?: string } = {}): Harness {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'services-'));
  const files = { registry: path.join(dir, 'services.json'), state: path.join(dir, 'services-state.json'), log: path.join(dir, 'services-log.jsonl') };
  if (!fs.existsSync(files.registry)) {
    const reg: ServicesRegistryFile = { version: 1, mode: opts.mode ?? 'live', services };
    fs.writeFileSync(files.registry, JSON.stringify(reg));
  }
  const world: World = { now: T0, docker: opts.docker ?? false, containers: new Map(), svcs: new Map(), level: 'ok', stopping: [], taken: new Set() };
  for (const s of services) {
    world.svcs.set(s.id, { awake: false, cpu: 0, conns: 0, active: false });
    if (s.spec.kind === 'compose' || s.spec.kind === 'containers') for (const c of s.spec.containers) world.containers.set(c, false);
  }
  const calls: string[][] = [];
  const opsLog: string[] = [];
  const arms: Array<[string, number[]]> = [];
  const disarms: string[] = [];
  const notes: Array<[string, string]> = [];
  const snaps: ServicesSnapshot[] = [];
  const guarded = new Map<string, number[]>();

  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'pgrep') return world.docker ? '' : null;
    if (cmd === 'netstat') return '';
    if (cmd === 'docker') {
      if (!world.docker) return null;
      if (args[0] === 'info') return '27.4.0\n';
      if (args[0] === 'ps') return Array.from(world.containers).map(([n, r]) => JSON.stringify({ Names: n, State: r ? 'running' : 'exited', Labels: '', Ports: '', ID: n })).join('\n');
      if (args[0] === 'stats') return '';
      if (args[0] === 'inspect') return null;                    // discovery stays out of these tests unless one opts in
      if (args[0] === 'compose' && args[1] === 'ls') return '[]';
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };

  const w = (id: string): SvcWorld => {
    let s = world.svcs.get(id);
    if (!s) { s = { awake: false, cpu: 0, conns: 0, active: false }; world.svcs.set(id, s); }
    return s;
  };
  const names = (svc: ManagedService): string[] => (svc.spec.kind === 'compose' || svc.spec.kind === 'containers' ? svc.spec.containers : []);
  const processDriver: Driver = {
    async probe(svc) {
      const s = w(svc.id);
      return { awake: s.awake, pids: s.awake ? [4242] : [], cpuPct: s.awake ? s.cpu : null, memMB: s.awake ? 100 : null, conns: s.awake ? s.conns : 0, detail: s.awake ? 'running as pid 4242' : 'not running' };
    },
    async start(svc) {
      opsLog.push(`start ${svc.id}`);
      const s = w(svc.id);
      if (s.failStart) return { ok: false, error: s.failStart };
      s.awake = true;
      return { ok: true };
    },
    async stop(svc) { opsLog.push(`stop ${svc.id}`); w(svc.id).awake = false; return { ok: true }; },
  };
  const containerDriver: Driver = {
    async probe(svc, ctx): Promise<ProbeResult> {
      const running = ctx.dockerUp ? names(svc).filter((n) => world.containers.get(n)) : [];
      const s = w(svc.id);
      return { awake: running.length > 0, pids: [], cpuPct: running.length ? 0 : null, memMB: running.length ? 50 : null, conns: 0, detail: `${running.length} running`, runningContainers: running, active: running.length > 0 && s.active };
    },
    async start(svc) {
      opsLog.push(`start ${svc.id}`);
      if (!world.docker) return { ok: false, error: 'docker is off' };
      for (const n of names(svc)) world.containers.set(n, true);
      return { ok: true };
    },
    async stop(svc) { opsLog.push(`stop ${svc.id}`); for (const n of names(svc)) world.containers.set(n, false); return { ok: true }; },
  };
  const dockerDriver: Driver = {
    async probe(_svc, ctx) {
      const running = ctx.dockerUp ? Array.from(world.containers).filter(([, r]) => r).map(([n]) => n) : [];
      return { awake: ctx.dockerUp, pids: [], cpuPct: null, memMB: null, conns: 0, detail: ctx.dockerUp ? 'running' : 'off', runningContainers: running };
    },
    async start() { opsLog.push('start docker-desktop'); world.docker = true; return { ok: true }; },
    async stop() { opsLog.push('stop docker-desktop'); world.docker = false; for (const n of world.containers.keys()) world.containers.set(n, false); return { ok: true }; },
  };
  const drivers: Record<ServiceKind, Driver> = { process: processDriver, compose: containerDriver, containers: containerDriver, 'docker-desktop': dockerDriver };

  const proxy: WakeProxy = {
    async arm(id: string, ports: ServicePort[]) {
      const armed = ports.filter((p) => !world.taken.has(p.port));
      const failed = ports.filter((p) => world.taken.has(p.port)).map((port) => ({ port, error: 'EADDRINUSE' }));
      arms.push([id, armed.map((p) => p.port)]);
      if (armed.length) guarded.set(id, Array.from(new Set([...(guarded.get(id) ?? []), ...armed.map((p) => p.port)])).sort((a, b) => a - b));
      return { armed, failed };
    },
    async disarm(id: string) { disarms.push(id); guarded.delete(id); },
    guarded: (id: string) => guarded.get(id) ?? [],
    async close() { guarded.clear(); },
  };

  const deps: ServicesDeps = {
    files,
    notify: (t, b) => { notes.push([t, b]); },
    onSnapshot: (s) => { snaps.push(s); },
    exec, now: () => world.now, drivers, proxy,
    seed: () => [],
    guard: () => ({ level: world.level, stopping: world.stopping }),
  };
  __resetServicesForTests();
  const h: Harness = {
    dir, files, world, deps, calls, ops: opsLog, arms, disarms, notes, snaps, guarded,
    tick: async (advanceMs = 0) => { world.now += advanceMs; await runServicesOnce(deps); },
    log: () => (fs.existsSync(files.log) ? fs.readFileSync(files.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ServiceLogEntry) : []),
    row: (id: string) => {
      const r = getServicesSnapshot().services.find((x) => x.id === id);
      assert.ok(r, `no row for ${id}`);
      return r;
    },
    stops: () => opsLog.filter((o) => o.startsWith('stop ')).map((o) => o.slice(5)),
  };
  return h;
}

const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

test('before the first pass: a snapshot with no rows, never a throw', () => {
  __resetServicesForTests();
  const s = getServicesSnapshot();
  assert.deepEqual(s.services, []);
  assert.equal(s.docker, 'unknown');
  assert.deepEqual(s.memory, { level: 'unknown', pressure: false, queue: [] });
});

test('nothing is slept in the first 30 min of observation, and an idle service only after its idle limit', async () => {
  const h = harness([proc('api', 45545, { idleMinutes: 60 })]);
  h.world.svcs.get('api')!.awake = true;
  await h.tick();
  // First sight: the clock starts now, so "used 0 min ago", not idle.
  assert.equal(h.row('api').verdict, 'in-use');
  await h.tick(29 * MIN);
  assert.deepEqual(h.stops(), []);
  await h.tick(30 * MIN);       // 59 min
  assert.deepEqual(h.stops(), []);
  assert.equal(h.row('api').note, 'used 59 min ago');
  await h.tick(2 * MIN);        // 61 min, nobody touched it
  assert.deepEqual(h.stops(), ['api']);
  const r = h.row('api');
  assert.equal(r.state, 'asleep');
  assert.deepEqual(r.guardedPorts, [45545]);
  assert.equal(r.note, `asleep since ${hhmm(T0 + 61 * MIN)} — wakes on the first request to :45545 or when you click Wake`);
  const ev = h.log().map((e) => [e.event, e.by]);
  assert.deepEqual(ev, [['slept', 'idle'], ['proxy-armed', 'idle']]);
  assert.match(h.log()[0].detail, /not used for 1 h 1 min/);
});

test('a persisted old "last used" is still judged only after 30 min of watching (app restart)', async () => {
  const h = harness([proc('api', 45545, { idleMinutes: 60 })]);
  fs.writeFileSync(h.files.state, JSON.stringify({ version: 1, lastUsedAt: { api: T0 - 10 * 60 * MIN }, sleptAt: {}, wokeAt: {}, dockerQuietSince: null }));
  h.world.svcs.get('api')!.awake = true;
  await h.tick();
  assert.equal(h.row('api').verdict, 'too-new');
  await h.tick(29 * MIN);
  assert.deepEqual(h.stops(), []);
  await h.tick(2 * MIN);
  assert.deepEqual(h.stops(), ['api']);
});

test('connections or CPU keep a service in use and stamp its clock', async () => {
  const h = harness([proc('api', 45545, { idleMinutes: 60 })]);
  const s = h.world.svcs.get('api')!;
  s.awake = true;
  await h.tick();
  s.conns = 2;
  await h.tick(50 * MIN);
  assert.equal(h.row('api').verdict, 'in-use');
  assert.match(h.row('api').note, /^in use right now — /);
  s.conns = 0;
  await h.tick(30 * MIN);       // 30 min after the last use
  assert.equal(h.row('api').note, 'used 30 min ago');
  assert.deepEqual(h.stops(), []);
  assert.equal(readState(h.files.state).lastUsedAt.api, T0 + 50 * MIN);
});

test('at most two services are put to sleep per tick, oldest idle first', async () => {
  const h = harness([proc('a', 45001, { idleMinutes: 60 }), proc('b', 45002, { idleMinutes: 60 }), proc('c', 45003, { idleMinutes: 60 })]);
  for (const id of ['a', 'b', 'c']) h.world.svcs.get(id)!.awake = true;
  fs.writeFileSync(h.files.state, JSON.stringify({ version: 1, lastUsedAt: { a: T0 - 3 * 60 * MIN, b: T0 - 5 * 60 * MIN, c: T0 - 4 * 60 * MIN }, sleptAt: {}, wokeAt: {}, dockerQuietSince: null }));
  await h.tick();
  await h.tick(31 * MIN);
  assert.deepEqual(h.stops(), ['b', 'c']);
  await h.tick(1 * MIN);
  assert.deepEqual(h.stops(), ['b', 'c', 'a']);
});

test('a request wake starts the service, stamps "last used" and leaves the proxy alone (it already let go)', async () => {
  const h = harness([proc('api', 45545)]);
  await h.tick();
  assert.equal(h.row('api').state, 'asleep');
  assert.deepEqual(h.arms, [['api', [45545]]]);
  assert.deepEqual(h.log().map((e) => [e.event, e.by]), [['proxy-armed', 'startup']]);
  h.world.now += 5 * MIN;
  const r = await wakeService('api', 'request');
  assert.equal(r.ok, true);
  assert.deepEqual(h.ops, ['start api']);
  assert.deepEqual(h.disarms, []);
  assert.equal(r.snapshot.services[0].state, 'awake');
  assert.equal(readState(h.files.state).lastUsedAt.api, T0 + 5 * MIN);
  assert.equal(readState(h.files.state).wokeAt.api, T0 + 5 * MIN);
  const last = h.log().at(-1)!;
  assert.equal(last.event, 'woke');
  assert.equal(last.by, 'request');
});

test('a click wake disarms first; a failed wake is logged, notified and re-armed', async () => {
  const h = harness([proc('api', 45545)]);
  await h.tick();
  h.world.svcs.get('api')!.failStart = 'exited before it was ready';
  const r = await wakeService('api', 'click');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'exited before it was ready');
  assert.deepEqual(h.disarms, ['api']);
  assert.deepEqual(h.arms, [['api', [45545]], ['api', [45545]]]);
  assert.equal(h.notes.length, 1);
  assert.deepEqual(h.log().map((e) => e.event), ['proxy-armed', 'wake-failed', 'proxy-armed']);
  assert.equal(r.snapshot.services[0].state, 'asleep');
});

test('two wakes of the same service at once share one start', async () => {
  const h = harness([proc('api', 45545)]);
  await h.tick();
  const [a, b] = await Promise.all([wakeService('api', 'request'), wakeService('api', 'click')]);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(h.ops, ['start api']);
});

test('a click wake of a Docker project while Docker is off starts Docker Desktop first', async () => {
  const h = harness([compose('compose:vit', ['vit-db', 'vit-web'], 45432), DD]);
  await h.tick();
  assert.equal(h.row('docker-desktop').state, 'asleep');
  assert.equal(getServicesSnapshot().docker, 'down');
  const r = await wakeService('compose:vit', 'click');
  assert.equal(r.ok, true);
  assert.deepEqual(h.ops, ['start docker-desktop', 'start compose:vit']);
  assert.deepEqual(h.log().filter((e) => e.event !== 'proxy-armed').map((e) => [e.id, e.event, e.by]), [
    ['docker-desktop', 'docker-started', 'click'],
    ['compose:vit', 'woke', 'click'],
  ]);
  assert.equal(r.snapshot.docker, 'up');
  // The services row of Docker Desktop stays last.
  assert.equal(r.snapshot.services.at(-1)!.id, 'docker-desktop');
});

test('Docker Desktop is stopped only after no container ran for 15 min', async () => {
  const h = harness([compose('compose:vit', ['vit-db'], 45432), DD], { docker: true });
  h.world.containers.set('vit-db', true);
  await h.tick();
  assert.equal(h.row('docker-desktop').verdict, 'in-use');
  assert.equal(h.row('docker-desktop').canSleep, false);
  h.world.containers.set('vit-db', false);        // stopped by hand
  await h.tick(1 * MIN);
  await h.tick(14 * MIN);
  assert.deepEqual(h.stops(), []);
  assert.equal(h.row('docker-desktop').verdict, 'in-use');
  await h.tick(2 * MIN);
  assert.deepEqual(h.stops(), ['docker-desktop']);
  assert.equal(h.log().at(-1)!.event, 'docker-stopped');
  assert.equal(getServicesSnapshot().docker, 'down');
});

test('Docker Desktop is never stopped while a container it does not manage runs (blocked)', async () => {
  const h = harness([DD], { docker: true });
  h.world.containers.set('stray', true);
  await h.tick();
  await h.tick(60 * MIN);
  const r = h.row('docker-desktop');
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.note, 'stays on: stray is running and is not managed here');
  assert.deepEqual(h.stops(), []);
  const click = await sleepService('docker-desktop', 'click');
  assert.equal(click.ok, false);
  assert.deepEqual(h.stops(), []);
});

test("mode 'watch': verdicts are computed, nothing is started, stopped or armed", async () => {
  const h = harness([proc('api', 45545, { idleMinutes: 60 }), proc('off', 45546), DD], { mode: 'watch', docker: true });
  h.world.svcs.get('api')!.awake = true;
  await h.tick();
  await h.tick(3 * 60 * MIN);
  assert.equal(h.row('api').verdict, 'idle');
  assert.equal(h.row('off').state, 'asleep');
  assert.deepEqual(h.ops, []);
  assert.deepEqual(h.arms, []);
  assert.equal(getServicesSnapshot().mode, 'watch');
  // Switching it on acts on the next tick.
  setServicesMode('live');
  await h.tick(MIN);
  assert.deepEqual(h.stops().sort(), ['api', 'docker-desktop']);
  assert.deepEqual(h.arms.map((a) => a[0]).sort(), ['api', 'off']);
});

test('a service found awake while its ports are watched gets its ports back', async () => {
  const h = harness([proc('api', 45545)]);
  await h.tick();
  assert.deepEqual(h.row('api').guardedPorts, [45545]);
  h.world.svcs.get('api')!.awake = true;          // started by hand, e.g. on another host binding
  await h.tick(MIN);
  assert.deepEqual(h.disarms, ['api']);
  assert.deepEqual(h.row('api').guardedPorts, []);
  assert.equal(h.row('api').state, 'awake');
});

test('a port another program holds is logged once, not every tick', async () => {
  const h = harness([proc('api', 45545)]);
  h.world.taken.add(45545);
  await h.tick();
  await h.tick(MIN);
  await h.tick(MIN);
  assert.deepEqual(h.log().map((e) => [e.event, e.detail]), [['proxy-failed', ':45545 — EADDRINUSE']]);
  assert.match(h.row('api').note, /:45545 is not watched right now/);
});

test('pinned is never slept for being idle; unmanaged is never touched', async () => {
  const h = harness([proc('pin', 45001, { idleMinutes: 60, pinned: true }), proc('own', 45002, { idleMinutes: 60, managed: false })]);
  h.world.svcs.get('pin')!.awake = true;
  await h.tick();
  await h.tick(5 * 60 * MIN);
  assert.equal(h.row('pin').verdict, 'pinned');
  assert.equal(h.row('own').verdict, 'unmanaged');
  assert.deepEqual(h.ops, []);
  assert.deepEqual(h.arms, []);
  const r = await wakeService('own', 'click');
  assert.equal(r.ok, false);
  const unknown = await sleepService('nope', 'click');
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? '', /unknown service/);
});

test('pin, idle limit and mode are written to the registry and re-judged at once', async () => {
  const h = harness([proc('api', 45545)]);
  h.world.svcs.get('api')!.awake = true;
  await h.tick();
  const s1 = setServicePin('api', true);
  assert.equal(s1.services[0].verdict, 'pinned');
  const s2 = setServiceIdle('api', 15);
  assert.equal(s2.services[0].idleMinutes, 15);
  setServiceIdle('api', -3);                      // ignored
  const reg = JSON.parse(fs.readFileSync(h.files.registry, 'utf8')) as ServicesRegistryFile;
  assert.equal(reg.services[0].pinned, true);
  assert.equal(reg.services[0].idleMinutes, 15);
});

test('state survives a restart: clocks re-read, the sleeping row keeps its "since"', async () => {
  const h = harness([proc('api', 45545, { idleMinutes: 60 })]);
  h.world.svcs.get('api')!.awake = true;
  await h.tick();
  await h.tick(61 * MIN);
  assert.deepEqual(h.stops(), ['api']);
  await stopServices();
  const h2 = harness([proc('api', 45545, { idleMinutes: 60 })], { dir: h.dir });
  h2.world.now = T0 + 90 * MIN;
  await h2.tick();
  const st = readState(h2.files.state);
  assert.equal(st.sleptAt.api, T0 + 61 * MIN);
  assert.equal(st.lastUsedAt.api, T0);
  assert.equal(h2.row('api').since, new Date(T0 + 61 * MIN).toISOString());
  assert.equal(h2.row('api').lastUsedAt, new Date(T0).toISOString());
});

test('rediscover merges Docker projects into the registry and logs them', async () => {
  const h = harness([DD], { docker: true });
  h.world.containers.set('web-1', false);
  const exec = h.deps.exec!;
  h.deps.exec = async (cmd, args, t) => {
    if (cmd === 'docker' && args[0] === 'inspect') return 'web-1\tweb\t/Users/x/web\t/Users/x/web/compose.yml\t<no value>\t{"80/tcp":[{"HostIp":"","HostPort":"48080"}]}\n';
    return exec(cmd, args, t);
  };
  await h.tick();
  const s = await rediscoverServices();
  const row = s.services.find((r) => r.id === 'compose:web');
  assert.ok(row);
  assert.deepEqual(row.ports, [{ port: 48080, host: '0.0.0.0' }]);
  assert.equal(s.services.at(-1)!.id, 'docker-desktop');
  assert.ok(h.log().some((e) => e.event === 'discovered' && e.id === 'compose:web'));
});

// ── memory pressure (AMENDMENT) ───────────────────────────────────────────

test('pressure: a service idle 31 min is slept early (by pressure); one idle 10 min and a pinned one are not', async () => {
  const h = harness([proc('old', 45001), proc('recent', 45002), proc('pin', 45003, { pinned: true })]);
  for (const id of ['old', 'recent', 'pin']) h.world.svcs.get(id)!.awake = true;
  await h.tick();
  h.world.svcs.get('recent')!.cpu = 50;
  await h.tick(21 * MIN);
  h.world.svcs.get('recent')!.cpu = 0;
  h.world.level = 'warn';
  await h.tick(10 * MIN);                          // old idle 31 min, recent 10 min
  assert.deepEqual(h.stops(), ['old']);
  const e = h.log().find((x) => x.event === 'slept')!;
  assert.equal(e.by, 'pressure');
  assert.equal(e.detail, 'memory warn — least recently used (idle 31 min)');
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0][0], 'Memory is tight');
  const snap = getServicesSnapshot();
  assert.equal(snap.memory.level, 'warn');
  assert.equal(snap.memory.pressure, true);
  assert.deepEqual(snap.memory.queue, []);
  assert.equal(h.row('recent').verdict, 'in-use');
});

test('pressure: two candidates → only the least recently used this tick, the other next tick; one notification per episode', async () => {
  const h = harness([proc('a', 45001), proc('b', 45002), proc('c', 45003)]);
  for (const id of ['a', 'b', 'c']) h.world.svcs.get(id)!.awake = true;
  await h.tick();
  h.world.svcs.get('b')!.cpu = 50;               // b used at +1 min → b is more recent than a
  await h.tick(MIN);
  h.world.svcs.get('b')!.cpu = 0;
  h.world.svcs.get('c')!.cpu = 50;               // c stays busy
  h.world.level = 'critical';
  await h.tick(35 * MIN);
  assert.deepEqual(getServicesSnapshot().memory.queue, ['b']);
  assert.deepEqual(h.stops(), ['a']);
  await h.tick(MIN);
  assert.deepEqual(h.stops(), ['a', 'b']);
  assert.equal(h.notes.length, 1);
  assert.deepEqual(h.log().filter((e) => e.event === 'slept').map((e) => e.by), ['pressure', 'pressure']);
});

test('pressure: back to ok → no further early sleeps; the queue is empty', async () => {
  const h = harness([proc('a', 45001), proc('b', 45002)]);
  for (const id of ['a', 'b']) h.world.svcs.get(id)!.awake = true;
  await h.tick();
  h.world.level = 'warn';
  await h.tick(31 * MIN);
  assert.equal(h.stops().length, 1);
  h.world.level = 'ok';
  await h.tick(MIN);
  assert.equal(h.stops().length, 1);
  assert.deepEqual(getServicesSnapshot().memory, { level: 'ok', pressure: false, queue: [] });
});

test('pressure: a Docker project whose container the memory guard is already stopping is skipped; Docker Desktop never queues', async () => {
  const h = harness([compose('compose:vit', ['vit-db'], 45432), compose('compose:inf', ['inf-db'], 45433), DD], { docker: true });
  h.world.containers.set('vit-db', true);
  h.world.containers.set('inf-db', true);
  await h.tick();
  h.world.level = 'warn';
  h.world.stopping = ['vit-db'];
  await h.tick(31 * MIN);
  assert.deepEqual(h.stops(), ['compose:inf']);
  await h.tick(MIN);
  const snap = getServicesSnapshot();
  assert.deepEqual(snap.memory.queue, []);
  assert.deepEqual(h.stops(), ['compose:inf']);
});

test('pressure in watch mode: the queue is shown, nothing is slept', async () => {
  const h = harness([proc('a', 45001)], { mode: 'watch' });
  h.world.svcs.get('a')!.awake = true;
  await h.tick();
  h.world.level = 'closed';
  await h.tick(31 * MIN);
  assert.deepEqual(getServicesSnapshot().memory.queue, ['a']);
  assert.deepEqual(h.stops(), []);
  assert.match(h.row('a').note, /^memory is tight — not used for 31 min, going to sleep early/);
});

test('stopServices closes the proxy and leaves services as they are', async () => {
  const h = harness([proc('api', 45545)]);
  h.world.svcs.get('api')!.awake = true;
  await h.tick();
  await stopServices();
  assert.equal(h.world.svcs.get('api')!.awake, true);
  assert.deepEqual(h.ops, []);
  assert.equal(h.guarded.size, 0);
  assert.ok(h.snaps.length > 0);
});
