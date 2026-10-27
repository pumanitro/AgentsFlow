// The services registry (`services.json`): which services Peers Flow may put to
// sleep and wake, how long "idle" is for each, which are pinned, and whether the
// loop may act at all (mode). Seeded on first run with the atlas dashboard API
// (when that repo is on this Mac) and Docker Desktop; Docker projects are added
// by discovery and never removed. The user may hand-edit it — every field falls
// back on its own, and an entry that cannot be understood is left out of this
// read (never acted on) rather than guessed at.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SERVICE_DEFAULTS,
  type ManagedService,
  type ServicePort,
  type ServiceSpec,
  type ServicesRegistryFile,
} from '../../shared/services';
import type { Discovered } from './discovery';

const ATLAS_REL = 'IdeaProjects/atlas-of-doors';

/** The atlas dashboard API for a given home directory. */
export function atlasSeed(home: string): ManagedService {
  const repo = path.join(home, ATLAS_REL);
  return {
    id: 'atlas-dashboard-api', name: 'Atlas dashboard — data service', source: 'seed', managed: true, pinned: false, idleMinutes: SERVICE_DEFAULTS.idleMinutes,
    ports: [{ port: 5545, host: '127.0.0.1' }],
    spec: {
      kind: 'process', cmd: 'node', args: ['--max-old-space-size=32768', '--import', 'tsx', 'dashboard/api/server.mjs'],
      cwd: repo, env: { ATLAS_DASH_MODE: 'on-demand' }, logFile: path.join(home, '.atlas-of-doors', 'api.log'), health: 'http://127.0.0.1:5545/api/health',
    },
  };
}

export const ATLAS_SEED: ManagedService = atlasSeed(os.homedir());
export const DOCKER_DESKTOP_SEED: ManagedService = { id: 'docker-desktop', name: 'Docker Desktop', source: 'seed', managed: true, pinned: false, idleMinutes: SERVICE_DEFAULTS.dockerDesktopIdleMinutes, ports: [], spec: { kind: 'docker-desktop' } };

/** Docker Desktop always; the atlas API only when its server file exists. Docker Desktop last. */
export function seedServices(home = os.homedir(), exists: (p: string) => boolean = fs.existsSync): ManagedService[] {
  const out: ManagedService[] = [];
  if (exists(path.join(home, ATLAS_REL, 'dashboard', 'api', 'server.mjs'))) out.push(atlasSeed(home));
  out.push(clone(DOCKER_DESKTOP_SEED));
  return out;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ── validation ─────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const strList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]).slice() : null);
const absPath = (v: unknown): string | null => (typeof v === 'string' && path.isAbsolute(v) ? v : null);
const posNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

function readPorts(v: unknown): ServicePort[] {
  if (!Array.isArray(v)) return [];
  const out: ServicePort[] = [];
  const seen = new Set<number>();
  for (const p of v) {
    if (!isObj(p)) continue;
    const port = p.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535 || seen.has(port)) continue;
    seen.add(port);
    out.push({ port, host: p.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1' });
  }
  return out;
}

/** null = not a spec we can safely act on. */
function readSpec(v: unknown): ServiceSpec | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case 'process': {
      const cmd = str(v.cmd);
      const args = v.args === undefined ? [] : strList(v.args);
      const cwd = absPath(v.cwd);
      const logFile = absPath(v.logFile);
      if (!cmd || !args || !cwd || !logFile) return null;
      const spec: ServiceSpec = { kind: 'process', cmd, args, cwd, logFile };
      if (isObj(v.env)) {
        const env: Record<string, string> = {};
        for (const [k, val] of Object.entries(v.env)) if (k && typeof val === 'string') env[k] = val;
        spec.env = env;
      }
      if (str(v.health)) spec.health = v.health as string;
      return spec;
    }
    case 'compose': {
      const project = str(v.project);
      if (!project) return null;
      return { kind: 'compose', project, configFiles: strList(v.configFiles) ?? [], projectDir: absPath(v.projectDir), containers: strList(v.containers) ?? [] };
    }
    case 'containers': {
      const containers = strList(v.containers);
      if (!containers || containers.length === 0) return null;
      return { kind: 'containers', containers, projectDir: absPath(v.projectDir) };
    }
    case 'docker-desktop':
      return { kind: 'docker-desktop' };
    default:
      return null;
  }
}

function readService(v: unknown): ManagedService | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const spec = readSpec(v.spec);
  if (!id || !spec) return null;
  const defIdle = spec.kind === 'docker-desktop' ? SERVICE_DEFAULTS.dockerDesktopIdleMinutes : SERVICE_DEFAULTS.idleMinutes;
  return {
    id,
    name: str(v.name) ?? id,
    spec,
    ports: readPorts(v.ports),
    idleMinutes: posNum(v.idleMinutes) ?? defIdle,
    pinned: v.pinned === true,
    // Only the exact `false` takes a service out of Peers Flow's hands.
    managed: v.managed !== false,
    source: v.source === 'seed' || v.source === 'discovered' ? v.source : 'user',
  };
}

/** Field-by-field reading of a parsed file; duplicate ids keep the first. */
export function parseRegistry(parsed: unknown): ServicesRegistryFile | null {
  if (!isObj(parsed)) return null;
  const services: ManagedService[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(parsed.services) ? parsed.services : []) {
    const s = readService(raw);
    if (!s || ids.has(s.id)) continue;
    ids.add(s.id);
    services.push(s);
  }
  const out: ServicesRegistryFile = { version: 1, mode: parsed.mode === 'watch' ? 'watch' : 'live', services };
  const floor = posNum(parsed.pressureIdleMinutes);
  if (floor !== null) out.pressureIdleMinutes = floor;
  return out;
}

/**
 * Missing or unreadable ⇒ {version:1, mode:'live', services: seed()} and that is
 * WRITTEN. An unreadable file is first moved aside to `<file>.unreadable` so a
 * broken hand edit is not lost.
 */
export function readRegistry(file: string, seed: () => ManagedService[] = () => seedServices()): ServicesRegistryFile {
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = null;
  }
  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const reg = parseRegistry(parsed);
    if (reg) return reg;
    try { fs.renameSync(file, `${file}.unreadable`); } catch { /* best effort */ }
  }
  const fresh: ServicesRegistryFile = { version: 1, mode: 'live', services: seed() };
  try {
    writeRegistry(fresh, file);
  } catch {
    /* an unwritable dir still gets the seed for this run */
  }
  return fresh;
}

/** Atomic (tmp + rename). */
export function writeRegistry(r: ServicesRegistryFile, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Pure. Known services keep the user's pinned/managed/idleMinutes/source/name and
 * get fresh containers, config files, project folder and ports; new ones are added
 * with the defaults; nothing is ever removed. The input is not modified.
 */
export function mergeDiscovered(reg: ServicesRegistryFile, found: Discovered[]): { registry: ServicesRegistryFile; added: string[] } {
  const services = reg.services.map((s) => clone(s));
  const index = new Map(services.map((s, i) => [s.id, i]));
  const added: string[] = [];
  for (const d of found) {
    const at = index.get(d.id);
    if (at === undefined) {
      index.set(d.id, services.length);
      services.push({ id: d.id, name: d.name, spec: clone(d.spec), ports: clone(d.ports), idleMinutes: SERVICE_DEFAULTS.idleMinutes, pinned: false, managed: true, source: 'discovered' });
      added.push(d.id);
      continue;
    }
    const s = services[at];
    // A hand-written entry of another kind under the same id is the user's call.
    if (s.spec.kind !== d.spec.kind) continue;
    if (s.spec.kind === 'compose' && d.spec.kind === 'compose') {
      s.spec = { ...s.spec, configFiles: d.spec.configFiles.slice(), containers: d.spec.containers.slice(), projectDir: d.spec.projectDir ?? s.spec.projectDir };
    } else if (s.spec.kind === 'containers' && d.spec.kind === 'containers') {
      s.spec = { ...s.spec, containers: d.spec.containers.slice(), projectDir: d.spec.projectDir ?? s.spec.projectDir };
    }
    s.ports = clone(d.ports);
  }
  // Docker Desktop's row stays last.
  const dd = services.findIndex((s) => s.spec.kind === 'docker-desktop');
  if (dd >= 0 && dd !== services.length - 1) services.push(services.splice(dd, 1)[0]);
  const registry: ServicesRegistryFile = { ...reg, services };
  return { registry, added };
}
