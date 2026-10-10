import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RoutinesViewProps } from './props';
import type { RoutineInput, RoutineRun } from '../../../shared/routines';
import type { SlotMark } from '../../../shared/routine-board';
import { api } from '../../lib/ipc';
import { PILL } from '../../lib/routine-style';
import { errorMessage, rangeLabel, shiftAnchor, useRoutines } from '../../lib/use-routines';
import { useRoutinesUIState } from '../../lib/routines-ui-state';
import RoutinesSidebar from './RoutinesSidebar';
import RoutinePreview from './RoutinePreview';
import RoutineForm from './RoutineForm';
import WeekBoard from './WeekBoard';
import MonthCalendar from './MonthCalendar';

const TOAST_MS = 6_000;

const NAV_BTN = 'px-2 py-1 rounded-md border border-border bg-panel text-[12px] text-muted hover:text-text hover:bg-panel2';

/**
 * The Routines screen: cadence sidebar · Week / Month board · preview panel.
 * Owns selection, range, anchor, the form modal and every mutation; the
 * children are pure renderers of `./props`.
 */
export default function RoutinesView({ dirs, onOpenConversation }: RoutinesViewProps) {
  const { routines, runs, nowMs, loading, error: loadError } = useRoutines();
  const [range, setRange] = useRoutinesUIState('range');
  const [storedAnchor, setAnchor] = useRoutinesUIState('anchorMs');
  const [selectedId, setSelectedId] = useRoutinesUIState('selectedRoutineId');
  const [highlightRunId, setHighlightRunId] = useState<string | null>(null);
  const [form, setForm] = useState<null | 'create' | 'edit'>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const anchorMs = storedAnchor ?? nowMs;
  const selected = useMemo(() => routines.find((r) => r.id === selectedId) ?? null, [routines, selectedId]);
  const selectedRuns = useMemo(() => (selected ? runs.filter((r) => r.routineId === selected.id) : []), [runs, selected]);

  // A remembered selection whose routine is gone (deleted elsewhere) is dropped
  // once the first snapshot has landed — never while still loading.
  useEffect(() => {
    if (!loading && selectedId && !selected) setSelectedId(null);
  }, [loading, selectedId, selected, setSelectedId]);

  const showToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const select = useCallback((id: string | null, runId: string | null = null) => {
    setSelectedId(id);
    setHighlightRunId(runId);
  }, [setSelectedId]);

  const closeForm = useCallback(() => { setForm(null); setFormError(null); }, []);

  // Escape peels one layer: the form first, then the preview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (form) { e.preventDefault(); closeForm(); return; }
      if (selectedId) { e.preventDefault(); select(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [form, selectedId, closeForm, select]);

  // Runs one mutation at a time; a failure lands in the toast.
  const act = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      showToast(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [showToast]);

  const onRunNow = useCallback(async () => {
    if (!selected) return;
    const run = await act(() => api().runRoutineNow(selected.id));
    if (run) setHighlightRunId(run.id);
  }, [selected, act]);

  const onTogglePaused = useCallback(() => {
    if (!selected) return;
    void act(() => api().updateRoutine(selected.id, { enabled: !selected.enabled }));
  }, [selected, act]);

  const onDelete = useCallback(async () => {
    if (!selected) return;
    const id = selected.id;
    const ok = await act(async () => { await api().removeRoutine(id); return true; });
    if (ok) select(null);
  }, [selected, act, select]);

  const onSubmit = useCallback(async (input: RoutineInput) => {
    setFormError(null);
    try {
      if (form === 'edit' && selected) {
        await api().updateRoutine(selected.id, input);
      } else {
        const created = await api().createRoutine(input);
        select(created.id);
      }
      closeForm();
    } catch (e) {
      // The form stays open with main's validation message.
      setFormError(errorMessage(e));
    }
  }, [form, selected, select, closeForm]);

  const onPickMark = useCallback((mark: SlotMark) => {
    select(mark.routine.id, mark.run?.id ?? null);
  }, [select]);

  const onOpenRun = useCallback((run: RoutineRun) => {
    if (run.conversationId) onOpenConversation(run.conversationId);
  }, [onOpenConversation]);

  const boardProps = {
    routines, runs, anchorMs, nowMs,
    selectedRoutineId: selectedId,
    onPickMark,
  };

  return (
    <div className="h-full flex min-h-0">
      <aside className="w-72 shrink-0 border-r border-border flex flex-col min-h-0">
        <RoutinesSidebar
          routines={routines}
          runs={runs}
          nowMs={nowMs}
          selectedId={selectedId}
          onSelect={(id) => select(id)}
          onNew={() => { setFormError(null); setForm('create'); }}
        />
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div className="px-4 py-2 border-b border-border flex items-center gap-3">
          <div role="tablist" aria-label="Board range" className={PILL.wrap}>
            <button role="tab" aria-selected={range === 'week'} onClick={() => setRange('week')} className={range === 'week' ? PILL.on : PILL.off} title="Seven days, one lane per cadence">Week</button>
            <button role="tab" aria-selected={range === 'month'} onClick={() => setRange('month')} className={range === 'month' ? PILL.on : PILL.off} title="The whole month as a calendar">Month</button>
          </div>
          <div className="flex items-center gap-1">
            <button className={NAV_BTN} onClick={() => setAnchor(shiftAnchor(anchorMs, range, -1))} aria-label={range === 'week' ? 'Previous week' : 'Previous month'} title={range === 'week' ? 'Previous week' : 'Previous month'}>‹</button>
            <button className={NAV_BTN} onClick={() => setAnchor(null)} title="Back to today">Today</button>
            <button className={NAV_BTN} onClick={() => setAnchor(shiftAnchor(anchorMs, range, 1))} aria-label={range === 'week' ? 'Next week' : 'Next month'} title={range === 'week' ? 'Next week' : 'Next month'}>›</button>
          </div>
          <span className="text-sm text-text">{rangeLabel(anchorMs, range)}</span>
          {loading && <span className="text-[11px] text-subtle">Loading…</span>}
        </div>
        {(toast || loadError) && (
          <div role="alert" className="px-4 py-1.5 border-b border-border text-[12px] text-err truncate" title={toast ?? loadError ?? ''}>
            {toast ?? `Could not load routines: ${loadError}`}
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-auto">
          {range === 'week' ? <WeekBoard {...boardProps} /> : <MonthCalendar {...boardProps} />}
        </div>
      </section>

      {selected && (
        <aside className="w-80 shrink-0 border-l border-border flex flex-col min-h-0">
          <RoutinePreview
            routine={selected}
            runs={selectedRuns}
            dir={dirs.find((d) => d.id === selected.directoryId)}
            nowMs={nowMs}
            busy={busy}
            highlightRunId={highlightRunId}
            onRunNow={() => { void onRunNow(); }}
            onTogglePaused={onTogglePaused}
            onEdit={() => { setFormError(null); setForm('edit'); }}
            onDelete={() => { void onDelete(); }}
            onOpenRun={onOpenRun}
            onClose={() => select(null)}
          />
        </aside>
      )}

      {form && (
        <RoutineForm
          mode={form}
          initial={form === 'edit' ? selected ?? undefined : undefined}
          dirs={dirs}
          error={formError}
          onSubmit={onSubmit}
          onCancel={closeForm}
        />
      )}
    </div>
  );
}
