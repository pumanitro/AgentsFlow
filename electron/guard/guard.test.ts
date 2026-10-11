import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import type { GuardSnapshot, KillLogEntry } from '../../shared/types';
import type { ClaudeAgentJsonRow } from '../claude-cli';
import type { Exec } from './docker-inventory';
import { parseDockerPsJson } from './docker-inventory';
import {
  GUARD_TICK_MS, __resetGuardForTests, __setGuardFilesForTests, getGuardSnapshot, getMemLevel, runGuardOnce, setPins,
} from './guard';
import type { GuardDeps } from './guard';
import { fixture } from './test-fixtures';

// Everything here runs against a temp dir and a fake exec. The fake answers the
// read-only commands with the captured fixtures and only RECORDS `docker stop`;
// any other command fails the test, so nothing real can ever be run from here.

const T0 = Date.parse('2026-10-11T09:20:00Z');      // fixture containers started 07:49Z
const HOUR = 60 * 60_000;

const logLines: string[] = [];
const realLog = console.log;
const realWarn = console.warn;
console.log = (...a: unknown[]) => { logLines.push(a.map(String).join(' ')); };
console.warn = (...a: unknown[]) => { logLines.push(a.map(String).join(' ')); };
after(() => { console.log = realLog; console.warn = realWarn; __resetGuardForTests(); });

interface Harness {
  dir: string; pins: string; killLog: string; admission: string;
  state: { now: number; vm: string | null; pressure: string; swap: string; dockerUp: boolean; statsFail: boolean; stopResult: string | null; liveRows: ClaudeAgentJsonRow[] };
  calls: string[][]; stops: () => string[][]; notes: Array<[string, string]>; snaps: GuardSnapshot[];
  deps: GuardDeps; tick: (advanceMs?: number) => Promise<void>; killEntries: () => KillLogEntry[];
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const h = {
    dir,
    pins: path.join(dir, 'locks', 'memguard-pins.json'),
    killLog: path.join(dir, 'locks', 'memguard-kills.jsonl'),
    admission: path.join(dir, 'locks', 'mem-admission-closed'),
    state: { now: T0, vm: fixture('vm_stat.txt') as string | null, pressure: '1\n', swap: fixture('swapusage.txt'), dockerUp: true, statsFail: false, stopResult: 'ok\n' as string | null, liveRows: [] as ClaudeAgentJsonRow[] },
    calls: [] as string[][],
    notes: [] as Array<[string, string]>,
    snaps: [] as GuardSnapshot[],
  };
  const stopped = new Set<string>();
  const exec: Exec = async (cmd, args) => {
    h.calls.push([cmd, ...args]);
    if (cmd === 'vm_stat') return h.state.vm;
    if (cmd === 'sysctl' && args[1] === 'kern.memorystatus_vm_pressure_level') return h.state.pressure;
    if (cmd === 'sysctl' && args[1] === 'vm.swapusage') return h.state.swap;
    if (cmd === 'pgrep') return h.state.dockerUp ? '' : null;
    if (cmd === 'netstat') return fixture('netstat-established.txt');
    if (cmd === 'docker') {
      if (args[0] === 'ps') {
        return fixture('docker-ps.jsonl').split('\n').filter(Boolean).map((l) => {
          const j = JSON.parse(l);
          if (stopped.has(j.Names)) j.State = 'exited';
          return JSON.stringify(j);
        }).join('\n');
      }
      if (args[0] === 'inspect') return fixture('docker-inspect.tsv');
      if (args[0] === 'stats') return h.state.statsFail ? null : fixture('docker-stats.tsv').split('\n').filter((l) => !stopped.has(l.split('\t')[0])).join('\n');
      if (args[0] === 'compose') return fixture('docker-compose-ls.json');
      if (args[0] === 'stop' && args.length === 2) {          // recorded, never executed
        if (h.state.stopResult !== null) stopped.add(args[1]);
        return h.state.stopResult;
      }
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
  const deps: GuardDeps = {
    liveRows: () => h.state.liveRows,
    getConversations: () => [],
    notify: (t, b) => { h.notes.push([t, b]); },
    onSnapshot: (s) => { h.snaps.push(s); },
    exec,
    now: () => h.state.now,
  };
  __resetGuardForTests();
  __setGuardFilesForTests({ pins: h.pins, killLog: h.killLog, admission: h.admission });
  return {
    ...h, deps,
    stops: () => h.calls.filter((c) => c[0] === 'docker' && c[1] === 'stop'),
    tick: async (advanceMs = 0) => { h.state.now += advanceMs; await runGuardOnce(deps); },
    killEntries: () => (fs.existsSync(h.killLog) ? fs.readFileSync(h.killLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as KillLogEntry) : []),
  };
}

function liveRow(cwd: string): ClaudeAgentJsonRow {
  return { pid: 4242, cwd, kind: 'bg', startedAt: T0, sessionId: 'abc12345-0000' };
}
function writeLivePins(h: Harness, keep: string[] = []): void {
  fs.mkdirSync(path.dirname(h.pins), { recursive: true });
  fs.writeFileSync(h.pins, JSON.stringify({ version: 1, keep, mode: 'live', idleMinutes: 120 }));
}
/** One calm tick (inventory; every container first seen), then three hours later two kernel-critical ticks. */
async function driveToCritical(h: Harness): Promise<void> {
  await h.tick();
  h.state.pressure = '4\n';
  await h.tick(3 * HOUR);
  await h.tick(GUARD_TICK_MS);
}
const RUNNING = parseDockerPsJson(fixture('docker-ps.jsonl')).filter((c) => c.running).map((c) => c.name).sort((a, b) => a.localeCompare(b));

test('before the first tick: level unknown, dry-run, nothing listed', () => {
  harness();
  const s = getGuardSnapshot();
  assert.equal(s.level, 'unknown');
  assert.equal(s.mode, 'dry-run');
  assert.equal(s.idleMinutes, 120);
  assert.deepEqual(s.containers, []);
  assert.equal(s.admissionClosed, false);
  assert.equal(getMemLevel(), 'unknown');
});

test('tick: samples memory with the three read-only commands and reaches ok after two clean ticks', async () => {
  const h = harness();
  await h.tick();
  assert.equal(getMemLevel(), 'unknown');
  await h.tick(GUARD_TICK_MS);
  assert.equal(getMemLevel(), 'ok');
  assert.deepEqual(h.calls.slice(0, 3), [['vm_stat'], ['sysctl', '-n', 'kern.memorystatus_vm_pressure_level'], ['sysctl', '-n', 'vm.swapusage']]);
  const s = getGuardSnapshot();
  assert.equal(s.level, 'ok');
  assert.equal(s.sample?.compressedGB, 0);
  assert.equal(s.sample?.pressure, 1);
  assert.equal(s.swapGrowthGBper5min, null);
  assert.equal(s.at, new Date(T0 + GUARD_TICK_MS).toISOString());
  assert.equal(h.snaps.length, 2);
  assert.deepEqual(h.snaps[1], s);
});

test('tick: one row per running container from the real inventory; none is a candidate on first sight', async () => {
  const h = harness();
  await h.tick();
  const rows = getGuardSnapshot().containers;
  assert.deepEqual(rows.map((r) => r.name), RUNNING);
  assert.equal(rows.length, 31);
  assert.ok(rows.every((r) => r.running && r.verdict === 'keep-young'), rows.map((r) => r.verdict).join(','));
  const ui = rows.find((r) => r.name === 'customer-ui');
  assert.deepEqual(
    { project: ui?.project, projectDir: ui?.projectDir, ports: ui?.publishedPorts, mem: ui?.memMB, cpu: ui?.cpuPct, pinned: ui?.pinned },
    { project: 'vitaminology', projectDir: '/Users/iij/IdeaProjects/nutrable/develop/.cache', ports: [4001], mem: 361, cpu: 0.02, pinned: false },
  );
  // exited containers the guard did not stop are not listed
  assert.equal(rows.find((r) => r.name === 'pe-db'), undefined);
});

test('tick: the inventory is refreshed every second tick, memory every tick', async () => {
  const h = harness();
  for (let i = 0; i < 4; i++) await h.tick(i === 0 ? 0 : GUARD_TICK_MS);
  assert.equal(h.calls.filter((c) => c[0] === 'vm_stat').length, 4);
  assert.equal(h.calls.filter((c) => c[0] === 'docker' && c[1] === 'ps').length, 2);
  assert.equal(h.stops().length, 0);
});

test('admission file: written while closed, rewritten each tick, removed again at ok', async () => {
  const h = harness();
  h.state.vm = fixture('vm_stat-compressed-synthetic.txt');     // compressed 56.8 GB: warn, never critical
  await h.tick();
  assert.equal(getMemLevel(), 'warn');
  assert.equal(fs.existsSync(h.admission), false);
  for (let i = 0; i < 9; i++) await h.tick(GUARD_TICK_MS);
  assert.equal(getMemLevel(), 'warn');                          // 4.5 min
  await h.tick(GUARD_TICK_MS);
  assert.equal(getMemLevel(), 'closed');
  const closedAt = T0 + 10 * GUARD_TICK_MS;
  const body = JSON.parse(fs.readFileSync(h.admission, 'utf8'));
  assert.deepEqual(Object.keys(body).sort(), ['level', 'reason', 'since', 'writtenAt']);
  assert.equal(body.level, 'closed');
  assert.equal(body.since, new Date(closedAt).toISOString());
  assert.equal(body.writtenAt, new Date(closedAt).toISOString());
  assert.match(body.reason, /compressed 56\.8 GB > 32/);
  assert.equal(getGuardSnapshot().admissionClosed, true);

  await h.tick(GUARD_TICK_MS);
  const again = JSON.parse(fs.readFileSync(h.admission, 'utf8'));
  assert.equal(again.since, body.since);
  assert.equal(again.writtenAt, new Date(closedAt + GUARD_TICK_MS).toISOString());

  h.state.vm = fixture('vm_stat.txt');
  await h.tick(GUARD_TICK_MS);
  assert.equal(getMemLevel(), 'closed');                        // held for one clean tick
  assert.equal(fs.existsSync(h.admission), true);
  await h.tick(GUARD_TICK_MS);
  assert.equal(getMemLevel(), 'ok');
  assert.equal(fs.existsSync(h.admission), false);
  assert.equal(getGuardSnapshot().admissionClosed, false);
  assert.deepEqual(fs.readdirSync(path.dirname(h.admission)), []);   // no temp file left behind
  assert.equal(h.stops().length, 0);
});

test('admission file: written at critical, absent at warn, and a stale one from a previous run is removed at ok', async () => {
  const h = harness();
  fs.mkdirSync(path.dirname(h.admission), { recursive: true });
  fs.writeFileSync(h.admission, '{"level":"closed"}');
  await h.tick();
  await h.tick(GUARD_TICK_MS);
  assert.equal(getMemLevel(), 'ok');
  assert.equal(fs.existsSync(h.admission), false);

  h.state.pressure = '4\n';
  await h.tick(GUARD_TICK_MS);
  assert.equal(getMemLevel(), 'warn');
  assert.equal(fs.existsSync(h.admission), false);
  await h.tick(GUARD_TICK_MS);
  assert.equal(getMemLevel(), 'critical');
  assert.equal(JSON.parse(fs.readFileSync(h.admission, 'utf8')).level, 'critical');
});

test('unknown: an unreadable sample is level unknown, leaves the admission file alone and stops nothing', async () => {
  const h = harness();
  writeLivePins(h);
  fs.writeFileSync(h.admission, '{"level":"closed"}');
  h.state.vm = null;
  await h.tick();
  await h.tick(3 * HOUR);
  await h.tick(GUARD_TICK_MS);
  assert.equal(getMemLevel(), 'unknown');
  assert.deepEqual(getGuardSnapshot().reasons, ['memory sample unreadable']);
  assert.equal(getGuardSnapshot().sample, null);
  assert.equal(fs.readFileSync(h.admission, 'utf8'), '{"level":"closed"}');
  assert.equal(h.stops().length, 0);
});

test('DRY-RUN (no pins file): at critical the guard logs WOULD-STOP and never runs `docker stop`', async () => {
  const h = harness();
  await driveToCritical(h);
  const s = getGuardSnapshot();
  assert.equal(s.level, 'critical');
  assert.equal(s.mode, 'dry-run');
  assert.equal(fs.existsSync(h.pins), false);
  assert.equal(s.containers.filter((r) => r.verdict === 'stop-candidate' || r.verdict === 'stopping').length, 31);

  assert.deepEqual(h.stops(), []);
  assert.ok(h.calls.every((c) => !(c[0] === 'docker' && ['stop', 'kill', 'rm'].includes(c[1]))));
  assert.deepEqual(h.notes, []);
  const entries = h.killEntries();
  assert.deepEqual(entries.map((e) => e.name), RUNNING.filter((n) => n !== 'redis').slice(0, 2));
  assert.ok(entries.every((e) => e.dry === true && e.by === 'peersflow-guard' && e.kind === 'container'));
  assert.match(entries[0].reason, /^memory critical — idle 3h00m, project /);
  assert.deepEqual(s.recent.map((e) => e.name).sort(), entries.map((e) => e.name).sort());
  assert.equal(logLines.filter((l) => l.includes(`WOULD-STOP ${entries[0].name} (dry-run)`)).length, 1);
  // nothing was stopped: every container is still listed as running
  assert.ok(s.containers.every((r) => r.running));
});

test('DRY-RUN: the next critical ticks move on to other containers instead of repeating — still no stop', async () => {
  const h = harness();
  await driveToCritical(h);
  for (let i = 0; i < 4; i++) await h.tick(GUARD_TICK_MS);
  const names = h.killEntries().map((e) => e.name);
  assert.equal(names.length, 10);                               // 2 per tick × 5 critical ticks
  assert.equal(new Set(names).size, 10);
  assert.deepEqual(h.stops(), []);
  assert.deepEqual(h.notes, []);
  assert.ok(h.killEntries().every((e) => e.dry));
  const logged = getGuardSnapshot().containers.find((r) => r.name === names[0]);
  assert.match(logged?.note ?? '', /already logged as WOULD-STOP \(dry-run\)/);
});

test('DRY-RUN: a pins file that says anything but "live" is dry-run', async () => {
  const h = harness();
  fs.mkdirSync(path.dirname(h.pins), { recursive: true });
  fs.writeFileSync(h.pins, JSON.stringify({ version: 1, keep: [], mode: 'LIVE', idleMinutes: 120 }));
  await driveToCritical(h);
  assert.equal(getGuardSnapshot().mode, 'dry-run');
  assert.deepEqual(h.stops(), []);
  assert.equal(h.killEntries().length, 2);
});

test('LIVE: at critical exactly `docker stop <name>` for the two longest-idle unprotected containers', async () => {
  const h = harness();
  writeLivePins(h, ['admin-ui']);
  h.state.liveRows = [liveRow('/Users/iij/IdeaProjects/arrow/src')];
  await driveToCritical(h);
  const expected = RUNNING.filter((n) => !['admin-ui', 'arrow-db-1', 'redis'].includes(n)).slice(0, 2);
  assert.deepEqual(h.stops(), expected.map((n) => ['docker', 'stop', n]));

  const s = getGuardSnapshot();
  assert.equal(s.mode, 'live');
  const by = (n: string) => s.containers.find((r) => r.name === n);
  assert.equal(by('admin-ui')?.verdict, 'keep-pinned');
  assert.equal(by('admin-ui')?.pinned, true);
  assert.equal(by('arrow-db-1')?.verdict, 'keep-live-chat');
  for (const n of expected) {
    assert.equal(by(n)?.verdict, 'stopped-by-guard');
    assert.equal(by(n)?.running, false);
    assert.match(by(n)?.note ?? '', new RegExp(`docker start ${n}$`));
  }
  const entries = h.killEntries();
  assert.deepEqual(entries.map((e) => [e.name, e.dry]), expected.map((n) => [n, false]));
  assert.deepEqual(s.recent.map((e) => e.name).sort(), [...expected].sort());
});

test('LIVE: pinned and live-chat containers are never stopped, however long critical lasts', async () => {
  const h = harness();
  writeLivePins(h, ['admin-ui', 'supabase_db_shelly-monitor']);
  h.state.liveRows = [liveRow('/Users/iij/IdeaProjects/nutrable/develop/.cache')];   // the vitaminology project dir
  await driveToCritical(h);
  for (let i = 0; i < 30; i++) await h.tick(GUARD_TICK_MS);
  const stoppedNames = h.stops().map((c) => c[2]);
  assert.ok(h.stops().every((c) => c.length === 3));
  assert.equal(new Set(stoppedNames).size, stoppedNames.length);          // nothing stopped twice
  const vitaminology = ['collections-api', 'search-api', 'customer-ui', 'admin-ui', 'consultations-api', 'notifications-api', 'billing-api', 'auth-api', 'vpn', 'api-common', 'notifications-api-foundation-emails'];
  for (const n of [...vitaminology, 'supabase_db_shelly-monitor']) assert.ok(!stoppedNames.includes(n), n);
  // everything else (31 − 11 − 1 pinned) went, redis included after its notice
  assert.equal(stoppedNames.length, 19);
  assert.ok(stoppedNames.includes('redis'));
  const s = getGuardSnapshot();
  assert.equal(s.containers.filter((r) => r.verdict === 'stopped-by-guard').length, 19);
  assert.equal(s.containers.filter((r) => r.running).length, 12);
});

test('supabase project: the folder is recovered for all 12 containers, and a chat in that repo protects them', async () => {
  const h = harness();
  writeLivePins(h);
  h.state.liveRows = [liveRow('/Users/iij/Desktop/ai-factory/ai-factory-brain/src')];
  await driveToCritical(h);
  for (let i = 0; i < 30; i++) await h.tick(GUARD_TICK_MS);
  const supabase = getGuardSnapshot().containers.filter((r) => r.name.startsWith('supabase_'));
  assert.equal(supabase.length, 11);                           // 12 exist, one was already exited
  assert.ok(supabase.every((r) => r.projectDir === '/Users/iij/Desktop/ai-factory/ai-factory-brain' && r.verdict === 'keep-live-chat'));
  assert.ok(h.stops().every((c) => !c[2].startsWith('supabase_')));
});

test('vitaminology: a chat in the repo root above the compose folder protects all of its containers', async () => {
  const h = harness();
  writeLivePins(h);
  h.state.liveRows = [liveRow('/Users/iij/IdeaProjects/nutrable')];
  await driveToCritical(h);
  for (let i = 0; i < 30; i++) await h.tick(GUARD_TICK_MS);
  const rows = getGuardSnapshot().containers.filter((r) => r.project === 'vitaminology');
  assert.equal(rows.length, 11);
  assert.ok(rows.every((r) => r.verdict === 'keep-live-chat' && r.running));
  assert.equal(h.stops().length, 20);                           // everything else went
});

test('a chat sitting in the home dir or / protects nothing', async () => {
  const h = harness();
  writeLivePins(h);
  h.state.liveRows = [liveRow(os.homedir()), liveRow('/'), liveRow('/Users')];
  await driveToCritical(h);
  assert.equal(getGuardSnapshot().containers.filter((r) => r.verdict === 'keep-live-chat').length, 0);
  assert.equal(h.stops().length, 2);
});

test('LIVE: never more than two stops in one tick', async () => {
  const h = harness();
  writeLivePins(h);
  await driveToCritical(h);
  assert.equal(h.stops().length, 2);
  await h.tick(GUARD_TICK_MS);
  assert.equal(h.stops().length, 4);
});

test('LIVE: a container with no project gets the notification first and is stopped only 60 s later', async () => {
  const h = harness();
  writeLivePins(h, RUNNING.filter((n) => n !== 'redis'));       // only redis is unprotected
  await driveToCritical(h);
  assert.deepEqual(h.notes, [['Memory guard', 'Memory critical — stopping container redis in 60 s. Pin it in Performance › Memory guard to keep it.']]);
  assert.deepEqual(h.stops(), []);
  const noticed = getGuardSnapshot().containers.find((r) => r.name === 'redis');
  assert.equal(noticed?.verdict, 'stopping');
  assert.equal(noticed?.stoppingAt, new Date(T0 + 3 * HOUR + GUARD_TICK_MS + 60_000).toISOString());
  await h.tick(GUARD_TICK_MS);                                  // 30 s in: still waiting
  assert.equal(getGuardSnapshot().containers.find((r) => r.name === 'redis')?.verdict, 'stopping');
  assert.deepEqual(h.stops(), []);
  await h.tick(GUARD_TICK_MS);
  assert.deepEqual(h.stops(), [['docker', 'stop', 'redis']]);
  assert.equal(h.notes.length, 1);
});

test('LIVE: pinning a noticed container withdraws the stop at once', async () => {
  const h = harness();
  writeLivePins(h, RUNNING.filter((n) => n !== 'redis'));
  await driveToCritical(h);
  await h.tick(GUARD_TICK_MS);
  assert.equal(getGuardSnapshot().containers.find((r) => r.name === 'redis')?.verdict, 'stopping');
  const before = h.snaps.length;
  const pins = setPins({ keep: { name: 'redis', keep: true } });
  assert.ok(pins.keep.includes('redis'));
  assert.equal(h.snaps.length, before + 1);                    // re-evaluated and pushed immediately, no command run
  const row = getGuardSnapshot().containers.find((r) => r.name === 'redis');
  assert.equal(row?.verdict, 'keep-pinned');
  assert.equal(row?.stoppingAt, undefined);
  for (let i = 0; i < 4; i++) await h.tick(GUARD_TICK_MS);
  assert.deepEqual(h.stops(), []);
});

test('LIVE: a notice is dropped when the level leaves critical, and nothing more is stopped', async () => {
  const h = harness();
  writeLivePins(h, RUNNING.filter((n) => n !== 'redis'));
  await driveToCritical(h);
  h.state.pressure = '1\n';
  await h.tick(GUARD_TICK_MS);
  assert.equal(getMemLevel(), 'closed');
  await h.tick(GUARD_TICK_MS);
  await h.tick(GUARD_TICK_MS);
  assert.equal(getMemLevel(), 'ok');
  assert.deepEqual(h.stops(), []);
  assert.equal(getGuardSnapshot().containers.find((r) => r.name === 'redis')?.verdict, 'stop-candidate');
});

test('LIVE: a failed `docker stop` writes no kill-log entry and is not retried every tick', async () => {
  const h = harness();
  writeLivePins(h);
  h.state.stopResult = null;
  await driveToCritical(h);
  const first = h.stops().map((c) => c[2]);
  assert.equal(first.length, 2);
  assert.deepEqual(h.killEntries(), []);
  await h.tick(GUARD_TICK_MS);
  const second = h.stops().slice(2).map((c) => c[2]);
  assert.equal(second.length, 2);
  assert.ok(second.every((n) => !first.includes(n)));
  assert.ok(getGuardSnapshot().containers.every((r) => r.running));
});

test('LIVE: no trustworthy inventory ⇒ no rows and no stop (Docker down, or stats failing)', async () => {
  for (const breakIt of [(h: Harness) => { h.state.dockerUp = false; }, (h: Harness) => { h.state.statsFail = true; }]) {
    const h = harness();
    writeLivePins(h);
    await h.tick();
    h.state.pressure = '4\n';
    await h.tick(3 * HOUR);
    breakIt(h);
    for (let i = 0; i < 4; i++) await h.tick(GUARD_TICK_MS);
    assert.equal(getMemLevel(), 'critical');
    assert.deepEqual(getGuardSnapshot().containers, []);
    assert.deepEqual(h.stops(), []);
    assert.deepEqual(h.killEntries(), []);
  }
});

test('LIVE: critical inside the first idle window after launch stops nothing (every clock restarts with the app)', async () => {
  const h = harness();
  writeLivePins(h);
  await h.tick();
  h.state.pressure = '4\n';
  for (let i = 0; i < 20; i++) await h.tick(GUARD_TICK_MS);     // 10 minutes of critical
  assert.equal(getMemLevel(), 'critical');
  assert.ok(getGuardSnapshot().containers.every((r) => r.verdict === 'keep-young'));
  assert.deepEqual(h.stops(), []);
});

test('setPins: writes the pins file, merges the patch, defaults stay', async () => {
  const h = harness();
  assert.deepEqual(setPins({ keep: { name: 'arrow-db-1', keep: true } }), { version: 1, keep: ['arrow-db-1'], mode: 'dry-run', idleMinutes: 120 });
  assert.deepEqual(setPins({ keep: { name: 'admin-ui', keep: true }, idleMinutes: 45 }), { version: 1, keep: ['admin-ui', 'arrow-db-1'], mode: 'dry-run', idleMinutes: 45 });
  assert.deepEqual(setPins({ keep: { name: 'arrow-db-1', keep: false }, mode: 'live' }), { version: 1, keep: ['admin-ui'], mode: 'live', idleMinutes: 45 });
  assert.deepEqual(JSON.parse(fs.readFileSync(h.pins, 'utf8')), { version: 1, keep: ['admin-ui'], mode: 'live', idleMinutes: 45 });
  // nonsense is ignored field by field
  assert.deepEqual(setPins({ mode: 'yolo' as 'live', idleMinutes: -1 }), { version: 1, keep: ['admin-ui'], mode: 'live', idleMinutes: 45 });
  assert.deepEqual(setPins({ mode: 'dry-run' }).mode, 'dry-run');
  assert.deepEqual(fs.readdirSync(path.dirname(h.pins)), ['memguard-pins.json']);
});

test('setPins: the snapshot reflects the new mode and pin without waiting for a tick', async () => {
  const h = harness();
  await h.tick();
  setPins({ mode: 'live', idleMinutes: 30, keep: { name: 'customer-ui', keep: true } });
  const s = getGuardSnapshot();
  assert.equal(s.mode, 'live');
  assert.equal(s.idleMinutes, 30);
  assert.equal(s.containers.find((r) => r.name === 'customer-ui')?.verdict, 'keep-pinned');
  assert.deepEqual(h.stops(), []);
});

test('recent: kill-log lines written by the launchd memguard show up, newest first', async () => {
  const h = harness();
  fs.mkdirSync(path.dirname(h.killLog), { recursive: true });
  const a = { at: '2026-10-11T09:00:00.000Z', by: 'memguard-system', kind: 'process-group', name: 'vitest', dry: false, reason: 'critical', pgid: 1 };
  const b = { at: '2026-10-11T09:05:00.000Z', by: 'memguard-system', kind: 'process-group', name: 'playwright', dry: false, reason: 'critical', pgid: 2 };
  fs.writeFileSync(h.killLog, JSON.stringify(a) + '\n');
  await h.tick();
  assert.deepEqual(getGuardSnapshot().recent.map((e) => e.name), ['vitest']);
  fs.appendFileSync(h.killLog, JSON.stringify(b) + '\n');
  await h.tick(GUARD_TICK_MS);
  assert.deepEqual(getGuardSnapshot().recent.map((e) => e.name), ['playwright', 'vitest']);
});

test('runGuardOnce never throws: a throwing exec, liveRows or onSnapshot is swallowed', async () => {
  const h = harness();
  await runGuardOnce({ ...h.deps, exec: async () => { throw new Error('spawn EAGAIN'); } });
  await runGuardOnce({ ...h.deps, liveRows: () => { throw new Error('poller gone'); }, onSnapshot: () => { throw new Error('window gone'); } });
  assert.equal(getGuardSnapshot().containers.length, 31);
  assert.ok(logLines.some((l) => l.includes('[agentsflow][guard] tick failed')));
});
