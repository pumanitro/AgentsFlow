import { useMemo } from 'react';
import { CADENCES, CADENCE_GROUP_LABEL } from '../../../shared/routines';
import type { Routine, RoutineRun } from '../../../shared/routines';
import { cadenceLabel } from '../../../shared/routine-schedule';
import { CADENCE_COLOR } from '../../lib/routine-style';
import type { RoutinesSidebarProps } from './props';
import { RoutineGlyph, StatusMark } from './marks';

function latestRunByRoutine(runs: RoutineRun[]): Map<string, RoutineRun> {
  const out = new Map<string, RoutineRun>();
  for (const r of runs) {
    const cur = out.get(r.routineId);
    if (!cur || Date.parse(r.slotAt) > Date.parse(cur.slotAt)) out.set(r.routineId, r);
  }
  return out;
}

export default function RoutinesSidebar({ routines, runs, selectedId, onSelect, onNew }: RoutinesSidebarProps) {
  const latest = useMemo(() => latestRunByRoutine(runs), [runs]);
  const groups = useMemo(
    () => CADENCES
      .map((c) => ({ cadence: c, items: routines.filter((r) => r.schedule.cadence === c).sort((a, b) => a.schedule.time.localeCompare(b.schedule.time) || a.name.localeCompare(b.name)) }))
      .filter((g) => g.items.length > 0),
    [routines],
  );

  const renderRow = (r: Routine) => {
    const run = latest.get(r.id);
    const selected = r.id === selectedId;
    return (
      <button
        key={r.id}
        onClick={() => onSelect(r.id)}
        aria-pressed={selected}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left rounded-md ${selected ? 'bg-accent/25 text-text' : 'text-text hover:bg-panel2'} ${r.enabled ? '' : 'opacity-60'}`}
      >
        <RoutineGlyph icon={r.icon} name={r.name} size={16} className="text-muted" />
        <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
        {!r.enabled && <span className="shrink-0 text-[10px] uppercase tracking-wider text-subtle border border-border rounded px-1">paused</span>}
        <span className="shrink-0 text-muted text-xs">{cadenceLabel(r.schedule)}</span>
        {run && <StatusMark status={run.status} shape="dot" title={run.status} />}
      </button>
    );
  };

  return (
    <aside className="w-72 shrink-0 min-h-0 flex flex-col border-r border-border bg-panel/40" aria-label="Routines">
      <div className="flex-1 min-h-0 overflow-y-auto py-2">
        {groups.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted">
            No routines yet. A routine starts a chat for you on a schedule.
          </div>
        ) : groups.map((g) => (
          <section key={g.cadence} className="mb-3">
            <h3
              className="mx-3 mb-1 pt-1 text-[11px] uppercase tracking-wider text-muted"
              style={{ borderTop: `3px solid ${CADENCE_COLOR[g.cadence]}` }}
            >
              {CADENCE_GROUP_LABEL[g.cadence]} ({g.items.length})
            </h3>
            <div className="px-1.5 space-y-0.5">{g.items.map(renderRow)}</div>
          </section>
        ))}
      </div>
      <div className="shrink-0 p-3 border-t border-border">
        <button
          onClick={onNew}
          className="w-full rounded-md border border-border hover:border-accent text-sm text-text py-1.5"
        >+ New routine</button>
      </div>
    </aside>
  );
}
