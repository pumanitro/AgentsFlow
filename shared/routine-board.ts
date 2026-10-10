import { CATCHUP_WINDOW_MS } from './routines';
import type { MarkStatus, Routine, RoutineCadence, RoutineRun } from './routines';
import { addDays, dayKeyStartMs, localDayKey, occurrencesBetween, routineFloorMs } from './routine-schedule';

export interface SlotMark { routine: Routine; slotAt: string; status: MarkStatus; run?: RoutineRun }
export interface DayCells {
  dayKey: string; isToday: boolean; isPast: boolean;
  dailies: SlotMark[]; every2days: SlotMark[]; weekly: SlotMark[]; twiceMonthly: SlotMark[]; monthly: SlotMark[];
  score: { done: number; total: number };   // dailies: success count / dailies due that day
}

// Local-calendar day keys from a start date. Built with the (y, m, d + i)
// constructor so a DST day never shifts a key.
function keysFrom(y: number, m: number, d: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(localDayKey(new Date(y, m, d + i).getTime()));
  return out;
}

/** 7 keys, Monday..Sunday of the week containing anchor (local). */
export function dayKeysOfWeek(anchorMs: number): string[] {
  const a = new Date(anchorMs);
  const sinceMonday = (a.getDay() + 6) % 7;
  return keysFrom(a.getFullYear(), a.getMonth(), a.getDate() - sinceMonday, 7);
}

/** 42 keys, Monday-start, 6 rows, covering the month containing anchor. */
export function dayKeysOfMonthGrid(anchorMs: number): string[] {
  const a = new Date(anchorMs);
  const first = new Date(a.getFullYear(), a.getMonth(), 1);
  const sinceMonday = (first.getDay() + 6) % 7;
  return keysFrom(first.getFullYear(), first.getMonth(), 1 - sinceMonday, 42);
}

/** no run: slot in the future → 'scheduled'; slot in the past → still 'scheduled' while the routine is enabled and now − slot < CATCHUP_WINDOW_MS (pending catch-up), else 'missed'. With a run → run.status. */
export function markStatusFor(run: RoutineRun | undefined, slotMs: number, nowMs: number, enabled: boolean): MarkStatus {
  if (run) return run.status;
  if (slotMs > nowMs) return 'scheduled';
  // A just-passed slot of a live routine is about to be dispatched (or caught
  // up) by the scheduler, so it is not missed yet.
  return enabled && nowMs - slotMs < CATCHUP_WINDOW_MS ? 'scheduled' : 'missed';
}

const BUCKET: Record<RoutineCadence, 'dailies' | 'every2days' | 'weekly' | 'twiceMonthly' | 'monthly'> = {
  daily: 'dailies', every2days: 'every2days', weekly: 'weekly', twiceMonthly: 'twiceMonthly', monthly: 'monthly',
};

// Runs are joined on the slot's instant, not its string, so an ISO written
// with or without milliseconds still matches.
const runKey = (routineId: string, slotAt: string) => `${routineId}|${Date.parse(slotAt)}`;

/** For each dayKey: every occurrence of every routine that day (occurrences start at routineFloorMs — nothing shown from before a routine existed; a paused routine contributes NO scheduled/missed marks but its recorded runs still show) joined with runs by (routineId, slotAt); plus manual runs that day (their slotAt is not an occurrence). Sorted by slot time, then routine name. */
export function buildDayCells(routines: Routine[], runs: RoutineRun[], dayKeys: string[], nowMs: number): DayCells[] {
  const today = localDayKey(nowMs);
  const cells = new Map<string, DayCells>();
  for (const dayKey of dayKeys) {
    cells.set(dayKey, {
      dayKey,
      isToday: dayKey === today,
      isPast: dayKey < today,
      dailies: [], every2days: [], weekly: [], twiceMonthly: [], monthly: [],
      score: { done: 0, total: 0 },
    });
  }
  if (dayKeys.length === 0) return [];

  const sorted = [...dayKeys].sort();
  const windowFrom = dayKeyStartMs(sorted[0]);
  const windowTo = dayKeyStartMs(addDays(sorted[sorted.length - 1], 1));
  const byId = new Map(routines.map((r) => [r.id, r]));
  const runsByKey = new Map<string, RoutineRun>();
  for (const run of runs) runsByKey.set(runKey(run.routineId, run.slotAt), run);
  const used = new Set<string>();

  const place = (routine: Routine, slotAt: string, run: RoutineRun | undefined) => {
    const cell = cells.get(localDayKey(Date.parse(slotAt)));
    if (!cell) return;
    const status = markStatusFor(run, Date.parse(slotAt), nowMs, routine.enabled);
    cell[BUCKET[routine.schedule.cadence]].push({ routine, slotAt, status, run });
  };

  for (const routine of routines) {
    // Paused: no scheduled/missed marks; its recorded runs are added below.
    if (!routine.enabled) continue;
    const from = Math.max(windowFrom, routineFloorMs(routine));
    for (const slotAt of occurrencesBetween(routine.schedule, from, windowTo)) {
      const key = runKey(routine.id, slotAt);
      const run = runsByKey.get(key);
      if (run) used.add(key);
      place(routine, slotAt, run);
    }
  }

  // Every recorded run not matched to an occurrence: manual runs, runs of a
  // paused routine, and runs from before a re-enable moved the floor forward.
  // Runs of a deleted routine have nothing to draw and are dropped.
  for (const run of runs) {
    const key = runKey(run.routineId, run.slotAt);
    if (used.has(key)) continue;
    const routine = byId.get(run.routineId);
    if (!routine) continue;
    used.add(key);
    place(routine, run.slotAt, run);
  }

  for (const cell of cells.values()) {
    for (const bucket of [cell.dailies, cell.every2days, cell.weekly, cell.twiceMonthly, cell.monthly]) {
      bucket.sort((a, b) => Date.parse(a.slotAt) - Date.parse(b.slotAt) || a.routine.name.localeCompare(b.routine.name));
    }
    // The health bar has one segment per daily ROUTINE, so a manual re-run of
    // a daily does not add a second segment; done = routines with a success.
    const ids = new Set(cell.dailies.map((m) => m.routine.id));
    const done = new Set(cell.dailies.filter((m) => m.status === 'success').map((m) => m.routine.id));
    cell.score = { done: done.size, total: ids.size };
  }
  return dayKeys.map((k) => cells.get(k)!);
}
