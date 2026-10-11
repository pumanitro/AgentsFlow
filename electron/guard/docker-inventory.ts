// What Docker is running, read with five cheap commands: `docker ps`, one
// `docker inspect`, `docker stats --no-stream`, `docker compose ls` and
// `netstat` for established connections on published ports (`lsof` shows
// nothing for Docker's port forwards).
//
// Pure parsers plus one async collector that takes its `exec` as an argument,
// so no child process is ever spawned synchronously and tests feed it text.

import * as path from 'path';

export interface ContainerInfo { name: string; running: boolean; ports: string; labels: string; id: string }
export interface InspectRow { name: string; autoRemove: boolean; project: string | null; projectDir: string | null; startedAt: number | null }
export interface StatsRow { name: string; cpuPct: number; memMB: number; netRxBytes: number; netTxBytes: number }
export interface ComposeProject { name: string; status: string; configFiles: string[]; dir: string | null }

export const INSPECT_FORMAT = '{{.Name}}\t{{.HostConfig.AutoRemove}}\t{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{.State.StartedAt}}';
export const STATS_FORMAT = '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}';

const PS_TIMEOUT_MS = 5_000;
const DOCKER_TIMEOUT_MS = 20_000;

/** `docker ps --format '{{json .}}'` — one JSON per line. */
export function parseDockerPsJson(text: string): ContainerInfo[] {
  const out: ContainerInfo[] = [];
  for (const line of (text || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      const name = typeof j.Names === 'string' ? j.Names.split(',')[0].trim() : '';
      if (!name) continue;
      out.push({
        name,
        running: typeof j.State === 'string' && j.State.toLowerCase() === 'running',
        ports: typeof j.Ports === 'string' ? j.Ports : '',
        labels: typeof j.Labels === 'string' ? j.Labels : '',
        id: typeof j.ID === 'string' ? j.ID : '',
      });
    } catch {
      /* not a row */
    }
  }
  return out;
}

function label(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t && t !== '<no value>' ? t : null;
}

/**
 * format: '{{.Name}}\t{{.HostConfig.AutoRemove}}\t{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{.State.StartedAt}}'
 * (leading '/' stripped).
 */
export function parseInspectRows(tsv: string): InspectRow[] {
  const out: InspectRow[] = [];
  for (const line of (tsv || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 2) continue;
    const name = f[0].trim().replace(/^\//, '');
    if (!name) continue;
    // A container that never ran reports the zero time.
    const started = Date.parse((f[4] ?? '').trim());
    out.push({
      name,
      autoRemove: f[1].trim() === 'true',
      project: label(f[2]),
      projectDir: label(f[3]),
      startedAt: Number.isFinite(started) && started > 0 ? started : null,
    });
  }
  return out;
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

/** "283.4MiB" / "1.86kB" / "0B" → bytes; NaN when unreadable. */
function sizeBytes(text: string): number {
  const m = /^([\d.]+)\s*([a-zA-Z]+)$/.exec((text || '').trim());
  if (!m) return NaN;
  const unit = SIZE_UNITS[m[2].toLowerCase()];
  const n = Number(m[1]);
  return unit && Number.isFinite(n) ? n * unit : NaN;
}

/** '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}'  ("1.26MB / 1.84MB"). */
export function parseStatsRows(tsv: string): StatsRow[] {
  const out: StatsRow[] = [];
  for (const line of (tsv || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 4) continue;
    const name = f[0].trim();
    const cpuPct = Number.parseFloat(f[1]);
    const mem = sizeBytes(f[2].split('/')[0]);
    const net = f[3].split('/');
    const rx = sizeBytes(net[0]);
    const tx = sizeBytes(net[1] ?? '');
    // A row docker could not fill ("--") is no reading at all, not "idle".
    if (!name || !Number.isFinite(cpuPct) || !Number.isFinite(mem) || !Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    out.push({ name, cpuPct, memMB: mem / 1024 ** 2, netRxBytes: rx, netTxBytes: tx });
  }
  return out;
}

/** `docker compose ls --all --format json`; dir = dirname(ConfigFiles[0]). */
export function parseComposeLs(json: string): ComposeProject[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ComposeProject[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const j = raw as Record<string, unknown>;
    if (typeof j.Name !== 'string' || !j.Name) continue;
    const configFiles = typeof j.ConfigFiles === 'string' ? j.ConfigFiles.split(',').map((s) => s.trim()).filter(Boolean) : [];
    out.push({
      name: j.Name,
      status: typeof j.Status === 'string' ? j.Status : '',
      configFiles,
      dir: configFiles[0] && path.isAbsolute(configFiles[0]) ? path.dirname(configFiles[0]) : null,
    });
  }
  return out;
}

/**
 * The project folder of a supabase-CLI container, read off the `Labels` column
 * of `docker ps`. The CLI sets `com.docker.compose.project` but no working dir
 * or config files, and its projects are not in `compose ls` (verified
 * 2026-10-11) — the only trace of the folder is a host bind recorded by Docker
 * Desktop: `desktop.docker.io/binds/N/Source=<root>/supabase/…`. Returns
 * `<root>`, or null when the container is not supabase's or has no such bind.
 */
export function supabaseProjectDir(labels: string): string | null {
  if (!/(^|,)com\.supabase\.cli\.project=/.test(labels || '')) return null;
  for (const m of labels.matchAll(/desktop\.docker\.io\/binds\/\d+\/Source=([^,]+)/g)) {
    const src = m[1].trim();
    const at = src.indexOf('/supabase/');
    const root = at > 0 ? src.slice(0, at) : src.endsWith('/supabase') ? src.slice(0, -'/supabase'.length) : '';
    if (root.startsWith('/') && root.length > 1) return root;
  }
  return null;
}

/** "0.0.0.0:55423->3000/tcp, 8080/tcp" → [55423]. Host ranges ("3000-3010->…") expand. */
export function publishedPorts(ports: string): number[] {
  const out = new Set<number>();
  for (const part of (ports || '').split(',')) {
    const m = /:(\d+)(?:-(\d+))?->/.exec(part);
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    if (hi < lo || hi - lo > 1024) { out.add(lo); continue; }
    for (let p = lo; p <= hi; p++) out.add(p);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/** `netstat -anp tcp` → local port → ESTABLISHED count. */
export function parseEstablishedPorts(netstat: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of (netstat || '').split('\n')) {
    if (!line.includes('ESTABLISHED')) continue;
    const f = line.trim().split(/\s+/);
    // Proto Recv-Q Send-Q Local Foreign (state); the port is the suffix after the last dot.
    const m = /\.(\d+)$/.exec(f[3] ?? '');
    if (!m) continue;
    const port = Number(m[1]);
    out.set(port, (out.get(port) ?? 0) + 1);
  }
  return out;
}

/** Runs one command; resolves its stdout, or null on failure/timeout. Never sync. */
export type Exec = (cmd: string, args: string[], timeoutMs: number) => Promise<string | null>;

/**
 * null = no trustworthy inventory this round (Docker's VM is down, or a command
 * the verdicts depend on failed). The caller must then judge nothing: a missing
 * stats or netstat reading would otherwise look like "every container is idle".
 * Only `compose ls` is optional.
 */
export async function collectInventory(exec: Exec): Promise<{ containers: ContainerInfo[]; inspect: InspectRow[]; stats: StatsRow[]; compose: ComposeProject[]; conns: Map<number, number> } | null> {
  // Only ask Docker when its VM is actually up — otherwise the CLI hangs on a
  // dead socket for the whole timeout (sysmon.ts rule).
  const up = await exec('pgrep', ['-q', 'com.docker.backend'], PS_TIMEOUT_MS);
  if (up === null) return null;

  const ps = await exec('docker', ['ps', '-a', '--format', '{{json .}}'], DOCKER_TIMEOUT_MS);
  if (ps === null) return null;
  const containers = parseDockerPsJson(ps);
  if (containers.length === 0) return { containers, inspect: [], stats: [], compose: [], conns: new Map() };

  const [inspect, stats, compose, netstat] = await Promise.all([
    exec('docker', ['inspect', '-f', INSPECT_FORMAT, ...containers.map((c) => c.name)], DOCKER_TIMEOUT_MS),
    exec('docker', ['stats', '--no-stream', '--format', STATS_FORMAT], DOCKER_TIMEOUT_MS),
    exec('docker', ['compose', 'ls', '--all', '--format', 'json'], DOCKER_TIMEOUT_MS),
    exec('netstat', ['-anp', 'tcp'], PS_TIMEOUT_MS),
  ]);
  if (inspect === null || stats === null || netstat === null) return null;

  return {
    containers,
    inspect: parseInspectRows(inspect),
    stats: parseStatsRows(stats),
    compose: compose === null ? [] : parseComposeLs(compose),
    conns: parseEstablishedPorts(netstat),
  };
}
