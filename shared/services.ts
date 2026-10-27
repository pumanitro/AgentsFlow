// Managed services: things Peers Flow puts to sleep when nobody uses them and wakes on demand.
//
// One shared module (like shared/routines.ts) for the types, the IPC channel
// names and the defaults, so the main-process loop (electron/services), the
// preload bridge and the Performance-panel UI all name the same things.
import type { MemLevel } from './types';   // type-only, cycle is fine (types.ts already imports this file type-only)

export type ServiceKind = 'process' | 'compose' | 'containers' | 'docker-desktop';
export type ServicesMode = 'live' | 'watch';            // 'watch' = observe and list only, never stop or start by itself
export interface ServicePort { port: number; host: '127.0.0.1' | '0.0.0.0' }

/** A plain process Peers Flow spawns itself (e.g. the atlas dashboard API). */
export interface ServiceSpecProcess {
  kind: 'process';
  cmd: string;                         // name resolved on the app's PATH (agentEnvironment()) or an absolute path; never 'ssh'
  args: string[];
  cwd: string;                         // absolute, under $HOME
  env?: Record<string, string>;
  logFile: string;                     // absolute; stdout+stderr appended (O_APPEND)
  health?: string;                     // http URL that answers 2xx when ready; absent = "a port accepts TCP"
}
/** A Docker compose project, stopped/started with `docker compose -p … stop|start`. */
export interface ServiceSpecCompose {
  kind: 'compose';
  project: string;                     // `docker compose -p`
  configFiles: string[];               // absolute; if any is missing the driver falls back to docker start/stop by names
  projectDir: string | null;
  containers: string[];                // container names of the project (refreshed by discovery)
}
/** Supabase-CLI projects and standalone containers, stopped/started by container name. */
export interface ServiceSpecContainers {  // supabase-CLI projects and standalone containers
  kind: 'containers';
  containers: string[];
  projectDir: string | null;
}
/** Docker Desktop itself (`docker desktop start|stop`). */
export interface ServiceSpecDockerDesktop { kind: 'docker-desktop' }
export type ServiceSpec = ServiceSpecProcess | ServiceSpecCompose | ServiceSpecContainers | ServiceSpecDockerDesktop;

/** One entry of the registry file (`services.json`). */
export interface ManagedService {
  id: string;                          // 'atlas-dashboard-api' | 'compose:<project>' | 'containers:<project-or-name>' | 'docker-desktop'
  name: string;                        // plain words for the UI
  spec: ServiceSpec;
  ports: ServicePort[];                // public ports guarded by the wake proxy while asleep (persisted; refreshed while Docker is up)
  idleMinutes: number;                 // SERVICE_DEFAULTS.idleMinutes; docker-desktop: dockerDesktopIdleMinutes
  pinned: boolean;                     // never put to sleep for being idle
  managed: boolean;                    // false = listed only, never touched
  source: 'seed' | 'discovered' | 'user';
}
/** `services.json` — user-editable registry. `pressureIdleMinutes` absent = SERVICE_DEFAULTS.pressureIdleMinutes. */
export interface ServicesRegistryFile { version: 1; mode: ServicesMode; pressureIdleMinutes?: number; services: ManagedService[] }
/** Machine-written clocks, kept across app restarts. Epoch ms. */
export interface ServicesStateFile { version: 1; lastUsedAt: Record<string, number>; sleptAt: Record<string, number>; wokeAt: Record<string, number>; dockerQuietSince: number | null }

export type ServiceState = 'awake' | 'asleep' | 'waking' | 'sleeping' | 'unknown';
export type ServiceVerdict = 'in-use' | 'idle' | 'pinned' | 'too-new' | 'asleep' | 'waking' | 'sleeping' | 'unmanaged' | 'blocked' | 'unknown';
/** One row of the Performance panel's "Sleeping services" section. */
export interface ServiceRow {
  id: string; name: string; kind: ServiceKind; state: ServiceState; verdict: ServiceVerdict;
  note: string;                        // plain words, shown verbatim: "used 12 min ago", "asleep since 09:41 — wakes on the first request to :5545"
  pinned: boolean; managed: boolean; idleMinutes: number; idleForMinutes: number | null;
  ports: ServicePort[]; guardedPorts: number[];      // ports the wake proxy currently holds
  lastUsedAt: string | null; since: string | null;   // ISO; `since` = current state since
  cpuPct: number | null; memMB: number | null; establishedConns: number;
  canWake: boolean; canSleep: boolean;
}
export type ServiceLogEvent = 'slept' | 'woke' | 'sleep-failed' | 'wake-failed' | 'proxy-armed' | 'proxy-failed' | 'discovered' | 'docker-started' | 'docker-stopped';
export type ServiceLogBy = 'idle' | 'pressure' | 'request' | 'click' | 'startup' | 'docker';
/** One line of `services-log.jsonl`. */
export interface ServiceLogEntry { at: string; id: string; name: string; event: ServiceLogEvent; by: ServiceLogBy; detail: string }
/** What the UI renders; pushed on 'services:updated' and returned by 'services:snapshot'. */
export interface ServicesSnapshot {
  at: string; mode: ServicesMode;
  docker: 'up' | 'down' | 'starting' | 'stopping' | 'unknown';
  memory: { level: MemLevel; pressure: boolean; queue: string[] };   // pressure = level is warn|closed|critical; queue = ids that would be slept early, least-recently-used first
  services: ServiceRow[];              // docker-desktop row last
  recent: ServiceLogEntry[];           // newest first, max 30
  files: { registry: string; state: string; log: string };
}
export interface ServiceActionResult { ok: boolean; error?: string; snapshot: ServicesSnapshot }

export const SERVICES_IPC = {
  snapshot: 'services:snapshot', wake: 'services:wake', sleep: 'services:sleep', setPin: 'services:setPin',
  setIdle: 'services:setIdle', setManaged: 'services:setManaged', setMode: 'services:setMode',
  rediscover: 'services:rediscover', updated: 'services:updated',
} as const;
export const SERVICE_DEFAULTS = {
  idleMinutes: 240, dockerDesktopIdleMinutes: 15, tickMs: 60_000, minObservationMs: 30 * 60_000,
  stopGraceMs: 20_000, stopKillMs: 10_000, composeStopSeconds: 30, wakeTimeoutMs: 120_000,
  dockerStartTimeoutMs: 180_000, dockerStopTimeoutMs: 120_000, holdMs: 240_000, maxSleepsPerTick: 2, recentMax: 30,
  pressureIdleMinutes: 30,
} as const;
/** Memory-guard levels at which idle services are slept early, least-recently-used first. */
export const MEM_PRESSURE_LEVELS: readonly MemLevel[] = ['warn', 'closed', 'critical'];
