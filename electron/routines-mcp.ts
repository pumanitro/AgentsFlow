/**
 * Routines as seen by an agent: the main-process half of the `*_routine` MCP
 * tools, plus the two rules (create / update) the Routines tab's IPC shares
 * with them so a routine made by an agent and one made in the form can never
 * differ in shape.
 *
 * Dependency-free on purpose (no `electron`): the bridge hands `handleRoutinesOp`
 * the raw tool arguments, everything is validated here, and the tests drive it
 * against a real store on a temp file.
 */
import * as path from 'path';
import type { TrackedDirectory } from '../shared/types';
import {
  CADENCES,
  ROUTINE_ICONS,
  routineCatchesUp,
  type Routine,
  type RoutineCadence,
  type RoutineIcon,
  type RoutineInput,
  type RoutinePatch,
  type RoutineRun,
  type RoutineSchedule,
} from '../shared/routines';
import { cadenceLabel, formatSlot, localDayKey, nextOccurrence, normalizeWeekdays, validateRoutineInput } from '../shared/routine-schedule';
import type { RoutinesStore } from './routines-api';

export type RoutinesOp = 'list' | 'create' | 'update' | 'delete' | 'run';
export const ROUTINES_OPS: RoutinesOp[] = ['list', 'create', 'update', 'delete', 'run'];

type Dirs = TrackedDirectory[];

/** Validate and store a new routine. Throws a one-line human message. */
export function createRoutine(store: RoutinesStore, input: RoutineInput, dirs: Dirs, nowIso: string, id: string): Routine {
  const err = validateRoutineInput(input, dirs, Date.parse(nowIso));
  if (err) throw new Error(err);
  return store.addRoutine({
    id,
    name: input.name.trim(),
    directoryId: input.directoryId,
    provider: input.provider ?? 'claude',
    model: input.model || undefined,
    prompt: input.prompt.trim(),
    schedule: input.schedule,
    icon: input.icon ?? 'star',
    ...(typeof input.catchUp === 'boolean' ? { catchUp: input.catchUp } : {}),
    enabled: true,
    createdAt: nowIso,
    updatedAt: nowIso,
    enabledAt: nowIso,
  });
}

/** Validate and apply a patch. Throws a one-line human message. */
export function patchRoutine(store: RoutinesStore, id: string, patch: RoutinePatch, dirs: Dirs, nowMs?: number): Routine {
  const cur = store.getRoutine(id);
  if (!cur) throw new Error('routine not found');
  const merged = { ...cur, ...patch };
  if (merged.enabled && !merged.directoryId) throw new Error('pick a directory before enabling');
  if (patch.catchUp !== undefined && typeof patch.catchUp !== 'boolean') throw new Error('catch-up must be on or off');
  // Only a moved one-off is held to "not in the past"; an untouched one whose day went by can still be renamed or paused.
  const moved = patch.schedule && (patch.schedule.cadence !== cur.schedule.cadence || patch.schedule.date !== cur.schedule.date || patch.schedule.time !== cur.schedule.time);
  const err = validateRoutineInput(merged, dirs, moved ? nowMs : undefined);
  // A plain pause of a routine whose peer has since gone must still succeed.
  if (err && (merged.enabled || patch.schedule || patch.name !== undefined || patch.prompt !== undefined)) throw new Error(err);
  return store.updateRoutine(id, patch)!;
}

// ---- tool arguments → routine fields ----

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SCHEDULE_KEYS = ['cadence', 'time', 'weekday', 'weekdays', 'month_days', 'start_date', 'date'] as const;

type Args = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function parseWeekday(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  const i = WEEKDAYS.findIndex((d) => d === s || (s.length >= 3 && d.startsWith(s)));
  if (i < 0) throw new Error('weekday must be a day name (e.g. "monday") or 0–6 with 0 = Sunday');
  return i;
}

/** `weekdays`: an array (or a comma-separated string) of day names / 0–6, returned distinct and ascending. */
function parseWeekdays(v: unknown): number[] {
  const list = typeof v === 'string' ? v.split(',').filter((s) => s.trim()) : v;
  if (!Array.isArray(list)) throw new Error('weekdays must be an array of day names (e.g. ["monday", "wednesday", "friday"]) or numbers 0–6 with 0 = Sunday');
  if (list.length === 0) throw new Error('weekdays must list at least one day');
  const days = list.map((d) => {
    let n = NaN;
    try { if (typeof d === 'string' || typeof d === 'number') n = parseWeekday(d); } catch { /* reported below, naming the entry */ }
    if (!(Number.isInteger(n) && n >= 0 && n <= 6)) throw new Error(`weekdays: ${JSON.stringify(d)} is not a day — use a day name (e.g. "monday") or 0–6 with 0 = Sunday`);
    return n;
  });
  return normalizeWeekdays(days);
}

/**
 * The schedule the flat tool arguments describe, laid over `base` (the
 * routine's current schedule on an update). Only the fields the cadence uses
 * survive, so switching weekly → daily does not leave a stray weekday behind.
 */
export function scheduleFromArgs(args: Args, base: RoutineSchedule | null, nowMs: number): RoutineSchedule {
  const cadence = (args.cadence ?? base?.cadence ?? 'daily') as RoutineCadence;
  if (!CADENCES.includes(cadence)) throw new Error(`cadence must be one of: ${CADENCES.join(', ')}`);
  const time = str(args.time) ?? base?.time;
  if (!time) throw new Error('`time` is required (HH:MM, 24 h, local time)');
  const kept = base && base.cadence === cadence ? base : null;
  if (args.weekdays !== undefined && cadence !== 'weekdays') {
    throw new Error(`\`weekdays\` only goes with cadence "weekdays", not "${cadence}" — pass cadence: "weekdays"${cadence === 'weekly' ? ', or use `weekday` for one day a week' : ''}`);
  }
  if (args.date !== undefined && cadence !== 'once') {
    throw new Error(`\`date\` only goes with cadence "once", not "${cadence}" — pass cadence: "once" for a routine that runs a single time`);
  }
  const out: RoutineSchedule = { cadence, time };
  if (cadence === 'once') {
    const date = str(args.date) ?? kept?.date;
    if (!date) throw new Error('`date` is required for cadence "once": the day it runs, "YYYY-MM-DD" (local)');
    out.date = date;
  } else if (cadence === 'weekdays') {
    const days = args.weekdays !== undefined ? parseWeekdays(args.weekdays) : kept?.weekdays;
    if (!days?.length) throw new Error('`weekdays` is required for cadence "weekdays": the days it runs on, e.g. ["monday", "wednesday", "friday"]');
    out.weekdays = days;
  } else if (cadence === 'weekly') {
    const w = args.weekday !== undefined ? parseWeekday(args.weekday) : kept?.weekday;
    if (w !== undefined) out.weekday = w;
  } else if (cadence === 'monthly' || cadence === 'twiceMonthly') {
    if (args.month_days !== undefined && !Array.isArray(args.month_days)) throw new Error('month_days must be an array of day numbers (1–28)');
    const days = (args.month_days as number[] | undefined) ?? kept?.monthDays;
    if (days) out.monthDays = days;
  } else if (cadence === 'every2days') {
    out.anchorDate = str(args.start_date) ?? kept?.anchorDate ?? localDayKey(nowMs);
  }
  return out;
}

function resolveDirectory(token: string, dirs: Dirs): TrackedDirectory | null {
  const lower = token.toLowerCase();
  return (
    dirs.find((d) => d.id === token) ||
    dirs.find((d) => d.path === token) ||
    dirs.find((d) => d.displayName.toLowerCase() === lower) ||
    dirs.find((d) => path.basename(d.path).toLowerCase() === lower) ||
    null
  );
}

function optionalFields(args: Args): Pick<RoutineInput, 'provider' | 'model' | 'icon' | 'catchUp'> {
  const out: Pick<RoutineInput, 'provider' | 'model' | 'icon' | 'catchUp'> = {};
  if (args.provider !== undefined) {
    if (args.provider !== 'claude' && args.provider !== 'codex') throw new Error('provider must be "claude" or "codex"');
    out.provider = args.provider;
  }
  if (args.model !== undefined) out.model = str(args.model);
  if (args.icon !== undefined) {
    if (!ROUTINE_ICONS.includes(args.icon as RoutineIcon)) throw new Error(`icon must be one of: ${ROUTINE_ICONS.join(', ')}`);
    out.icon = args.icon as RoutineIcon;
  }
  if (args.catch_up !== undefined) {
    if (typeof args.catch_up !== 'boolean') throw new Error('catch_up must be true or false');
    out.catchUp = args.catch_up;
  }
  return out;
}

// ---- the bridge handler ----

export interface RoutinesToolDeps {
  store: RoutinesStore;
  getDirectories: () => Dirs;
  /** The directory of the conversation that called the tool: the default peer for a new routine. */
  callerDirectoryId: () => string | null;
  runNow: (routineId: string) => Promise<RoutineRun>;
  now: () => number;
  newId: () => string;
  onChange: () => void;   // routines changed → broadcast to the Routines tab
}

/** A routine the way a tool result shows it: names instead of ids, the schedule in words, when it runs next. */
function describeRoutine(r: Routine, deps: RoutinesToolDeps): Record<string, unknown> {
  const dir = deps.getDirectories().find((d) => d.id === r.directoryId);
  const next = r.enabled ? nextOccurrence(r.schedule, deps.now()) : null;
  const last = deps.store.listRuns({ routineId: r.id }).sort((a, b) => b.slotAt.localeCompare(a.slotAt))[0];
  return {
    id: r.id,
    name: r.name,
    peer: dir?.displayName ?? null,
    peerPath: dir?.path ?? null,
    prompt: r.prompt,
    provider: r.provider,
    model: r.model ?? null,
    icon: r.icon,
    cadence: r.schedule.cadence,
    ...(r.schedule.cadence === 'weekdays' ? { weekdays: normalizeWeekdays(r.schedule.weekdays).map((d) => WEEKDAYS[d]) } : {}),
    ...(r.schedule.cadence === 'once' ? { date: r.schedule.date ?? null } : {}),
    schedule: cadenceLabel(r.schedule),
    enabled: r.enabled,
    catchUp: routineCatchesUp(r),
    nextRun: next ? formatSlot(next) : null,
    nextRunAt: next,
    lastRun: last ? { status: last.status, at: last.slotAt, summary: last.summary ?? last.error ?? null, conversationId: last.conversationId ?? null } : null,
  };
}

function findRoutine(token: unknown, store: RoutinesStore): Routine {
  const t = str(token);
  if (!t) throw new Error('`routine` is required (its id or name, as shown by list_routines)');
  const all = store.listRoutines();
  const byId = all.find((r) => r.id === t);
  if (byId) return byId;
  const named = all.filter((r) => r.name.toLowerCase() === t.toLowerCase());
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new Error(`${named.length} routines are named "${t}" — pass the id instead: ${named.map((r) => r.id).join(', ')}`);
  throw new Error(`no routine "${t}". Known: ${all.map((r) => r.name).join(', ') || '(none)'}`);
}

/** One `*_routine` tool call. Never throws: a bad argument becomes a failure envelope the calling model can read. */
export async function handleRoutinesOp(op: string, rawArgs: unknown, deps: RoutinesToolDeps): Promise<Record<string, unknown>> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Args;
  const { store } = deps;
  try {
    switch (op) {
      case 'list': {
        const routines = store.listRoutines().map((r) => describeRoutine(r, deps));
        return { status: 'success', count: routines.length, routines };
      }
      case 'create': {
        const dirs = deps.getDirectories();
        const token = str(args.directory);
        const dir = token ? resolveDirectory(token, dirs) : dirs.find((d) => d.id === deps.callerDirectoryId()) ?? null;
        if (!dir) {
          return { status: 'failure', error: token ? `Unknown peer "${token}". Call list_peers to see valid peers.` : '`directory` is required (this session has no peer of its own to default to).', known: dirs.map((d) => d.displayName) };
        }
        const input: RoutineInput = {
          name: str(args.name) ?? '',
          directoryId: dir.id,
          prompt: str(args.prompt) ?? '',
          schedule: scheduleFromArgs(args, null, deps.now()),
          ...optionalFields(args),
        };
        let routine = createRoutine(store, input, dirs, new Date(deps.now()).toISOString(), deps.newId());
        if (args.enabled === false) routine = patchRoutine(store, routine.id, { enabled: false }, dirs);
        deps.onChange();
        return { status: 'success', routine: describeRoutine(routine, deps) };
      }
      case 'update': {
        const cur = findRoutine(args.routine, store);
        const dirs = deps.getDirectories();
        const patch: RoutinePatch = { ...optionalFields(args) };
        if (args.name !== undefined) patch.name = str(args.name) ?? '';
        if (args.prompt !== undefined) patch.prompt = str(args.prompt) ?? '';
        if (args.directory !== undefined) {
          const dir = resolveDirectory(str(args.directory) ?? '', dirs);
          if (!dir) return { status: 'failure', error: `Unknown peer "${String(args.directory)}". Call list_peers to see valid peers.`, known: dirs.map((d) => d.displayName) };
          patch.directoryId = dir.id;
        }
        if (SCHEDULE_KEYS.some((k) => args[k] !== undefined)) patch.schedule = scheduleFromArgs(args, cur.schedule, deps.now());
        if (args.enabled !== undefined) {
          if (typeof args.enabled !== 'boolean') throw new Error('enabled must be true or false');
          patch.enabled = args.enabled;
        }
        if (Object.keys(patch).length === 0) throw new Error('nothing to change — pass at least one field besides `routine`');
        const routine = patchRoutine(store, cur.id, patch, dirs, deps.now());
        deps.onChange();
        return { status: 'success', routine: describeRoutine(routine, deps) };
      }
      case 'delete': {
        const cur = findRoutine(args.routine, store);
        store.removeRoutine(cur.id);
        deps.onChange();
        return { status: 'success', deleted: { id: cur.id, name: cur.name } };
      }
      case 'run': {
        const cur = findRoutine(args.routine, store);
        const run = await deps.runNow(cur.id);
        return { status: run.status === 'failed' ? 'failure' : 'success', routine: { id: cur.id, name: cur.name }, run: { id: run.id, status: run.status, conversationId: run.conversationId ?? null, error: run.error ?? null } };
      }
      default:
        return { status: 'failure', error: `unknown routines operation "${op}"` };
    }
  } catch (e) {
    return { status: 'failure', error: (e as Error).message };
  }
}
