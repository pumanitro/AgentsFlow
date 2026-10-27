import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import type { ManagedService, ServiceSpec } from '../../shared/services';
import type { ContainerInfo, Exec, StatsRow } from '../guard/docker-inventory';
import { createDrivers, dockerDesktopUp, listeningPids } from './drivers';
import type { DriverDeps, ProbeCtx } from './drivers';

type Call = { cmd: string; args: string[]; timeoutMs: number };
const FORBIDDEN = /\b(down|rm|rmi|prune|kill)\b/;

/** Records every call and answers from `answer` (null = command failed). */
function fakeExec(answer: (cmd: string, args: string[]) => string | null): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, exec: async (cmd, args, timeoutMs) => { calls.push({ cmd, args, timeoutMs }); return answer(cmd, args); } };
}
function argv(c: Call): string { return [c.cmd, ...c.args].join(' '); }
function noForbidden(calls: Call[]): void {
  for (const c of calls) {
    assert.ok(c.timeoutMs > 0, `${argv(c)} has a timeout`);
    assert.notEqual(c.cmd, 'ssh');
    if (c.cmd === 'docker') assert.ok(!FORBIDDEN.test(c.args.join(' ')), `forbidden docker verb in: ${argv(c)}`);
  }
}
function deps(exec: Exec, over: Partial<DriverDeps> = {}): DriverDeps {
  return {
    exec, env: () => ({ PATH: process.env.PATH }), log: () => {},
    sleep: async () => {}, timing: { pollMs: 1, stopGraceMs: 30, stopKillMs: 30, containersStartTimeoutMs: 30, dockerStartTimeoutMs: 30, dockerStopTimeoutMs: 30, dockerPollMs: 1, wakeTimeoutMs: 2_000 },
    kill: () => { throw new Error('no real signals in fake tests'); },
    ...over,
  };
}
function svc(id: string, spec: ServiceSpec, ports: ManagedService['ports'] = []): ManagedService {
  return { id, name: id, spec, ports, idleMinutes: 240, pinned: false, managed: true, source: 'discovered' };
}
function ctx(over: Partial<ProbeCtx> = {}): ProbeCtx {
  return { conns: new Map(), dockerUp: true, ps: [], stats: [], prevStats: new Map(), ...over };
}
const ci = (name: string, running: boolean): ContainerInfo => ({ name, running, ports: '', labels: '', id: name });
const st = (name: string, cpuPct: number, net = 0): StatsRow => ({ name, cpuPct, memMB: 100, netRxBytes: net, netTxBytes: 0 });
const psLine = (name: string, state: string): string => JSON.stringify({ Names: name, State: state, Ports: '', Labels: '', ID: name });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-drivers-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fileA = path.join(tmp, 'compose.yml');
const fileB = path.join(tmp, 'compose.override.yml');
fs.writeFileSync(fileA, '');
fs.writeFileSync(fileB, '');
const HOME_CWD = os.homedir();

test('listeningPids: lsof -Fp lines, deduped and sorted, never our own pid', () => {
  assert.deepEqual(listeningPids(`p4242\nf12\np17\np4242\np${process.pid}\nnonsense\n`), [17, 4242]);
  assert.deepEqual(listeningPids(''), []);
});

test('dockerDesktopUp: pgrep first, docker info only when the backend runs', async () => {
  const down = fakeExec((cmd) => (cmd === 'pgrep' ? null : 'x'));
  assert.equal(await dockerDesktopUp(down.exec), false);
  assert.deepEqual(down.calls.map(argv), ['pgrep -q com.docker.backend']);
  const up = fakeExec(() => '27.4.0');
  assert.equal(await dockerDesktopUp(up.exec), true);
  assert.equal(up.calls[1].cmd, 'docker');
  assert.equal(up.calls[1].args[0], 'info');
  assert.equal(up.calls[1].timeoutMs, 10_000);
  const sick = fakeExec((cmd) => (cmd === 'pgrep' ? '' : null));
  assert.equal(await dockerDesktopUp(sick.exec), false);
});

test('compose: start and stop with every config file, never down/rm', async () => {
  const s = svc('compose:vita', { kind: 'compose', project: 'vita', configFiles: [fileA, fileB], projectDir: tmp, containers: ['vita-db', 'vita-web'] });
  const { exec, calls } = fakeExec((cmd, args) => (args[0] === 'ps' ? [psLine('vita-db', 'running'), psLine('vita-web', 'running'), psLine('other', 'running')].join('\n') : ''));
  const d = createDrivers(deps(exec));
  assert.deepEqual(await d.compose.stop(s), { ok: true });
  assert.deepEqual(await d.compose.start(s), { ok: true });
  assert.deepEqual(calls.map(argv), [
    `docker compose -p vita -f ${fileA} -f ${fileB} stop -t 30`,
    `docker compose -p vita -f ${fileA} -f ${fileB} start`,
    "docker ps -a --format {{json .}}",
  ]);
  noForbidden(calls);
});

test('compose: a missing config file falls back to docker start/stop by names', async () => {
  const s = svc('compose:gone', { kind: 'compose', project: 'gone', configFiles: [fileA, path.join(tmp, 'missing.yml')], projectDir: tmp, containers: ['n1', 'n2'] });
  const { exec, calls } = fakeExec((cmd, args) => (args[0] === 'ps' ? `${psLine('n1', 'running')}\n${psLine('n2', 'exited')}` : ''));
  const d = createDrivers(deps(exec));
  const started = await d.compose.start(s);
  // Started is started; a container that falls over again is reported in `error`, not failed.
  assert.equal(started.ok, true);
  assert.match(started.error ?? '', /n2/);
  await d.compose.stop(s);
  const docker = calls.filter((c) => c.args[0] !== 'ps').map(argv);
  assert.deepEqual(docker, ['docker start n1 n2', 'docker stop -t 30 n1 n2']);
  noForbidden(calls);
});

test('containers: by names only; a failed command is ok:false', async () => {
  const s = svc('containers:shelly-monitor', { kind: 'containers', containers: ['supabase_db_shelly', 'supabase_kong_shelly'], projectDir: null });
  const ok = fakeExec((cmd, args) => (args[0] === 'ps' ? `${psLine('supabase_db_shelly', 'running')}\n${psLine('supabase_kong_shelly', 'running')}` : ''));
  const d = createDrivers(deps(ok.exec));
  assert.deepEqual(await d.containers.start(s), { ok: true });
  assert.deepEqual(await d.containers.stop(s), { ok: true });
  assert.deepEqual(ok.calls.filter((c) => c.args[0] !== 'ps').map(argv), ['docker start supabase_db_shelly supabase_kong_shelly', 'docker stop -t 30 supabase_db_shelly supabase_kong_shelly']);
  noForbidden(ok.calls);
  const bad = fakeExec(() => null);
  const r = await createDrivers(deps(bad.exec)).containers.stop(s);
  assert.equal(r.ok, false);
  noForbidden(bad.calls);
});

test('compose/containers probe: running names, cpu/mem sums, activity from stats and conns', async () => {
  const d = createDrivers(deps(fakeExec(() => { throw new Error('probe runs no commands'); }).exec));
  const s = svc('compose:vita', { kind: 'compose', project: 'vita', configFiles: [], projectDir: null, containers: ['a', 'b'] }, [{ port: 55423, host: '0.0.0.0' }]);
  const quiet = await d.compose.probe(s, ctx({ ps: [ci('a', true), ci('b', false), ci('x', true)], stats: [st('a', 0.5), st('x', 90)], prevStats: new Map([['a', st('a', 0)]]) }));
  assert.equal(quiet.awake, true);
  assert.deepEqual(quiet.runningContainers, ['a']);
  assert.equal(quiet.cpuPct, 0.5);
  assert.equal(quiet.memMB, 100);
  assert.equal(quiet.active, false);
  const busy = await d.compose.probe(s, ctx({ ps: [ci('a', true)], stats: [st('a', 0.5, 999)], prevStats: new Map([['a', st('a', 0)]]) }));
  assert.equal(busy.active, true);
  const conn = await d.compose.probe(s, ctx({ ps: [ci('a', true)], stats: [st('a', 0)], conns: new Map([[55423, 2]]) }));
  assert.equal(conn.conns, 2);
  assert.equal(conn.active, true);
  const off = await d.compose.probe(s, ctx({ dockerUp: false, ps: null }));
  assert.equal(off.awake, false);
  assert.equal(off.detail, 'Docker is off');
  const stopped = await d.containers.probe(svc('containers:c', { kind: 'containers', containers: ['b'], projectDir: null }), ctx({ ps: [ci('b', false)] }));
  assert.equal(stopped.awake, false);
});

test('docker-desktop: `docker desktop start` / `stop`, then waits for the engine', async () => {
  let up = false;
  const { exec, calls } = fakeExec((cmd, args) => {
    if (cmd === 'pgrep') return up ? '' : null;
    if (args[0] === 'desktop' && args[1] === 'start') { up = true; return ''; }
    if (args[0] === 'desktop' && args[1] === 'stop') { up = false; return ''; }
    if (args[0] === 'info') return up ? '27.4.0' : null;
    return null;
  });
  const d = createDrivers(deps(exec));
  assert.deepEqual(await d['docker-desktop'].start(svc('docker-desktop', { kind: 'docker-desktop' })), { ok: true });
  assert.ok(calls.some((c) => argv(c) === 'docker desktop start'));
  assert.deepEqual(await d['docker-desktop'].stop(svc('docker-desktop', { kind: 'docker-desktop' })), { ok: true });
  assert.ok(calls.some((c) => argv(c) === 'docker desktop stop'));
  // Already up → start runs nothing; already down → stop runs nothing.
  const n = calls.length;
  assert.deepEqual(await d['docker-desktop'].stop(svc('docker-desktop', { kind: 'docker-desktop' })), { ok: true });
  assert.ok(!calls.slice(n).some((c) => c.args[0] === 'desktop'));
  noForbidden(calls);

  const stuck = fakeExec((cmd) => (cmd === 'pgrep' ? null : ''));
  const r = await createDrivers(deps(stuck.exec))['docker-desktop'].start(svc('docker-desktop', { kind: 'docker-desktop' }));
  assert.equal(r.ok, false);
});

test('docker-desktop probe: from the tick context, lists every running container', async () => {
  const d = createDrivers(deps(fakeExec(() => { throw new Error('probe runs no commands'); }).exec));
  const p = await d['docker-desktop'].probe(svc('docker-desktop', { kind: 'docker-desktop' }), ctx({ ps: [ci('arrow', true), ci('old', false)] }));
  assert.equal(p.awake, true);
  assert.deepEqual(p.runningContainers, ['arrow']);
  assert.equal((await d['docker-desktop'].probe(svc('docker-desktop', { kind: 'docker-desktop' }), ctx({ dockerUp: false, ps: null }))).awake, false);
});

const proc = (over: Partial<Extract<ServiceSpec, { kind: 'process' }>> = {}): Extract<ServiceSpec, { kind: 'process' }> => ({
  kind: 'process', cmd: 'node', args: ['server.mjs'], cwd: HOME_CWD, logFile: path.join(tmp, 'svc.log'), ...over,
});

test('process start refuses ssh and a cwd outside the home folder — nothing spawned', async () => {
  let spawned = 0;
  const d = createDrivers(deps(fakeExec(() => null).exec, { spawnDetached: () => { spawned++; return { pid: 1234 }; } }));
  for (const cmd of ['ssh', '/usr/bin/ssh']) {
    const r = await d.process.start(svc('p', proc({ cmd }), [{ port: 1, host: '127.0.0.1' }]));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /refused/);
  }
  for (const cwd of ['/tmp', '/', 'relative/dir', path.join(HOME_CWD, '..')]) {
    const r = await d.process.start(svc('p', proc({ cwd }), [{ port: 1, host: '127.0.0.1' }]));
    assert.equal(r.ok, false, cwd);
  }
  assert.equal(spawned, 0);
});

test('process stop: SIGTERM, then SIGKILL when it does not go; signals only the listening pid', async () => {
  const signals: Array<[number, string | 0]> = [];
  let alive = true;
  const { exec, calls } = fakeExec((cmd) => {
    if (cmd === 'lsof') return alive ? 'p4242\n' : null;
    if (cmd === 'ps') return '4242 4200\n';
    return null;
  });
  const d = createDrivers(deps(exec, { kill: (pid, sig) => { signals.push([pid, sig]); if (sig === 'SIGKILL') alive = false; } }));
  const s = svc('p', proc(), [{ port: 59999, host: '127.0.0.1' }]);
  assert.deepEqual(await d.process.stop(s), { ok: true });
  assert.deepEqual(signals, [[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
  assert.ok(calls.some((c) => argv(c) === 'lsof -nP -iTCP:59999 -sTCP:LISTEN -Fp'));
  noForbidden(calls);
});

test('process stop: nothing listening → ok, no signal at all', async () => {
  const signals: unknown[] = [];
  const d = createDrivers(deps(fakeExec(() => null).exec, { kill: (...a) => { signals.push(a); } }));
  assert.deepEqual(await d.process.stop(svc('p', proc(), [{ port: 59998, host: '127.0.0.1' }])), { ok: true });
  assert.deepEqual(signals, []);
});

test('process: a group this session spawned is signalled as a group (-pgid)', async () => {
  // A real listener stands in for the spawned service so the readiness check passes.
  const server = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const signals: Array<[number, string | 0]> = [];
  let alive = true;
  const { exec } = fakeExec((cmd) => {
    if (cmd === 'lsof') return alive ? 'p778\n' : null;
    if (cmd === 'ps') return '778 777\n';
    return null;
  });
  let spawnedWith: { cmd: string; env: NodeJS.ProcessEnv } | null = null;
  const d = createDrivers(deps(exec, {
    env: () => ({ PATH: '/x', KEEP: '1' }),
    spawnDetached: (cmd, _a, o) => { spawnedWith = { cmd, env: o.env }; return { pid: 777 }; },
    kill: (pid, sig) => { signals.push([pid, sig]); if (sig === 'SIGTERM') alive = false; },
  }));
  const s = svc('p', proc({ env: { ATLAS_DASH_MODE: 'on-demand' } }), [{ port, host: '127.0.0.1' }]);
  // Asleep while starting (lsof finds nothing), then 778 in the group of the spawned 777 listens.
  alive = false;
  const started = await d.process.start(s);
  alive = true;
  assert.deepEqual(started, { ok: true });
  assert.equal(spawnedWith!.cmd, 'node');
  assert.deepEqual(spawnedWith!.env, { PATH: '/x', KEEP: '1', ATLAS_DASH_MODE: 'on-demand' });
  assert.deepEqual(await d.process.stop(s), { ok: true });
  assert.deepEqual(signals.filter(([, sig]) => sig !== 0), [[-777, 'SIGTERM']]);
  await new Promise<void>((r) => server.close(() => r()));
});

test('process start: a child that dies before it is ready is reported, not waited on', async () => {
  const d = createDrivers(deps(fakeExec(() => null).exec, {
    spawnDetached: () => ({ pid: 999_001 }),
    kill: (_pid, sig) => { if (sig === 0) throw new Error('ESRCH'); },
  }));
  const r = await d.process.start(svc('p', proc(), [{ port: 59997, host: '127.0.0.1' }]));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /exited before it was ready/);
});

// ---- live: one real round trip of the process driver ------------------------

/** Real exec for the live test — refuses anything but lsof and ps. */
const liveExec: Exec = (cmd, args, timeoutMs) => {
  if (cmd !== 'lsof' && cmd !== 'ps') return Promise.reject(new Error(`live test runs only lsof/ps, not ${cmd}`));
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout));
  });
};

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test('live: python3 http.server — start → probe awake with its pid → stop → port free', async () => {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(HOME_CWD, '.pf-drivers-live-'));
  const logFile = path.join(tmp, 'http.log');
  let spawnedPid = 0;
  try {
    const d = createDrivers({
      exec: liveExec, env: () => process.env, log: () => {},
      timing: { pollMs: 100, wakeTimeoutMs: 15_000, stopGraceMs: 5_000, stopKillMs: 3_000 },
      spawnDetached: (cmd, args, o) => {
        // Default spawn behaviour, but remember the pid so `after` can clean up whatever happens.
        const fd = fs.openSync(o.logFile, 'a');
        try {
          const c = spawn(cmd, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', fd, fd] });
          c.unref();
          spawnedPid = c.pid ?? 0;
          return { pid: spawnedPid };
        } finally { fs.closeSync(fd); }
      },
    });
    const s = svc('live-http', { kind: 'process', cmd: 'python3', args: ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], cwd, logFile, health: `http://127.0.0.1:${port}/` }, [{ port, host: '127.0.0.1' }]);

    assert.equal((await d.process.probe(s, ctx())).awake, false);
    const started = await d.process.start(s);
    assert.deepEqual(started, { ok: true }, fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
    const p = await d.process.probe(s, ctx({ conns: new Map([[port, 1]]) }));
    assert.equal(p.awake, true);
    assert.ok(p.pids.includes(spawnedPid), `probe pids ${p.pids} include spawned ${spawnedPid}`);
    assert.equal(p.conns, 1);
    assert.ok(p.memMB !== null && p.memMB > 0);
    assert.deepEqual(await d.process.stop(s), { ok: true });
    assert.equal((await d.process.probe(s, ctx())).awake, false);
    // Port free: we can bind it again.
    const again = net.createServer();
    await new Promise<void>((resolve, reject) => { again.once('error', reject); again.listen(port, '127.0.0.1', resolve); });
    await new Promise<void>((r) => again.close(() => r()));
  } finally {
    if (spawnedPid) { try { process.kill(-spawnedPid, 'SIGKILL'); } catch { /* already gone */ } }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
