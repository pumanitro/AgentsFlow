import type { Routine, RoutineCadence } from '../../../shared/routines';
import type { DayCells, SlotMark } from '../../../shared/routine-board';

// Pure placement for the week lanes board: which lanes exist and which marks
// sit in each lane on each day. No React here so a test can target it.

export type WeekLaneId = 'daily' | 'every2days' | 'weekly' | 'monthly';

export interface WeekLane {
  id: WeekLaneId;
  label: string;
  cadence: RoutineCadence;    // the hue + icon of the lane header
  cells: SlotMark[][];        // one entry per day column, in dayKeys order
}

const LANES: { id: WeekLaneId; label: string; cadence: RoutineCadence; cadences: RoutineCadence[] }[] = [
  { id: 'daily', label: 'DAILY', cadence: 'daily', cadences: ['daily'] },
  { id: 'every2days', label: 'EVERY 2 DAYS', cadence: 'every2days', cadences: ['every2days'] },
  { id: 'weekly', label: 'WEEKLY', cadence: 'weekly', cadences: ['weekly'] },
  { id: 'monthly', label: 'MONTHLY & TWICE A MONTH', cadence: 'monthly', cadences: ['twiceMonthly', 'monthly'] },
];

function bySlotThenName(a: SlotMark, b: SlotMark): number {
  if (a.slotAt !== b.slotAt) return a.slotAt < b.slotAt ? -1 : 1;
  return a.routine.name.localeCompare(b.routine.name);
}

function marksOf(day: DayCells, cadences: RoutineCadence[]): SlotMark[] {
  const out: SlotMark[] = [];
  for (const c of cadences) {
    if (c === 'daily') out.push(...day.dailies);
    else if (c === 'every2days') out.push(...day.every2days);
    else if (c === 'weekly') out.push(...day.weekly);
    else if (c === 'twiceMonthly') out.push(...day.twiceMonthly);
    else out.push(...day.monthly);
  }
  return cadences.length > 1 ? out.sort(bySlotThenName) : out;
}

/** DAILY always; every other lane only when a routine of its cadence exists. */
export function weekLanes(routines: Routine[], days: DayCells[]): WeekLane[] {
  const present = new Set(routines.map((r) => r.schedule.cadence));
  return LANES
    .filter((l) => l.id === 'daily' || l.cadences.some((c) => present.has(c)))
    .map((l) => ({ id: l.id, label: l.label, cadence: l.cadence, cells: days.map((d) => marksOf(d, l.cadences)) }));
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Column header parts for a local 'YYYY-MM-DD' key. */
export function dayHeader(dayKey: string): { weekday: string; day: number } {
  const [y, m, d] = dayKey.split('-').map(Number);
  return { weekday: WEEKDAY_SHORT[new Date(y, m - 1, d).getDay()], day: d };
}

/** Local 'HH:MM' of a slot. */
export function slotTime(slotAt: string): string {
  const t = new Date(slotAt);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

/** Stable React key for a mark. */
export function markKey(m: SlotMark): string {
  return `${m.routine.id}@${m.slotAt}`;
}
