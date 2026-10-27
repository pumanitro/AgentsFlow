import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { ManagedService, ServicesRegistryFile } from '../../shared/services';
import type { Discovered } from './discovery';
import { ATLAS_SEED, DOCKER_DESKTOP_SEED, atlasSeed, mergeDiscovered, readRegistry, seedServices, writeRegistry } from './registry';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'services-registry-'));
}
const HOME = '/Users/someone';
const ATLAS_SERVER = '/Users/someone/IdeaProjects/atlas-of-doors/dashboard/api/server.mjs';
const seedWithAtlas = () => seedServices(HOME, (p) => p === ATLAS_SERVER);

test('seedServices: Docker Desktop always; the atlas API only when its server file exists', () => {
  const asked: string[] = [];
  const none = seedServices(HOME, (p) => { asked.push(p); return false; });
  assert.deepEqual(asked, [ATLAS_SERVER]);
  assert.deepEqual(none.map((s) => s.id), ['docker-desktop']);
  const both = seedWithAtlas();
  assert.deepEqual(both.map((s) => s.id), ['atlas-dashboard-api', 'docker-desktop']);
  assert.deepEqual(both[0], atlasSeed(HOME));
  assert.deepEqual(both[1], DOCKER_DESKTOP_SEED);
});

test('atlas seed: the exact command, folder, env, log, health and port of the plan', () => {
  const a = atlasSeed(HOME);
  assert.deepEqual(a, {
    id: 'atlas-dashboard-api', name: 'Atlas dashboard — data service', source: 'seed', managed: true, pinned: false, idleMinutes: 240,
    ports: [{ port: 5545, host: '127.0.0.1' }],
    spec: { kind: 'process', cmd: 'node', args: ['--max-old-space-size=32768', '--import', 'tsx', 'dashboard/api/server.mjs'], cwd: '/Users/someone/IdeaProjects/atlas-of-doors', env: { ATLAS_DASH_MODE: 'on-demand' }, logFile: '/Users/someone/.atlas-of-doors/api.log', health: 'http://127.0.0.1:5545/api/health' },
  });
  assert.equal(ATLAS_SEED.spec.kind === 'process' && ATLAS_SEED.spec.cwd, path.join(os.homedir(), 'IdeaProjects/atlas-of-doors'));
  assert.deepEqual(DOCKER_DESKTOP_SEED, { id: 'docker-desktop', name: 'Docker Desktop', source: 'seed', managed: true, pinned: false, idleMinutes: 15, ports: [], spec: { kind: 'docker-desktop' } });
});

test('readRegistry: a missing file is the seed in live mode, and it is written', () => {
  const f = path.join(tmp(), 'pf', 'services.json');
  const r = readRegistry(f, seedWithAtlas);
  assert.deepEqual(r, { version: 1, mode: 'live', services: seedWithAtlas() });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), r);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['services.json']);
});

test('readRegistry: an unreadable file is moved aside, then seeded and written', () => {
  for (const body of ['{not json', '[]', '"live"', 'null', '']) {
    const dir = tmp();
    const f = path.join(dir, 'services.json');
    fs.writeFileSync(f, body);
    assert.deepEqual(readRegistry(f, seedWithAtlas), { version: 1, mode: 'live', services: seedWithAtlas() }, body);
    assert.equal(fs.readFileSync(`${f}.unreadable`, 'utf8'), body);
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).services.length, 2);
  }
});

test('registry: write → read round-trip is atomic and complete', () => {
  const dir = tmp();
  const f = path.join(dir, 'services.json');
  const r: ServicesRegistryFile = { version: 1, mode: 'watch', pressureIdleMinutes: 45, services: [...seedWithAtlas()] };
  writeRegistry(r, f);
  writeRegistry(r, f);
  assert.deepEqual(fs.readdirSync(dir), ['services.json']);
  assert.deepEqual(readRegistry(f, () => { throw new Error('must not seed'); }), r);
});

test('readRegistry: a hand-edited file falls back field by field', () => {
  const f = path.join(tmp(), 'services.json');
  fs.writeFileSync(f, JSON.stringify({
    mode: 'LIVE', pressureIdleMinutes: -3,
    services: [
      { id: 'compose:arrow', spec: { kind: 'compose', project: 'arrow', configFiles: 'x' }, ports: [{ port: 5436 }, { port: 5436, host: '0.0.0.0' }, { port: 0 }, { port: 70000 }, 'x', { port: 8080, host: '0.0.0.0' }], idleMinutes: 0, pinned: 'yes', managed: 'no', source: 'magic' },
      { id: 'compose:arrow', name: 'duplicate', spec: { kind: 'docker-desktop' } },
      { id: 'bad-kind', spec: { kind: 'vm' } },
      { id: 'proc-relative', spec: { kind: 'process', cmd: 'node', args: [], cwd: 'relative', logFile: '/tmp/x.log' } },
      { id: 'containers-empty', spec: { kind: 'containers', containers: [] } },
      { spec: { kind: 'docker-desktop' } },
      { id: 'docker-desktop', spec: { kind: 'docker-desktop' }, managed: false },
      7,
    ],
  }));
  const r = readRegistry(f, () => { throw new Error('must not seed'); });
  assert.deepEqual(r, {
    version: 1, mode: 'live',
    services: [
      { id: 'compose:arrow', name: 'compose:arrow', spec: { kind: 'compose', project: 'arrow', configFiles: [], projectDir: null, containers: [] }, ports: [{ port: 5436, host: '127.0.0.1' }, { port: 8080, host: '0.0.0.0' }], idleMinutes: 240, pinned: false, managed: true, source: 'user' },
      { id: 'docker-desktop', name: 'docker-desktop', spec: { kind: 'docker-desktop' }, ports: [], idleMinutes: 15, pinned: false, managed: false, source: 'user' },
    ],
  });
});

test('readRegistry: mode "watch" and a positive pressure floor are kept; no services key is an empty list', () => {
  const f = path.join(tmp(), 'services.json');
  fs.writeFileSync(f, JSON.stringify({ mode: 'watch', pressureIdleMinutes: 20 }));
  assert.deepEqual(readRegistry(f), { version: 1, mode: 'watch', pressureIdleMinutes: 20, services: [] });
  fs.writeFileSync(f, JSON.stringify({ mode: 'watch', pressureIdleMinutes: 'soon', services: [] }));
  assert.equal('pressureIdleMinutes' in readRegistry(f), false);
});

test('readRegistry: a process spec keeps env strings and health, drops the rest', () => {
  const f = path.join(tmp(), 'services.json');
  fs.writeFileSync(f, JSON.stringify({ services: [{ id: 'p', spec: { kind: 'process', cmd: 'node', cwd: '/Users/a', logFile: '/Users/a/x.log', env: { A: '1', B: 2 }, health: '' } }] }));
  assert.deepEqual(readRegistry(f).services[0].spec, { kind: 'process', cmd: 'node', args: [], cwd: '/Users/a', logFile: '/Users/a/x.log', env: { A: '1' } });
});

const D_ARROW: Discovered = { id: 'compose:arrow', name: 'arrow — Docker project', spec: { kind: 'compose', project: 'arrow', configFiles: ['/p/arrow/docker-compose.yml'], projectDir: '/p/arrow', containers: ['arrow-db-1'] }, ports: [{ port: 5436, host: '0.0.0.0' }] };
const D_REDIS: Discovered = { id: 'containers:redis', name: 'redis — Docker container', spec: { kind: 'containers', containers: ['redis'], projectDir: null }, ports: [{ port: 16379, host: '127.0.0.1' }] };

test('mergeDiscovered: new projects get the defaults and Docker Desktop stays last', () => {
  const reg: ServicesRegistryFile = { version: 1, mode: 'live', services: seedWithAtlas() };
  const before = JSON.stringify(reg);
  const { registry, added } = mergeDiscovered(reg, [D_ARROW, D_REDIS]);
  assert.deepEqual(added, ['compose:arrow', 'containers:redis']);
  assert.deepEqual(registry.services.map((s) => s.id), ['atlas-dashboard-api', 'compose:arrow', 'containers:redis', 'docker-desktop']);
  assert.deepEqual(registry.services[1], { ...D_ARROW, idleMinutes: 240, pinned: false, managed: true, source: 'discovered' });
  assert.equal(JSON.stringify(reg), before, 'input untouched');
});

test('mergeDiscovered: known entries keep the user fields and get fresh containers, files and ports', () => {
  const mine: ManagedService = { id: 'compose:arrow', name: 'Arrow (mine)', spec: { kind: 'compose', project: 'arrow', configFiles: ['/old.yml'], projectDir: '/p/arrow', containers: ['old-1'] }, ports: [{ port: 1, host: '127.0.0.1' }], idleMinutes: 60, pinned: true, managed: false, source: 'user' };
  const reg: ServicesRegistryFile = { version: 1, mode: 'watch', pressureIdleMinutes: 45, services: [mine, { ...DOCKER_DESKTOP_SEED }] };
  const { registry, added } = mergeDiscovered(reg, [{ ...D_ARROW, spec: { ...D_ARROW.spec, projectDir: null } as Discovered['spec'] }]);
  assert.deepEqual(added, []);
  assert.equal(registry.mode, 'watch');
  assert.equal(registry.pressureIdleMinutes, 45);
  assert.deepEqual(registry.services[0], { ...mine, spec: { kind: 'compose', project: 'arrow', configFiles: ['/p/arrow/docker-compose.yml'], projectDir: '/p/arrow', containers: ['arrow-db-1'] }, ports: [{ port: 5436, host: '0.0.0.0' }] });
});

test('mergeDiscovered: nothing is ever removed, and a same-id entry of another kind is left alone', () => {
  const gone: ManagedService = { id: 'compose:old', name: 'old', spec: { kind: 'compose', project: 'old', configFiles: [], projectDir: null, containers: ['old-1'] }, ports: [], idleMinutes: 240, pinned: false, managed: true, source: 'discovered' };
  const odd: ManagedService = { id: 'containers:redis', name: 'redis by hand', spec: { kind: 'compose', project: 'r', configFiles: [], projectDir: null, containers: ['redis'] }, ports: [{ port: 9, host: '127.0.0.1' }], idleMinutes: 240, pinned: false, managed: true, source: 'user' };
  const { registry, added } = mergeDiscovered({ version: 1, mode: 'live', services: [gone, odd] }, [D_REDIS]);
  assert.deepEqual(added, []);
  assert.deepEqual(registry.services, [gone, odd]);
});
