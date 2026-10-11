import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  INSPECT_FORMAT, STATS_FORMAT, collectInventory, parseComposeLs, parseDockerPsJson, parseEstablishedPorts,
  parseInspectRows, parseStatsRows, publishedPorts, supabaseProjectDir,
} from './docker-inventory';
import type { Exec } from './docker-inventory';
import { fixture } from './test-fixtures';

test('parseDockerPsJson: the real `docker ps -a` capture — 43 containers, 31 running', () => {
  const rows = parseDockerPsJson(fixture('docker-ps.jsonl'));
  assert.equal(rows.length, 43);
  assert.equal(rows.filter((r) => r.running).length, 31);
  const studio = rows.find((r) => r.name === 'supabase_studio_shelly-monitor');
  assert.ok(studio);
  assert.equal(studio.running, true);
  assert.equal(studio.ports, '0.0.0.0:55423->3000/tcp');
  assert.equal(studio.id, 'ac7d2fc65b2f');
  assert.ok(studio.labels.includes('com.docker.compose.project=shelly-monitor'));
  assert.equal(rows.find((r) => r.name === 'pe-db')?.running, false);
});

test('parseDockerPsJson: junk lines and rows without a name are skipped', () => {
  assert.deepEqual(parseDockerPsJson(''), []);
  assert.deepEqual(parseDockerPsJson('Cannot connect to the Docker daemon\n{broken\n{"State":"running"}\n'), []);
  assert.deepEqual(parseDockerPsJson('{"Names":"a","State":"exited","Ports":"","Labels":"","ID":"1"}\n'), [{ name: 'a', running: false, ports: '', labels: '', id: '1' }]);
});

test('parseInspectRows: the real capture — project, working dir, start time, leading slash stripped', () => {
  const rows = parseInspectRows(fixture('docker-inspect.tsv'));
  assert.equal(rows.length, 43);
  assert.deepEqual(rows.find((r) => r.name === 'customer-ui'), {
    name: 'customer-ui', autoRemove: false, project: 'vitaminology',
    projectDir: '/Users/iij/IdeaProjects/nutrable/develop/.cache', startedAt: Date.parse('2026-10-11T07:49:02.706398718Z'),
  });
  // a plain `docker run` container: no compose labels at all
  assert.deepEqual(rows.find((r) => r.name === 'redis'), { name: 'redis', autoRemove: false, project: null, projectDir: null, startedAt: Date.parse('2026-10-11T07:49:02.662936926Z') });
  // supabase CLI sets the project label but no working dir
  const sb = rows.find((r) => r.name === 'supabase_db_shelly-monitor');
  assert.equal(sb?.project, 'shelly-monitor');
  assert.equal(sb?.projectDir, null);
  assert.ok(rows.every((r) => !r.name.startsWith('/')));
});

test('parseInspectRows: --rm, "<no value>" labels and a never-started container', () => {
  const rows = parseInspectRows('/tmp-job\ttrue\t<no value>\t<no value>\t0001-01-01T00:00:00Z\n\n/x\tfalse\tp\t/d\tnot-a-date\n');
  assert.deepEqual(rows, [
    { name: 'tmp-job', autoRemove: true, project: null, projectDir: null, startedAt: null },
    { name: 'x', autoRemove: false, project: 'p', projectDir: '/d', startedAt: null },
  ]);
});

test('parseStatsRows: the real capture — cpu %, MiB and binary/decimal network units', () => {
  const rows = parseStatsRows(fixture('docker-stats.tsv'));
  assert.equal(rows.length, 31);
  assert.deepEqual(rows.find((r) => r.name === 'supabase_studio_shelly-monitor'), { name: 'supabase_studio_shelly-monitor', cpuPct: 0, memMB: 283.4, netRxBytes: 1860, netTxBytes: 0 });
  const analytics = rows.find((r) => r.name === 'supabase_analytics_shelly-monitor');
  assert.deepEqual(analytics, { name: 'supabase_analytics_shelly-monitor', cpuPct: 1.87, memMB: 728, netRxBytes: 18.9e6, netTxBytes: 18.7e6 });
  assert.equal(rows.find((r) => r.name === 'collections-api')?.netRxBytes, 116e6);
});

test('parseStatsRows: the contract example and GiB; an unreadable row is no reading, not "idle"', () => {
  assert.deepEqual(parseStatsRows('a\t3.50%\t1.5GiB / 20GiB\t1.26MB / 1.84MB\n'), [{ name: 'a', cpuPct: 3.5, memMB: 1536, netRxBytes: 1.26e6, netTxBytes: 1.84e6 }]);
  assert.deepEqual(parseStatsRows('b\t--\t-- / --\t-- / --\nc\t1%\n\n'), []);
});

test('parseComposeLs: the real capture — dir is the first config file\'s directory', () => {
  const rows = parseComposeLs(fixture('docker-compose-ls.json'));
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.find((r) => r.name === 'arrow'), {
    name: 'arrow', status: 'running(1)',
    configFiles: ['/Users/iij/IdeaProjects/arrow/docker-compose.yml', '/Users/iij/IdeaProjects/arrow/docker-compose.override.yml'],
    dir: '/Users/iij/IdeaProjects/arrow',
  });
  assert.equal(rows.find((r) => r.name === 'vitaminology')?.dir, '/Users/iij/IdeaProjects/nutrable/develop/.cache');
});

test('parseComposeLs: not JSON, not an array, no config files', () => {
  assert.deepEqual(parseComposeLs('no configuration file provided'), []);
  assert.deepEqual(parseComposeLs('{}'), []);
  assert.deepEqual(parseComposeLs('[{"Name":"x","Status":"exited(1)"},{"Status":"?"}]'), [{ name: 'x', status: 'exited(1)', configFiles: [], dir: null }]);
});

test('publishedPorts: only host-published ports count', () => {
  assert.deepEqual(publishedPorts('0.0.0.0:55423->3000/tcp, 8080/tcp'), [55423]);
  assert.deepEqual(publishedPorts(''), []);
  assert.deepEqual(publishedPorts('8001/tcp, 8088/tcp, 8443-8444/tcp, 0.0.0.0:55421->8000/tcp'), [55421]);
  assert.deepEqual(publishedPorts('127.0.0.1:16379->6379/tcp'), [16379]);
  assert.deepEqual(publishedPorts('443/udp, 2019/tcp, 0.0.0.0:8088->80/tcp, 0.0.0.0:8443->443/tcp'), [8088, 8443]);
});

test('publishedPorts: ranges expand, IPv4+IPv6 duplicates collapse', () => {
  assert.deepEqual(publishedPorts('0.0.0.0:3013-3016->3013-3016/tcp, 0.0.0.0:3306->3306/tcp'), [3013, 3014, 3015, 3016, 3306]);
  assert.deepEqual(publishedPorts('0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, :::5433->5432/tcp'), [5432, 5433]);
  // every container in the real capture parses without a NaN
  for (const c of parseDockerPsJson(fixture('docker-ps.jsonl'))) assert.ok(publishedPorts(c.ports).every((p) => Number.isInteger(p) && p > 0), c.name);
  assert.equal(publishedPorts(parseDockerPsJson(fixture('docker-ps.jsonl')).find((c) => c.name === 'vpn')?.ports ?? '').length, 23);
});

test('parseEstablishedPorts: the real capture — local port is the suffix of column 4', () => {
  const m = parseEstablishedPorts(fixture('netstat-established.txt'));
  assert.equal(m.get(5861), 2);
  assert.equal(m.get(57605), 1);
  assert.equal(m.get(54806), 1);                    // tcp6 "2a0d:3344:488c:b.54806"
  assert.equal(m.get(443), undefined);              // a foreign port is not ours
  let total = 0;
  for (const n of m.values()) total += n;
  assert.equal(total, 50);
});

test('parseEstablishedPorts: only ESTABLISHED lines; listeners and headers are ignored', () => {
  const text = [
    'Active Internet connections (including servers)',
    'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)',
    'tcp4       0      0  127.0.0.1.5436         127.0.0.1.61001        ESTABLISHED',
    'tcp4       0      0  127.0.0.1.61001        127.0.0.1.5436         ESTABLISHED',
    'tcp46      0      0  *.5436                 *.*                    LISTEN',
    'tcp4       0      0  127.0.0.1.5436         127.0.0.1.61002        CLOSE_WAIT',
  ].join('\n');
  assert.deepEqual(Array.from(parseEstablishedPorts(text)), [[5436, 1], [61001, 1]]);
});

function fakeExec(over: Record<string, string | null> = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = cmd === 'docker' ? `docker ${args[0] === 'compose' ? 'compose' : args[0]}` : cmd;
    if (key in over) return over[key];
    switch (key) {
      case 'pgrep': return '';
      case 'docker ps': return fixture('docker-ps.jsonl');
      case 'docker inspect': return fixture('docker-inspect.tsv');
      case 'docker stats': return fixture('docker-stats.tsv');
      case 'docker compose': return fixture('docker-compose-ls.json');
      case 'netstat': return fixture('netstat-established.txt');
      default: throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    }
  };
  return { exec, calls };
}

test('collectInventory: the five read-only commands, in the verified formats', async () => {
  const { exec, calls } = fakeExec();
  const inv = await collectInventory(exec);
  assert.ok(inv);
  assert.equal(inv.containers.length, 43);
  assert.equal(inv.inspect.length, 43);
  assert.equal(inv.stats.length, 31);
  assert.equal(inv.compose.length, 8);
  assert.equal(inv.conns.get(5861), 2);
  assert.deepEqual(calls[0], ['pgrep', '-q', 'com.docker.backend']);
  assert.deepEqual(calls[1], ['docker', 'ps', '-a', '--format', '{{json .}}']);
  const inspect = calls.find((c) => c[1] === 'inspect');
  assert.deepEqual(inspect?.slice(0, 4), ['docker', 'inspect', '-f', INSPECT_FORMAT]);
  assert.equal(inspect?.length, 4 + 43);
  assert.deepEqual(calls.find((c) => c[1] === 'stats'), ['docker', 'stats', '--no-stream', '--format', STATS_FORMAT]);
  assert.deepEqual(calls.find((c) => c[1] === 'compose'), ['docker', 'compose', 'ls', '--all', '--format', 'json']);
  assert.deepEqual(calls.find((c) => c[0] === 'netstat'), ['netstat', '-anp', 'tcp']);
  assert.equal(calls.length, 6);
  assert.ok(calls.every((c) => !['stop', 'kill', 'rm', 'start'].includes(c[1])));
});

test('collectInventory: Docker\'s VM is down → docker is never called', async () => {
  const { exec, calls } = fakeExec({ pgrep: null });
  assert.equal(await collectInventory(exec), null);
  assert.deepEqual(calls, [['pgrep', '-q', 'com.docker.backend']]);
});

test('collectInventory: a failed ps / inspect / stats / netstat means NO inventory, never "all idle"', async () => {
  for (const key of ['docker ps', 'docker inspect', 'docker stats', 'netstat']) {
    assert.equal(await collectInventory(fakeExec({ [key]: null }).exec), null, key);
  }
});

test('collectInventory: compose ls is optional; no containers skips the rest', async () => {
  const inv = await collectInventory(fakeExec({ 'docker compose': null }).exec);
  assert.deepEqual(inv?.compose, []);
  assert.equal(inv?.containers.length, 43);
  const empty = fakeExec({ 'docker ps': '' });
  assert.deepEqual(await collectInventory(empty.exec), { containers: [], inspect: [], stats: [], compose: [], conns: new Map() });
  assert.equal(empty.calls.length, 2);
});

test('supabaseProjectDir: the real capture — only the studio container carries the bind that names the folder', () => {
  const rows = parseDockerPsJson(fixture('docker-ps.jsonl'));
  const dirs = rows.filter((r) => r.name.startsWith('supabase_')).map((r) => [r.name, supabaseProjectDir(r.labels)]);
  assert.equal(dirs.length, 12);
  assert.deepEqual(dirs.filter(([, d]) => d !== null), [['supabase_studio_shelly-monitor', '/Users/iij/Desktop/ai-factory/ai-factory-brain']]);
  // no other container on the machine is mistaken for one
  assert.ok(rows.filter((r) => !r.name.startsWith('supabase_')).every((r) => supabaseProjectDir(r.labels) === null));
});

test('supabaseProjectDir: needs the supabase label AND a bind under a supabase/ folder', () => {
  const bind = 'desktop.docker.io/binds/0/Source=/Users/me/app/supabase/functions';
  assert.equal(supabaseProjectDir(`com.supabase.cli.project=app,${bind}`), '/Users/me/app');
  assert.equal(supabaseProjectDir('com.supabase.cli.project=app,desktop.docker.io/binds/0/Source=/Users/me/app/supabase'), '/Users/me/app');
  assert.equal(supabaseProjectDir(`com.docker.compose.project=app,${bind}`), null);            // not supabase's
  assert.equal(supabaseProjectDir('com.supabase.cli.project=app,desktop.docker.io/binds/0/Source=/var/run/docker.sock'), null);
  assert.equal(supabaseProjectDir('com.supabase.cli.project=app,desktop.docker.io/binds/0/Source=/supabase/x'), null);   // no root to speak of
  assert.equal(supabaseProjectDir('com.supabase.cli.project=app'), null);
  assert.equal(supabaseProjectDir(''), null);
});
