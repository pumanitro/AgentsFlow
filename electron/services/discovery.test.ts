import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseComposeLs, parseDockerPsJson, type Exec } from '../guard/docker-inventory';
import { SERVICES_INSPECT_FORMAT, collectDockerDiscovery, discoverDocker, parsePortBindings, parseServicesInspect } from './discovery';
import { fixture } from './test-fixtures';

const PS = parseDockerPsJson(fixture('docker-ps.jsonl'));
const LS = parseComposeLs(fixture('docker-compose-ls.json'));
const INSPECT = parseServicesInspect(fixture('services-inspect.tsv'));

test('parsePortBindings: host side only; "", 0.0.0.0 and :: are every interface; empty HostPort and udp skipped', () => {
  assert.deepEqual(parsePortBindings('{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"5544"}]}'), [{ port: 5544, host: '127.0.0.1' }]);
  assert.deepEqual(parsePortBindings('{"80/tcp":[{"HostIp":"","HostPort":"8088"}],"443/udp":[{"HostIp":"","HostPort":"8443"}],"9/tcp":[{"HostIp":"","HostPort":""}]}'), [{ port: 8088, host: '0.0.0.0' }]);
  // Loopback and :: on the same port → one entry on every interface.
  assert.deepEqual(parsePortBindings('{"1/tcp":[{"HostIp":"127.0.0.1","HostPort":"7000"},{"HostIp":"::","HostPort":"7000"}]}'), [{ port: 7000, host: '0.0.0.0' }]);
  for (const junk of ['null', '{}', '', 'not json', '[1]', '{"1/tcp":"x"}']) assert.deepEqual(parsePortBindings(junk), [], junk);
});

test('parseServicesInspect: names, labels, split config files and ports', () => {
  assert.equal(INSPECT.length, 9);
  assert.deepEqual(INSPECT[0], {
    name: 'influence-postgres', project: 'influence', projectDir: '/Users/iij/IdeaProjects/influence',
    configFiles: ['/Users/iij/IdeaProjects/influence/docker-compose.yml', '/Users/iij/IdeaProjects/influence/docker-compose.override.yml'],
    supabase: null, ports: [{ port: 5433, host: '0.0.0.0' }],
  });
  assert.deepEqual(INSPECT[1].ports, [{ port: 6379, host: '127.0.0.1' }, { port: 16380, host: '0.0.0.0' }]);
  assert.deepEqual(INSPECT[2], { name: 'supabase_db_shelly-monitor', project: 'shelly-monitor', projectDir: null, configFiles: [], supabase: 'shelly-monitor', ports: [{ port: 55422, host: '0.0.0.0' }] });
  assert.deepEqual(INSPECT.find((r) => r.name === 'redis'), { name: 'redis', project: null, projectDir: null, configFiles: [], supabase: null, ports: [{ port: 16379, host: '127.0.0.1' }] });
  assert.deepEqual(INSPECT.find((r) => r.name === 'case-challenge-redis')?.ports, []);
  assert.deepEqual(parseServicesInspect('\n\nx\n'), []);
});

test('discoverDocker: every project from the real capture, stopped ones included, sorted by id', () => {
  const found = discoverDocker(PS, INSPECT, LS);
  assert.deepEqual(found.map((d) => d.id), [
    'compose:arrow', 'compose:case-challenge', 'compose:dashboard', 'compose:income-challenge-poc', 'compose:influence',
    'compose:influence-demo', 'compose:mc', 'compose:vitaminology',
    'containers:pe-db', 'containers:pe-dev-db', 'containers:redis', 'containers:shelly-monitor',
  ]);
  // Every container lands in exactly one service.
  const all = found.flatMap((d) => d.spec.containers);
  assert.equal(all.length, PS.length);
  assert.equal(new Set(all).size, PS.length);
});

test('discoverDocker: a compose project with two config files and mixed bindings', () => {
  const d = discoverDocker(PS, INSPECT, LS).find((x) => x.id === 'compose:influence');
  assert.deepEqual(d, {
    id: 'compose:influence', name: 'influence — Docker project',
    spec: { kind: 'compose', project: 'influence', configFiles: ['/Users/iij/IdeaProjects/influence/docker-compose.yml', '/Users/iij/IdeaProjects/influence/docker-compose.override.yml'], projectDir: '/Users/iij/IdeaProjects/influence', containers: ['influence-postgres', 'influence-redis'] },
    ports: [{ port: 5433, host: '0.0.0.0' }, { port: 6379, host: '127.0.0.1' }, { port: 16380, host: '0.0.0.0' }],
  });
});

test('discoverDocker: a supabase project is one containers service with its folder from the binds', () => {
  const d = discoverDocker(PS, INSPECT, LS).find((x) => x.id === 'containers:shelly-monitor');
  assert.ok(d && d.spec.kind === 'containers');
  assert.equal(d.name, 'shelly-monitor — Supabase (Docker)');
  assert.equal(d.spec.containers.length, 12);
  assert.ok(d.spec.containers.includes('supabase_edge_runtime_shelly-monitor'), 'stopped container kept');
  assert.equal(d.spec.projectDir, '/Users/iij/Desktop/ai-factory/ai-factory-brain');
  assert.deepEqual(d.ports, [{ port: 55421, host: '0.0.0.0' }, { port: 55422, host: '0.0.0.0' }]);
});

test('discoverDocker: standalone containers, running and stopped, keep their bindings', () => {
  const found = discoverDocker(PS, INSPECT, LS);
  assert.deepEqual(found.find((x) => x.id === 'containers:redis'), { id: 'containers:redis', name: 'redis — Docker container', spec: { kind: 'containers', containers: ['redis'], projectDir: null }, ports: [{ port: 16379, host: '127.0.0.1' }] });
  assert.deepEqual(found.find((x) => x.id === 'containers:pe-db'), { id: 'containers:pe-db', name: 'pe-db — Docker container', spec: { kind: 'containers', containers: ['pe-db'], projectDir: null }, ports: [{ port: 5434, host: '0.0.0.0' }] });
  // Stopped compose project: files from compose ls, ports from inspect.
  const cc = found.find((x) => x.id === 'compose:case-challenge');
  assert.ok(cc && cc.spec.kind === 'compose');
  assert.deepEqual(cc.spec.configFiles, ['/Users/iij/IdeaProjects/case-challenge/docker-compose.dev.yml']);
  assert.deepEqual(cc.spec.containers, ['case-challenge-redis', 'case-challenge-postgres']);
  assert.deepEqual(cc.ports, [{ port: 5440, host: '127.0.0.1' }]);
});

test('discoverDocker: without compose ls the config files come from the label; without any → containers:<project>', () => {
  const inspect = parseServicesInspect('/a-1\tproj\t/p\t/p/one.yml,/p/two.yml\t<no value>\t{}\n/b-1\tloose\t<no value>\t<no value>\t<no value>\tnull\n');
  const ps = [
    { name: 'a-1', running: true, ports: '', labels: '', id: '1' },
    { name: 'b-1', running: false, ports: '', labels: '', id: '2' },
  ];
  assert.deepEqual(discoverDocker(ps, inspect, []), [
    { id: 'compose:proj', name: 'proj — Docker project', spec: { kind: 'compose', project: 'proj', configFiles: ['/p/one.yml', '/p/two.yml'], projectDir: '/p', containers: ['a-1'] }, ports: [] },
    { id: 'containers:loose', name: 'loose — Docker project', spec: { kind: 'containers', containers: ['b-1'], projectDir: null }, ports: [] },
  ]);
});

/** Fake exec: answers from a table, records every call, never runs anything. */
function fakeExec(answers: Record<string, string | null>): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = cmd === 'docker' ? `docker ${args[0]}` : cmd;
    return key in answers ? answers[key] : null;
  };
  return { exec, calls };
}

test('collectDockerDiscovery: Docker down → null, and docker itself is never asked', async () => {
  const { exec, calls } = fakeExec({ pgrep: null });
  assert.equal(await collectDockerDiscovery(exec), null);
  assert.deepEqual(calls, [['pgrep', '-q', 'com.docker.backend']]);
});

test('collectDockerDiscovery: ps -a, one inspect of every name with the services format, compose ls', async () => {
  const { exec, calls } = fakeExec({ pgrep: '', 'docker ps': fixture('docker-ps.jsonl'), 'docker inspect': fixture('services-inspect.tsv'), 'docker compose': fixture('docker-compose-ls.json') });
  const found = await collectDockerDiscovery(exec);
  assert.deepEqual(found, discoverDocker(PS, INSPECT, LS));
  assert.deepEqual(calls[1], ['docker', 'ps', '-a', '--format', '{{json .}}']);
  assert.deepEqual(calls.find((c) => c[1] === 'inspect'), ['docker', 'inspect', '-f', SERVICES_INSPECT_FORMAT, ...PS.map((c) => c.name)]);
  assert.ok(calls.some((c) => c.join(' ') === 'docker compose ls --all --format json'));
  for (const c of calls) assert.ok(!/\b(down|rm|prune|kill|stop|start)\b/.test(c.slice(1).join(' ')), c.join(' '));
});

test('collectDockerDiscovery: a failed inspect is no answer; a failed compose ls is not', async () => {
  assert.equal(await collectDockerDiscovery(fakeExec({ pgrep: '', 'docker ps': fixture('docker-ps.jsonl'), 'docker compose': '[]' }).exec), null);
  assert.equal(await collectDockerDiscovery(fakeExec({ pgrep: '' }).exec), null);
  const noLs = await collectDockerDiscovery(fakeExec({ pgrep: '', 'docker ps': fixture('docker-ps.jsonl'), 'docker inspect': fixture('services-inspect.tsv') }).exec);
  assert.ok(noLs && noLs.some((d) => d.id === 'compose:influence'));
  assert.deepEqual(await collectDockerDiscovery(fakeExec({ pgrep: '', 'docker ps': '' }).exec), []);
});
