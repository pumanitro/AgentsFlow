import * as fs from 'fs';
import * as path from 'path';
import type { RoutinesStore } from './routines-api';
import {
  CADENCES,
  ROUTINE_ICONS,
  RUNS_RETENTION_DAYS,
  RUNS_SNAPSHOT_DAYS,
  type Routine,
  type RoutineCadence,
  type RoutineIcon,
  type RoutineRun,
  type RoutineSchedule,
  type RunStatus,
  type RunTrigger,
} from '../shared/routines';

// Routines live in their own file (<userData>/routines.json) so the big
// conversation store never has to know about them, and a corrupt routines file
// can never take the chat list down with it.

const FILE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 250;
const DAY_MS = 24 * 60 * 60 * 1000;

// deletedSeedKeys: seeds the owner deleted, so a relaunch does not seed them again.
interface FileShape { version: number; routines: Routine[]; runs: RoutineRun[]; deletedSeedKeys: string[] }

const RUN_STATUSES: RunStatus[] = ['running', 'attention', 'success', 'failed', 'missed'];
const RUN_TRIGGERS: RunTrigger[] = ['schedule', 'catchup', 'manual'];

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const isoOrUndef = (v: unknown): string | undefined => {
  const s = str(v);
  return s && Number.isFinite(Date.parse(s)) ? s : undefined;
};

function sanitizeSchedule(s: any): RoutineSchedule | null {
  if (!s || typeof s !== 'object') return null;
  // An unknown cadence means a newer app wrote this file; we cannot schedule it.
  if (!CADENCES.includes(s.cadence)) return null;
  const out: RoutineSchedule = { cadence: s.cadence as RoutineCadence, time: str(s.time) ?? '09:00' };
  if (Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6) out.weekday = s.weekday;
  if (Array.isArray(s.monthDays)) {
    const days = s.monthDays.filter((d: unknown) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 28);
    if (days.length) out.monthDays = days;
  }
  if (typeof s.anchorDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.anchorDate)) out.anchorDate = s.anchorDate;
  return out;
}

function sanitizeRoutine(r: any): Routine | null {
  if (!r || typeof r !== 'object') return null;
  const id = str(r.id);
  const schedule = sanitizeSchedule(r.schedule);
  if (!id || !schedule) return null;
  const createdAt = isoOrUndef(r.createdAt) ?? new Date().toISOString();
  const directoryId = str(r.directoryId) ?? '';
  const out: Routine = {
    id,
    name: str(r.name) ?? '',
    directoryId,
    provider: r.provider === 'codex' ? 'codex' : 'claude',
    prompt: str(r.prompt) ?? '',
    schedule,
    icon: ROUTINE_ICONS.includes(r.icon) ? (r.icon as RoutineIcon) : 'star',
    // A routine with no peer can never run, so it can never be enabled either.
    enabled: r.enabled === true && directoryId !== '',
    createdAt,
    updatedAt: isoOrUndef(r.updatedAt) ?? createdAt,
  };
  const model = str(r.model);
  if (model) out.model = model;
  const enabledAt = isoOrUndef(r.enabledAt);
  if (enabledAt) out.enabledAt = enabledAt;
  const seedKey = str(r.seedKey);
  if (seedKey) out.seedKey = seedKey;
  return out;
}

function sanitizeRun(r: any): RoutineRun | null {
  if (!r || typeof r !== 'object') return null;
  const id = str(r.id);
  const routineId = str(r.routineId);
  const slotAt = isoOrUndef(r.slotAt);
  if (!id || !routineId || !slotAt) return null;
  if (!RUN_STATUSES.includes(r.status) || !RUN_TRIGGERS.includes(r.trigger)) return null;
  const out: RoutineRun = {
    id,
    routineId,
    slotAt,
    trigger: r.trigger,
    status: r.status,
    startedAt: isoOrUndef(r.startedAt) ?? slotAt,
  };
  const endedAt = isoOrUndef(r.endedAt);
  if (endedAt) out.endedAt = endedAt;
  for (const k of ['conversationId', 'summary', 'error'] as const) {
    const v = str(r[k]);
    if (v) out[k] = v;
  }
  return out;
}

function writeFileAtomicSync(target: string, data: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, target);
}

const slotKey = (routineId: string, slotAt: string) => `${routineId}|${slotAt}`;

/**
 * `now` is a test seam for the retention prune; production uses the wall clock.
 */
export function createRoutinesStore(filePath: string, opts: { now?: () => number } = {}): RoutinesStore {
  const now = opts.now ?? Date.now;
  let routines: Routine[] = [];
  const deletedSeedKeys = new Set<string>();
  const runs = new Map<string, RoutineRun>();
  const bySlot = new Map<string, RoutineRun>();
  let saveTimer: NodeJS.Timeout | null = null;
  let lastPruneMs = 0;

  function indexRun(run: RoutineRun): void {
    const prev = runs.get(run.id);
    if (prev && bySlot.get(slotKey(prev.routineId, prev.slotAt))?.id === prev.id) {
      bySlot.delete(slotKey(prev.routineId, prev.slotAt));
    }
    runs.set(run.id, run);
    bySlot.set(slotKey(run.routineId, run.slotAt), run);
  }

  function dropRun(run: RoutineRun): void {
    runs.delete(run.id);
    if (bySlot.get(slotKey(run.routineId, run.slotAt))?.id === run.id) bySlot.delete(slotKey(run.routineId, run.slotAt));
  }

  /** Ended runs past retention go; a live run is kept however old, the scheduler still has to settle it. */
  function prune(): boolean {
    const cutoff = now() - RUNS_RETENTION_DAYS * DAY_MS;
    let changed = false;
    for (const run of [...runs.values()]) {
      if (run.endedAt && Date.parse(run.slotAt) < cutoff) { dropRun(run); changed = true; }
    }
    lastPruneMs = now();
    return changed;
  }

  function load(): void {
    let raw: any = null;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') console.error('[agentsflow][routines] could not read routines.json, starting empty', err);
    }
    for (const k of Array.isArray(raw?.deletedSeedKeys) ? raw.deletedSeedKeys : []) {
      if (typeof k === 'string' && k) deletedSeedKeys.add(k);
    }
    const ids = new Set<string>();
    for (const r of Array.isArray(raw?.routines) ? raw.routines : []) {
      const clean = sanitizeRoutine(r);
      if (clean && !ids.has(clean.id)) { routines.push(clean); ids.add(clean.id); }
    }
    for (const r of Array.isArray(raw?.runs) ? raw.runs : []) {
      const clean = sanitizeRun(r);
      // Runs of a routine that no longer exists have nothing left to show them.
      if (clean && ids.has(clean.routineId)) indexRun(clean);
    }
    if (prune()) scheduleSave();
  }

  function serialize(): string {
    const shape: FileShape = { version: FILE_VERSION, routines, runs: [...runs.values()], deletedSeedKeys: [...deletedSeedKeys] };
    return JSON.stringify(shape, null, 2);
  }

  function flushSync(): void {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      writeFileAtomicSync(filePath, serialize());
    } catch (err) {
      console.error('[agentsflow][routines] save failed', err);
    }
  }

  function scheduleSave(): void {
    // The daily prune piggybacks on writes: a store nobody writes to has nothing new to prune.
    if (now() - lastPruneMs >= DAY_MS) prune();
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; flushSync(); }, SAVE_DEBOUNCE_MS);
    saveTimer.unref?.();
  }

  const sortRuns = (list: RoutineRun[]) => list.sort((a, b) => (a.slotAt < b.slotAt ? -1 : a.slotAt > b.slotAt ? 1 : 0));

  load();

  return {
    listRoutines: () => [...routines],
    getRoutine: (id) => routines.find((r) => r.id === id) ?? null,
    addRoutine(r) {
      routines = [...routines.filter((x) => x.id !== r.id), r];
      scheduleSave();
      return r;
    },
    updateRoutine(id, patch) {
      const cur = routines.find((r) => r.id === id);
      if (!cur) return null;
      const stamp = new Date(now()).toISOString();
      const next: Routine = { ...cur, ...patch, id: cur.id, updatedAt: stamp };
      // Slots before the resume moment must not exist, or un-pausing would replay the pause as misses.
      if (!cur.enabled && next.enabled) next.enabledAt = stamp;
      routines = routines.map((r) => (r.id === id ? next : r));
      scheduleSave();
      return next;
    },
    removeRoutine(id) {
      const gone = routines.find((r) => r.id === id);
      if (gone?.seedKey) deletedSeedKeys.add(gone.seedKey);
      routines = routines.filter((r) => r.id !== id);
      for (const run of [...runs.values()]) if (run.routineId === id) dropRun(run);
      scheduleSave();
    },
    isSeedDeleted: (seedKey) => deletedSeedKeys.has(seedKey),
    listRuns(o = {}) {
      const list = [...runs.values()].filter((r) =>
        (o.routineId === undefined || r.routineId === o.routineId) &&
        (o.sinceMs === undefined || Date.parse(r.slotAt) >= o.sinceMs));
      return sortRuns(list);
    },
    getRun: (id) => runs.get(id) ?? null,
    findRun: (routineId, slotAt) => bySlot.get(slotKey(routineId, slotAt)) ?? null,
    upsertRun(run) {
      indexRun(run);
      scheduleSave();
      return run;
    },
    snapshot(nowMs) {
      const cutoff = nowMs - RUNS_SNAPSHOT_DAYS * DAY_MS;
      const list = [...runs.values()].filter((r) => !r.endedAt || Date.parse(r.slotAt) >= cutoff);
      return { routines: [...routines], runs: sortRuns(list), now: new Date(nowMs).toISOString() };
    },
    flushSync,
  };
}
