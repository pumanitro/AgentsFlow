// Which Docker projects exist on this Mac, running or stopped, and which host
// ports each one publishes. A compose project becomes one service; a supabase-CLI
// project becomes one service of its containers; a container that belongs to no
// project is a service on its own.
//
// Host ports come from `docker inspect` (HostConfig.PortBindings), not from
// `docker ps`: a stopped container shows only its exposed ports there, and the
// wake guard needs the host side of a sleeping project.
//
// Pure parsers plus one async collector that takes its `exec` as an argument
// (like guard/docker-inventory.ts), so tests feed it text and no command runs
// while Docker is down.

import * as path from 'path';
import type { ServicePort, ServiceSpecCompose, ServiceSpecContainers } from '../../shared/services';
import { parseComposeLs, parseDockerPsJson, supabaseProjectDir, type ComposeProject, type ContainerInfo, type Exec } from '../guard/docker-inventory';

export const SERVICES_INSPECT_FORMAT = '{{.Name}}\t{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{index .Config.Labels "com.docker.compose.project.config_files"}}\t{{index .Config.Labels "com.supabase.cli.project"}}\t{{json .HostConfig.PortBindings}}';

export interface ServiceInspectRow { name: string; project: string | null; projectDir: string | null; configFiles: string[]; supabase: string | null; ports: ServicePort[] }
export interface Discovered { id: string; name: string; spec: ServiceSpecCompose | ServiceSpecContainers; ports: ServicePort[] }

const PS_TIMEOUT_MS = 5_000;
const DOCKER_TIMEOUT_MS = 20_000;

function label(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t && t !== '<no value>' ? t : null;
}

/** One entry per host port; a binding on every interface wins over loopback. Sorted by port. */
function mergePorts(ports: ServicePort[]): ServicePort[] {
  const by = new Map<number, ServicePort>();
  for (const p of ports) {
    const had = by.get(p.port);
    if (!had || (had.host === '127.0.0.1' && p.host === '0.0.0.0')) by.set(p.port, { port: p.port, host: p.host });
  }
  return Array.from(by.values()).sort((a, b) => a.port - b.port);
}

/** `{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"5544"}]}` → host ports. `null`/`{}`/junk → []. */
export function parsePortBindings(json: string): ServicePort[] {
  let j: unknown;
  try {
    j = JSON.parse((json || '').trim());
  } catch {
    return [];
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return [];
  const out: ServicePort[] = [];
  for (const [key, list] of Object.entries(j as Record<string, unknown>)) {
    // The wake guard holds TCP only.
    if (!/\/tcp$/.test(key) || !Array.isArray(list)) continue;
    for (const b of list) {
      if (!b || typeof b !== 'object') continue;
      const hp = (b as Record<string, unknown>).HostPort;
      const port = typeof hp === 'string' && /^\d+$/.test(hp) ? Number(hp) : NaN;
      // An empty HostPort is "Docker picks one at start" — nothing to guard.
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
      const ip = (b as Record<string, unknown>).HostIp;
      out.push({ port, host: ip === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0' });
    }
  }
  return mergePorts(out);
}

/** `docker inspect -f SERVICES_INSPECT_FORMAT <names>` (leading '/' stripped). */
export function parseServicesInspect(tsv: string): ServiceInspectRow[] {
  const out: ServiceInspectRow[] = [];
  for (const line of (tsv || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 2) continue;
    const name = f[0].trim().replace(/^\//, '');
    if (!name) continue;
    const files = label(f[3]);
    out.push({
      name,
      project: label(f[1]),
      projectDir: label(f[2]),
      configFiles: files ? files.split(',').map((s) => s.trim()).filter(Boolean) : [],
      supabase: label(f[4]),
      ports: parsePortBindings(f[5] ?? ''),
    });
  }
  return out;
}

/** A label value out of `docker ps`'s comma-joined Labels column. */
function psLabel(labels: string, key: string): string | null {
  for (const part of (labels || '').split(',')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at) === key) return label(part.slice(at + 1));
  }
  return null;
}

interface Group { id: string; name: string; kind: 'compose' | 'containers'; project: string | null; configFiles: string[]; projectDir: string | null; containers: string[]; ports: ServicePort[] }

/**
 * Every Docker project (running or stopped) as one service:
 * compose project with config files → 'compose:<project>'; supabase project →
 * 'containers:<project>'; a project with no config files anywhere →
 * 'containers:<project>'; a container with no project → 'containers:<name>'.
 * Sorted by id.
 */
export function discoverDocker(ps: ContainerInfo[], inspect: ServiceInspectRow[], composeLs: ComposeProject[]): Discovered[] {
  const rows = new Map(inspect.map((r) => [r.name, r]));
  const compose = new Map(composeLs.map((c) => [c.name, c]));
  const groups = new Map<string, Group>();

  for (const c of ps) {
    const r = rows.get(c.name);
    const project = r?.project ?? psLabel(c.labels, 'com.docker.compose.project');
    const supabase = r?.supabase ?? psLabel(c.labels, 'com.supabase.cli.project');
    const ls = project ? compose.get(project) : undefined;
    const files = ls && ls.configFiles.length ? ls.configFiles : r?.configFiles.length ? r.configFiles : (psLabel(c.labels, 'com.docker.compose.project.config_files') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    let g: Omit<Group, 'containers' | 'ports'>;
    if (supabase) {
      g = { id: `containers:${supabase}`, name: `${supabase} — Supabase (Docker)`, kind: 'containers', project: supabase, configFiles: [], projectDir: supabaseProjectDir(c.labels) ?? r?.projectDir ?? null };
    } else if (project && files.length) {
      const dir = r?.projectDir ?? psLabel(c.labels, 'com.docker.compose.project.working_dir') ?? ls?.dir ?? (path.isAbsolute(files[0]) ? path.dirname(files[0]) : null);
      g = { id: `compose:${project}`, name: `${project} — Docker project`, kind: 'compose', project, configFiles: files, projectDir: dir };
    } else if (project) {
      g = { id: `containers:${project}`, name: `${project} — Docker project`, kind: 'containers', project, configFiles: [], projectDir: r?.projectDir ?? null };
    } else {
      g = { id: `containers:${c.name}`, name: `${c.name} — Docker container`, kind: 'containers', project: null, configFiles: [], projectDir: null };
    }

    let have = groups.get(g.id);
    if (!have) {
      have = { ...g, containers: [], ports: [] };
      groups.set(g.id, have);
    }
    if (!have.projectDir && g.projectDir) have.projectDir = g.projectDir;
    if (!have.containers.includes(c.name)) have.containers.push(c.name);
    if (r) have.ports.push(...r.ports);
  }

  return Array.from(groups.values())
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((g): Discovered => ({
      id: g.id,
      name: g.name,
      spec: g.kind === 'compose'
        ? { kind: 'compose', project: g.project as string, configFiles: g.configFiles, projectDir: g.projectDir, containers: g.containers }
        : { kind: 'containers', containers: g.containers, projectDir: g.projectDir },
      ports: mergePorts(g.ports),
    }));
}

/**
 * null = Docker is down, or a command the ports depend on failed — the caller
 * then changes nothing. Only `compose ls` is optional (its config files are also
 * on the containers' labels).
 */
export async function collectDockerDiscovery(exec: Exec): Promise<Discovered[] | null> {
  // Only ask Docker when its VM is up — otherwise the CLI hangs on a dead socket.
  const up = await exec('pgrep', ['-q', 'com.docker.backend'], PS_TIMEOUT_MS);
  if (up === null) return null;

  const psOut = await exec('docker', ['ps', '-a', '--format', '{{json .}}'], DOCKER_TIMEOUT_MS);
  if (psOut === null) return null;
  const ps = parseDockerPsJson(psOut);
  if (ps.length === 0) return [];

  const [inspect, composeLs] = await Promise.all([
    exec('docker', ['inspect', '-f', SERVICES_INSPECT_FORMAT, ...ps.map((c) => c.name)], DOCKER_TIMEOUT_MS),
    exec('docker', ['compose', 'ls', '--all', '--format', 'json'], DOCKER_TIMEOUT_MS),
  ]);
  if (inspect === null) return null;
  return discoverDocker(ps, parseServicesInspect(inspect), composeLs === null ? [] : parseComposeLs(composeLs));
}
