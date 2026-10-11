// The memory guard: an in-app sampler and a use-based container actor.
//
// Every GUARD_TICK_MS it samples memory (vm_stat, the kernel pressure level,
// swap) and walks the ladder in mem-level.ts; every second tick it refreshes
// the Docker inventory and gives each container a verdict (use-ladder.ts). At
// 'critical' the actor (pressure-actor.ts) stops what nobody is using — in
// dry-run by default, where it only logs what it WOULD stop.
//
// It also owns the admission-closed file: written every tick while the level is
// closed or critical and removed otherwise, which is how the sub-agent
// admission hook learns that the door is shut.
//
// Every command goes through an async exec with a timeout — never a sync child
// process (a synchronous probe has frozen this app's main thread before).
// What a container did lately lives in this process only: an app restart
// restarts every idle clock, so nothing is judged idle on less than a full
// window of this run's own observation (conservative on purpose).

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Conversation, GuardContainerRow, GuardPins, GuardSnapshot, KillLogEntry, MemLevel, MemSample } from '../../shared/types';
import type { ClaudeAgentJsonRow } from '../claude-cli';
import { ADMISSION_CLOSED_FILE, ADMISSION_CLOSED_FRESH_MS, KILL_LOG, PINS_FILE } from '../keeper/paths';
import { collectInventory } from './docker-inventory';
import type { ContainerInfo, Exec, InspectRow, StatsRow } from './docker-inventory';
import { publishedPorts, supabaseProjectDir } from './docker-inventory';
import { appendKillLog, readKillLogSince } from './kill-log';
import { nextLevel, parseMemSample, swapGrowthGBper5min } from './mem-level';
import type { LevelState } from './mem-level';
import { readPins, writePins } from './pins';
import { applyActions, planActions } from './pressure-actor';
import { containerVerdict, isActive } from './use-ladder';

export interface GuardDeps { liveRows: () => ClaudeAgentJsonRow[]; getConversations: () => Conversation[]; notify: (t: string, b: string) => void; onSnapshot: (s: GuardSnapshot) => void; exec?: Exec; now?: () => number }

export const GUARD_TICK_MS = 30_000;

const SAMPLE_CMD_TIMEOUT_MS = 5_000;
const SAMPLE_KEEP_MS = 15 * 60_000;
const INVENTORY_EVERY_TICKS = 2;
const FIRST_TICK_DELAY_MS = 5_000;
const RECENT_MAX = 20;
const KILL_LOG_SEED_BYTES = 256 * 1024;

/** The default exec: async, bounded, null on any failure. An empty stdout is a success (`pgrep -q`). */
const defaultExec: Exec = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs }, (err, stdout) => {
        resolve(err ? null : String(stdout ?? ''));
      });
    } catch {
      resolve(null);
    }
  });

interface Cached { info: ContainerInfo; inspect: InspectRow | null; stats: StatsRow | null; conns: number; ports: number[]; projectDir: string | null }
interface Activity { lastActiveAt: number | null; firstSeenAt: number; prevStats: StatsRow | null }

const DEFAULT_FILES = { pins: PINS_FILE, killLog: KILL_LOG, admission: ADMISSION_CLOSED_FILE };
let files = { ...DEFAULT_FILES };

function initialLevel(): LevelState {
  return { level: 'unknown', since: Date.now(), reasons: [], warnSince: null, critTicks: 0, okTicks: 0 };
}

let timer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
let inflight = false;
let deps: GuardDeps | null = null;
let tick = 0;
let samples: MemSample[] = [];
let level: LevelState = initialLevel();
let inventory: Cached[] | null = null;
const activity = new Map<string, Activity>();
// name → epoch ms at which a noticed (no-project) candidate may be stopped
const notices = new Map<string, number>();
// names already handled in this critical episode (would-stopped in dry-run, or
// a live stop that failed) — so the next tick moves on instead of repeating
const handled = new Set<string>();
// name → epoch ms of this guard's last real stop of it
const guardStopped = new Map<string, number>();
let liveCwds: string[] = [];
let recent: KillLogEntry[] = [];
let killOffset: number | null = null;
let admissionSince: number | null = null;
let admissionWrittenAt: number | null = null;
let snapshot: GuardSnapshot | null = null;

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function sampleMemory(exec: Exec, now: number): Promise<MemSample | null> {
  const [vm, pressure, swap] = await Promise.all([
    exec('vm_stat', [], SAMPLE_CMD_TIMEOUT_MS),
    exec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], SAMPLE_CMD_TIMEOUT_MS),
    exec('sysctl', ['-n', 'vm.swapusage'], SAMPLE_CMD_TIMEOUT_MS),
  ]);
  if (vm === null || swap === null) return null;
  return parseMemSample(vm, pressure ?? '', swap, now);
}

/** Written every tick while closed/critical (the hook trusts it for 120 s by mtime); removed at ok/warn. */
async function syncAdmissionFile(now: number): Promise<void> {
  const lv = level.level;
  if (lv === 'closed' || lv === 'critical') {
    if (admissionSince === null) admissionSince = now;
    const body = JSON.stringify({
      since: new Date(admissionSince).toISOString(),
      level: lv,
      reason: level.reasons.join('; '),
      writtenAt: new Date(now).toISOString(),
    });
    try {
      await fs.promises.mkdir(path.dirname(files.admission), { recursive: true });
      const tmp = `${files.admission}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, body + '\n');
      await fs.promises.rename(tmp, files.admission);
      admissionWrittenAt = now;
    } catch (err) {
      console.warn('[agentsflow][guard] could not write the admission-closed file', { error: String(err) });
    }
    return;
  }
  // 'unknown' leaves the file alone: it simply goes stale after 120 s.
  if (lv !== 'ok' && lv !== 'warn') return;
  admissionSince = null;
  admissionWrittenAt = null;
  try {
    await fs.promises.unlink(files.admission);
  } catch {
    /* not there */
  }
}

function refreshLiveCwds(d: GuardDeps): void {
  try {
    const rows = d.liveRows();
    const ids = new Set(rows.map((r) => r.sessionId).filter(Boolean));
    const cwds = new Set<string>();
    for (const r of rows) if (typeof r.cwd === 'string' && r.cwd) cwds.add(r.cwd);
    for (const c of d.getConversations()) {
      if (!c.sessionId || !ids.has(c.sessionId)) continue;
      if (c.worktreePath) cwds.add(c.worktreePath);
      if (c.directoryPath) cwds.add(c.directoryPath);
    }
    liveCwds = Array.from(cwds);
  } catch {
    /* keep the previous list: fewer protected dirs is the unsafe direction */
  }
}

async function refreshInventory(exec: Exec, now: number): Promise<void> {
  const inv = await collectInventory(exec);
  if (!inv) {
    // No trustworthy inventory ⇒ no rows, so nothing can be planned from stale facts.
    inventory = null;
    notices.clear();
    return;
  }
  const inspectBy = new Map(inv.inspect.map((r) => [r.name, r]));
  const statsBy = new Map(inv.stats.map((r) => [r.name, r]));
  const composeDir = new Map(inv.compose.map((p) => [p.name, p.dir]));
  // supabase-CLI projects: one container's bind names the folder for all of them.
  const supabaseDir = new Map<string, string>();
  for (const info of inv.containers) {
    const project = inspectBy.get(info.name)?.project;
    const dir = project && !supabaseDir.has(project) ? supabaseProjectDir(info.labels) : null;
    if (project && dir) supabaseDir.set(project, dir);
  }
  const seen = new Set<string>();
  inventory = inv.containers.map((info) => {
    const inspect = inspectBy.get(info.name) ?? null;
    const stats = statsBy.get(info.name) ?? null;
    const ports = publishedPorts(info.ports);
    const conns = ports.reduce((n, p) => n + (inv.conns.get(p) ?? 0), 0);
    const projectDir = inspect?.projectDir ?? (inspect?.project ? composeDir.get(inspect.project) ?? supabaseDir.get(inspect.project) ?? null : null);
    if (info.running) {
      seen.add(info.name);
      guardStopped.delete(info.name);
      const a = activity.get(info.name) ?? { lastActiveAt: null, firstSeenAt: now, prevStats: null };
      // A running container with no stats reading counts as active: missing data keeps, never stops.
      if (!stats || isActive(a.prevStats, stats, conns)) a.lastActiveAt = now;
      if (stats) a.prevStats = stats;
      activity.set(info.name, a);
    }
    return { info, inspect, stats, conns, ports, projectDir };
  });
  // Gone or stopped: forget it, so a restart is watched from scratch.
  for (const name of Array.from(activity.keys())) if (!seen.has(name)) activity.delete(name);
  for (const name of Array.from(notices.keys())) if (!seen.has(name)) notices.delete(name);
}

function buildRows(now: number, pins: GuardPins): GuardContainerRow[] {
  if (!inventory) return [];
  const rows: GuardContainerRow[] = [];
  for (const c of inventory) {
    const name = c.info.name;
    const pinned = pins.keep.includes(name);
    const base = {
      name,
      project: c.inspect?.project ?? null,
      projectDir: c.projectDir,
      autoRemove: c.inspect?.autoRemove ?? false,
      pinned,
      publishedPorts: c.ports,
    };
    if (!c.info.running) {
      // An exited container is shown only when this guard is what stopped it
      // (and it has not been started since).
      const stoppedAt = guardStopped.get(name);
      const startedAt = c.inspect?.startedAt ?? null;
      if (stoppedAt === undefined || (startedAt !== null && startedAt > stoppedAt)) continue;
      rows.push({
        ...base, running: false, cpuPct: null, memMB: null, establishedConns: 0, lastActiveAt: null, idleMinutes: null,
        verdict: 'stopped-by-guard', note: `stopped by the guard at ${hhmm(stoppedAt)} — bring it back with: docker start ${name}`,
      });
      continue;
    }
    const a = activity.get(name) ?? { lastActiveAt: null, firstSeenAt: now, prevStats: null };
    let { verdict, note } = containerVerdict({
      name, project: base.project, projectDir: c.projectDir, autoRemove: base.autoRemove, running: true,
      startedAt: c.inspect?.startedAt ?? null, pinned, liveCwds, lastActiveAt: a.lastActiveAt, firstSeenAt: a.firstSeenAt,
      idleMinutes: pins.idleMinutes, now,
    });
    // Without its inspect row we do not know whether it is --rm or whose it is: keep.
    if (!c.inspect && verdict === 'stop-candidate') { verdict = 'keep-active'; note = 'could not be inspected'; }
    const row: GuardContainerRow = {
      ...base, running: true,
      cpuPct: c.stats ? c.stats.cpuPct : null,
      memMB: c.stats ? Math.round(c.stats.memMB) : null,
      establishedConns: c.conns,
      lastActiveAt: a.lastActiveAt !== null ? new Date(a.lastActiveAt).toISOString() : null,
      idleMinutes: Math.max(0, Math.floor((now - (a.lastActiveAt ?? a.firstSeenAt)) / 60_000)),
      verdict, note,
    };
    const stoppingAt = notices.get(name);
    if (verdict !== 'stop-candidate') notices.delete(name);
    else if (stoppingAt !== undefined) {
      row.verdict = 'stopping';
      row.stoppingAt = new Date(stoppingAt).toISOString();
    } else if (handled.has(name)) {
      row.note = `${note} · already ${pins.mode === 'live' ? 'tried' : 'logged as WOULD-STOP (dry-run)'}`;
    }
    rows.push(row);
  }
  return rows.sort((x, y) => x.name.localeCompare(y.name));
}

/** New kill-log lines (ours and the launchd memguard's) → `recent`, newest first. */
function readKills(): void {
  if (killOffset === null) {
    // First read: only the tail — the log is append-only and never rotated here.
    try {
      killOffset = Math.max(0, fs.statSync(files.killLog).size - KILL_LOG_SEED_BYTES);
    } catch {
      killOffset = 0;
    }
  }
  const r = readKillLogSince(killOffset, files.killLog);
  killOffset = r.offset;
  if (r.entries.length === 0) return;
  for (const e of r.entries) {
    if (e.by !== 'peersflow-guard' || e.kind !== 'container' || e.dry) continue;
    const at = Date.parse(e.at);
    if (Number.isFinite(at) && at > (guardStopped.get(e.name) ?? 0)) guardStopped.set(e.name, at);
  }
  recent = [...r.entries.reverse(), ...recent].slice(0, RECENT_MAX);
}

function emptySnapshot(pins: GuardPins): GuardSnapshot {
  const at = new Date().toISOString();
  return {
    at, level: 'unknown', levelSince: at, reasons: [], sample: null, swapGrowthGBper5min: null,
    mode: pins.mode, idleMinutes: pins.idleMinutes, admissionClosed: false, containers: [], recent: [],
  };
}

function publish(now: number, pins: GuardPins, rows: GuardContainerRow[], sample: MemSample | null): void {
  snapshot = {
    at: new Date(now).toISOString(),
    level: level.level,
    levelSince: new Date(level.since).toISOString(),
    reasons: level.reasons,
    sample,
    swapGrowthGBper5min: swapGrowthGBper5min(samples, now),
    mode: pins.mode,
    idleMinutes: pins.idleMinutes,
    admissionClosed: admissionWrittenAt !== null && now - admissionWrittenAt < ADMISSION_CLOSED_FRESH_MS,
    containers: rows,
    recent,
  };
  try {
    deps?.onSnapshot(snapshot);
  } catch {
    /* a torn-down window must not break the tick */
  }
}

async function pass(d: GuardDeps): Promise<void> {
  deps = d;
  const now = d.now?.() ?? Date.now();
  const exec = d.exec ?? defaultExec;

  const sample = await sampleMemory(exec, now);
  if (sample) samples.push(sample);
  samples = samples.filter((s) => now - s.at <= SAMPLE_KEEP_MS);
  const before = level.level;
  level = nextLevel(level, sample, samples, now);
  if (level.level !== before) {
    console.log(`[agentsflow][guard] level ${before} → ${level.level}${level.reasons.length ? `: ${level.reasons.join('; ')}` : ''}`);
  }
  if (level.level !== 'critical') handled.clear();
  await syncAdmissionFile(now);

  if (tick % INVENTORY_EVERY_TICKS === 0) await refreshInventory(exec, now);
  tick++;
  refreshLiveCwds(d);
  readKills();

  // Read as late as possible: flipping the file back to dry-run takes effect on this very tick.
  const pins = readPins(files.pins);
  let rows = buildRows(now, pins);
  const actions = planActions(level.level, rows.filter((r) => !handled.has(r.name)), pins, now);
  if (actions.length > 0) {
    const entries = await applyActions(actions, { mode: pins.mode, exec, notify: d.notify, now });
    const logged = new Map(entries.map((e) => [e.name, e]));
    for (const a of actions) {
      if (a.kind === 'notice') { notices.set(a.name, a.stoppingAt); continue; }
      notices.delete(a.name);
      if (a.kind !== 'stop') continue;
      handled.add(a.name);
      const e = logged.get(a.name);
      if (!e) continue;
      try {
        appendKillLog(e, files.killLog);
      } catch (err) {
        console.warn('[agentsflow][guard] could not append to the kill log', { error: String(err) });
      }
      if (!e.dry) {
        guardStopped.set(a.name, now);
        activity.delete(a.name);
        const c = inventory?.find((x) => x.info.name === a.name);
        if (c) c.info = { ...c.info, running: false };
      }
    }
    readKills();
    rows = buildRows(now, pins);
  }
  publish(now, pins, rows, sample);
}

export function startGuard(d: GuardDeps): void {
  if (timer || firstTimer) return;
  deps = d;
  // Not on the launch burst itself: the first pass waits a few seconds.
  firstTimer = setTimeout(() => {
    firstTimer = null;
    void runGuardOnce(d);
  }, FIRST_TICK_DELAY_MS);
  firstTimer.unref?.();
  timer = setInterval(() => void runGuardOnce(d), GUARD_TICK_MS);
  timer.unref?.();
}

export function stopGuard(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
}

/** One pass. Never throws. A pass still running (a slow docker) makes the next one a no-op. */
export async function runGuardOnce(d: GuardDeps): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    await pass(d);
  } catch (err) {
    console.warn('[agentsflow][guard] tick failed', { error: String(err) });
  } finally {
    inflight = false;
  }
}

export function getGuardSnapshot(): GuardSnapshot {
  return snapshot ?? emptySnapshot(readPins(files.pins));
}

export function getMemLevel(): MemLevel {
  return level.level;
}

export function setPins(patch: { mode?: GuardPins['mode']; idleMinutes?: number; keep?: { name: string; keep: boolean } }): GuardPins {
  const prev = readPins(files.pins);
  const keep = new Set(prev.keep);
  if (patch.keep && typeof patch.keep.name === 'string' && patch.keep.name) {
    if (patch.keep.keep) keep.add(patch.keep.name);
    else keep.delete(patch.keep.name);
  }
  const next: GuardPins = {
    version: 1,
    keep: Array.from(keep).sort(),
    mode: patch.mode === 'live' || patch.mode === 'dry-run' ? patch.mode : prev.mode,
    idleMinutes: typeof patch.idleMinutes === 'number' && Number.isFinite(patch.idleMinutes) && patch.idleMinutes > 0 ? patch.idleMinutes : prev.idleMinutes,
  };
  writePins(next, files.pins);
  if (next.mode !== prev.mode) console.log(`[agentsflow][guard] mode ${prev.mode} → ${next.mode}`);
  // Re-evaluate at once from the facts already in hand (no command is run): a
  // pin takes a container off the list — and withdraws its notice — immediately.
  if (snapshot) {
    const now = deps?.now?.() ?? Date.now();
    publish(now, next, buildRows(now, next), snapshot.sample);
  }
  return next;
}

/** Test seam: reset the module's loop state between cases. */
export function __resetGuardForTests(): void {
  stopGuard();
  files = { ...DEFAULT_FILES };
  inflight = false;
  deps = null;
  tick = 0;
  samples = [];
  level = initialLevel();
  inventory = null;
  activity.clear();
  notices.clear();
  handled.clear();
  guardStopped.clear();
  liveCwds = [];
  recent = [];
  killOffset = null;
  admissionSince = null;
  admissionWrittenAt = null;
  snapshot = null;
}

/** Test seam: point the three files the guard touches somewhere else (call after the reset). */
export function __setGuardFilesForTests(f: { pins?: string; killLog?: string; admission?: string }): void {
  files = { ...files, ...f };
}
