import type { DayCells, SlotMark } from '../../../shared/routine-board';

// Pure per-cell arrangement for the month calendar: which chips show, what
// folds into the "+n" chip, and the dailies score text. No React here.

export const MAX_CHIPS = 3;

export interface MonthCellLayout {
  chips: SlotMark[];       // weekly / twice-monthly / monthly, at most MAX_CHIPS
  overflow: SlotMark[];    // the rest, listed in the "+n" chip's tooltip
  circles: SlotMark[];     // every-2-days marks
  dailies: SlotMark[];     // one health-bar segment each
  scoreText: string;       // 'x/y' for past days and today, 'y' for future days, '' when no dailies
  scoreIsFuture: boolean;  // future days render the score dashed-grey
}

/** Slot time first, then routine name — the same order buildDayCells uses inside one cadence. */
export function bySlotThenName(a: SlotMark, b: SlotMark): number {
  if (a.slotAt !== b.slotAt) return a.slotAt < b.slotAt ? -1 : 1;
  return a.routine.name.localeCompare(b.routine.name);
}

export function arrangeMonthCell(cell: DayCells): MonthCellLayout {
  const all = [...cell.weekly, ...cell.twiceMonthly, ...cell.monthly].sort(bySlotThenName);
  const fold = all.length > MAX_CHIPS;
  const isFuture = !cell.isPast && !cell.isToday;
  const { done, total } = cell.score;
  return {
    chips: fold ? all.slice(0, MAX_CHIPS) : all,
    overflow: fold ? all.slice(MAX_CHIPS) : [],
    circles: cell.every2days,
    dailies: cell.dailies,
    scoreText: total === 0 ? '' : isFuture ? String(total) : `${done}/${total}`,
    scoreIsFuture: isFuture,
  };
}

/** Tooltip lines for the "+n" chip: one line per hidden routine. */
export function overflowLines(overflow: SlotMark[], line: (m: SlotMark) => string): string[] {
  return [`${overflow.length} more`, ...overflow.map(line)];
}
