import { useMemo } from 'react';
import type React from 'react';
import { buildDayCells, dayKeysOfWeek, type SlotMark } from '../../../shared/routine-board';
import { CADENCE_COLOR, STATUS_LABEL } from '../../lib/routine-style';
import { CadenceIcon, MarkTooltip, RoutineGlyph, StatusMark, tooltipLines, useMarkTooltip } from './marks';
import type { BoardProps } from './props';
import { dayHeader, markKey, slotTime, weekLanes } from './week-lanes';

// The Routines week view: 7 day columns (Mon..Sun), one row per cadence lane,
// no hour grid. Dailies are one segmented bar per day; rarer routines are cards.
export default function WeekBoard({ routines, runs, anchorMs, nowMs, selectedRoutineId, onPickMark }: BoardProps) {
  const days = useMemo(
    () => buildDayCells(routines, runs, dayKeysOfWeek(anchorMs), nowMs),
    [routines, runs, anchorMs, nowMs],
  );
  const lanes = useMemo(() => weekLanes(routines, days), [routines, days]);
  const { tooltip, bind, close } = useMarkTooltip();

  const dim = (m: SlotMark) => (selectedRoutineId && m.routine.id !== selectedRoutineId ? 'opacity-40' : '');
  const markHandlers = (m: SlotMark) => {
    const b = bind(() => tooltipLines(m));
    return { ...b, onClick: (e: React.MouseEvent<HTMLElement>) => { b.onClick(e); onPickMark(m); } };
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="grid grid-cols-7 gap-px sticky top-0 z-10 bg-bg border-b border-border">
        {days.map((d) => {
          const h = dayHeader(d.dayKey);
          return (
            <div
              key={d.dayKey}
              className={`px-2 py-1.5 text-[11px] uppercase tracking-wider ${d.isToday ? 'text-accent font-semibold' : d.isPast ? 'text-subtle' : 'text-muted'}`}
            >
              {d.isToday ? 'TODAY' : h.weekday} <span className="tabular-nums">{h.day}</span>
            </div>
          );
        })}
      </div>

      {lanes.map((lane) => (
        <section key={lane.id} className="border-b border-border">
          <div
            className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-wider text-muted border-l-[3px]"
            style={{ borderLeftColor: CADENCE_COLOR[lane.cadence] }}
          >
            <span style={{ color: CADENCE_COLOR[lane.cadence] }}><CadenceIcon cadence={lane.cadence} /></span>
            {lane.label}
          </div>
          <div className="grid grid-cols-7 gap-px">
            {lane.cells.map((marks, i) => (
              <div key={days[i].dayKey} className={`min-h-[2.5rem] p-1.5 space-y-1 ${days[i].isToday ? 'bg-panel' : ''}`}>
                {lane.id === 'daily' ? (
                  <div className={`h-2.5 rounded-sm flex gap-px ${marks.length === 0 ? 'bg-panel2' : ''}`}>
                    {marks.map((m) => (
                      <button
                        key={markKey(m)}
                        type="button"
                        aria-label={`${m.routine.name} · ${STATUS_LABEL[m.status]}`}
                        className={`flex-1 h-full flex ${dim(m)}`}
                        {...markHandlers(m)}
                      >
                        <StatusMark status={m.status} shape="segment" />
                      </button>
                    ))}
                  </div>
                ) : (
                  marks.map((m) => (
                    <button
                      key={markKey(m)}
                      type="button"
                      aria-label={`${m.routine.name} · ${slotTime(m.slotAt)} · ${STATUS_LABEL[m.status]}`}
                      className={`w-full flex items-center gap-1.5 rounded-md border border-border bg-panel2 px-2 py-1 text-xs text-left hover:border-muted ${dim(m)}`}
                      {...markHandlers(m)}
                    >
                      <StatusMark status={m.status} shape="dot" />
                      <RoutineGlyph icon={m.routine.icon} name={m.routine.name} size={14} className="text-muted" />
                      <span className="truncate text-text">{m.routine.name}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-subtle">{slotTime(m.slotAt)}</span>
                    </button>
                  ))
                )}
              </div>
            ))}
          </div>
        </section>
      ))}

      <MarkTooltip anchor={tooltip?.anchor ?? null} lines={tooltip?.lines ?? []} onClose={close} />
    </div>
  );
}
