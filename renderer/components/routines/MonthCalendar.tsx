import { useMemo } from 'react';
import type React from 'react';
import type { BoardProps } from './props';
import type { SlotMark } from '../../../shared/routine-board';
import { buildDayCells, dayKeysOfMonthGrid } from '../../../shared/routine-board';
import { CADENCE_COLOR, STATUS_LABEL } from '../../lib/routine-style';
import { CadenceIcon, MarkTooltip, StatusMark, tooltipLines, useMarkTooltip } from './marks';
import { arrangeMonthCell, overflowLines } from './month-cells';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function hhmm(slotIso: string): string {
  const d = new Date(slotIso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function markLabel(m: SlotMark): string {
  return `${m.routine.name}, ${hhmm(m.slotAt)}, ${STATUS_LABEL[m.status]}`;
}

export default function MonthCalendar({ routines, runs, anchorMs, nowMs, selectedRoutineId, onPickMark }: BoardProps) {
  const { tooltip, bind, close } = useMarkTooltip();

  const cells = useMemo(
    () => buildDayCells(routines, runs, dayKeysOfMonthGrid(anchorMs), nowMs),
    [routines, runs, anchorMs, nowMs],
  );
  // 'YYYY-MM' of the month on show; grid days outside it are dimmed.
  const monthPrefix = useMemo(() => {
    const a = new Date(anchorMs);
    return `${a.getFullYear()}-${String(a.getMonth() + 1).padStart(2, '0')}`;
  }, [anchorMs]);

  const dim = (m: SlotMark) => (selectedRoutineId && m.routine.id !== selectedRoutineId ? 'opacity-40' : '');

  // Tooltip + pick on the same element: bind's onClick stops propagation.
  const markHandlers = (m: SlotMark) => {
    const b = bind(() => tooltipLines(m));
    return { ...b, onClick: (e: React.MouseEvent<HTMLElement>) => { b.onClick(e); onPickMark(m); } };
  };

  return (
    <div className="h-full min-h-[700px] grid grid-rows-[auto_repeat(6,minmax(0,1fr))] grid-cols-7 border-l border-t border-border bg-bg">
      {WEEKDAYS.map((d) => (
        <div key={d} className="px-1.5 py-1 border-r border-b border-border bg-panel text-[11px] uppercase tracking-wider text-muted">{d}</div>
      ))}
      {cells.map((cell) => {
        const layout = arrangeMonthCell(cell);
        const inMonth = cell.dayKey.startsWith(monthPrefix);
        const dayNum = Number(cell.dayKey.slice(8, 10));
        return (
          <div
            key={cell.dayKey}
            className={`min-h-[108px] min-w-0 border-r border-b border-border p-1.5 flex flex-col gap-1 ${cell.isToday ? 'bg-panel2' : 'bg-panel'} ${inMonth ? '' : 'opacity-50'}`}
          >
            <div className="flex">
              <span
                className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full text-[11px] tabular-nums ${cell.isToday ? 'ring-1 ring-accent text-accent font-semibold' : cell.isPast ? 'text-muted' : 'text-text'}`}
              >{dayNum}</span>
            </div>

            {layout.chips.map((m) => (
              <button
                key={`${m.routine.id}-${m.slotAt}`}
                type="button"
                aria-label={markLabel(m)}
                {...markHandlers(m)}
                style={{ borderLeftColor: CADENCE_COLOR[m.routine.schedule.cadence] }}
                className={`w-full min-w-0 flex items-center gap-1 pl-1 pr-1 py-0.5 rounded-r-[3px] border-l-[3px] bg-panel2 hover:bg-border text-left text-[11px] text-text ${dim(m)}`}
              >
                <CadenceIcon cadence={m.routine.schedule.cadence} size={11} className="shrink-0" />
                <span className="flex-1 min-w-0 truncate">{m.routine.name}</span>
                <StatusMark status={m.status} shape="dot" />
              </button>
            ))}
            {layout.overflow.length > 0 && (
              <button
                type="button"
                aria-label={`${layout.overflow.length} more: ${layout.overflow.map((m) => m.routine.name).join(', ')}`}
                {...bind(() => overflowLines(layout.overflow, (m) => `${m.routine.name} · ${hhmm(m.slotAt)} · ${STATUS_LABEL[m.status]}`))}
                className="self-start px-1.5 py-0.5 rounded-[3px] bg-panel2 hover:bg-border text-[10px] text-muted"
              >+{layout.overflow.length}</button>
            )}

            {layout.circles.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                {layout.circles.map((m) => (
                  <button
                    key={`${m.routine.id}-${m.slotAt}`}
                    type="button"
                    aria-label={markLabel(m)}
                    {...markHandlers(m)}
                    className={`p-0.5 -m-0.5 rounded-full ${dim(m)}`}
                  >
                    <StatusMark status={m.status} shape="circle" />
                  </button>
                ))}
              </div>
            )}

            {layout.dailies.length > 0 && (
              <div className="mt-auto flex items-center gap-1.5">
                <div className="flex-1 flex gap-px h-1.5">
                  {layout.dailies.map((m) => (
                    <button
                      key={`${m.routine.id}-${m.slotAt}`}
                      type="button"
                      aria-label={markLabel(m)}
                      {...markHandlers(m)}
                      className={`flex-1 flex h-full min-w-0 ${dim(m)}`}
                    >
                      <StatusMark status={m.status} shape="segment" />
                    </button>
                  ))}
                </div>
                <span
                  className={`text-[10px] tabular-nums leading-none ${layout.scoreIsFuture ? 'text-subtle px-1 border border-dashed border-subtle rounded-[3px]' : 'text-muted'}`}
                >{layout.scoreText}</span>
              </div>
            )}
          </div>
        );
      })}
      <MarkTooltip anchor={tooltip?.anchor ?? null} lines={tooltip?.lines ?? []} onClose={close} />
    </div>
  );
}
