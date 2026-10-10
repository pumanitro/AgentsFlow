import { useEffect, useMemo, useRef, useState } from 'react';
import { cadenceLabel, formatSlot, nextOccurrence } from '../../../shared/routine-schedule';
import { STATUS_LABEL, STATUS_TEXT } from '../../lib/routine-style';
import type { RoutinePreviewProps } from './props';
import { RoutineGlyph, StatusMark } from './marks';

const BTN = 'px-3 py-1 text-[11px] uppercase tracking-wider rounded-md border border-border bg-panel text-muted hover:text-text hover:bg-panel2 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-panel disabled:hover:text-muted';

export default function RoutinePreview(props: RoutinePreviewProps) {
  const { routine, runs, dir, nowMs, busy, highlightRunId, onRunNow, onTogglePaused, onEdit, onDelete, onOpenRun, onClose } = props;
  const [confirming, setConfirming] = useState(false);
  const highlightRef = useRef<HTMLElement | null>(null);

  useEffect(() => { setConfirming(false); }, [routine.id]);
  useEffect(() => {
    // A modal (the edit form) open on top owns Escape.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { highlightRef.current?.scrollIntoView({ block: 'nearest' }); }, [highlightRunId, routine.id]);

  const history = useMemo(
    () => runs.filter((r) => r.routineId === routine.id).sort((a, b) => Date.parse(b.slotAt) - Date.parse(a.slotAt)),
    [runs, routine.id],
  );
  const next = routine.enabled ? nextOccurrence(routine.schedule, nowMs) : null;

  return (
    <aside className="w-80 shrink-0 min-h-0 flex flex-col border-l border-border bg-panel/40" aria-label="Routine details">
      <header className="shrink-0 px-4 py-3 border-b border-border flex items-start gap-2">
        <RoutineGlyph icon={routine.icon} name={routine.name} size={20} className="mt-0.5 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text truncate">{routine.name}</div>
          {dir
            ? <div className="text-xs text-muted truncate">{dir.displayName}</div>
            : <div className="text-xs text-err">Peer not tracked — Edit to pick one</div>}
          <div className="text-xs text-muted">{cadenceLabel(routine.schedule)}</div>
        </div>
        <button onClick={onClose} aria-label="Close details" className="text-muted hover:text-text px-2 py-1 rounded hover:bg-panel2">✕</button>
      </header>

      <div className="shrink-0 px-4 py-3 border-b border-border space-y-3">
        <div className="text-xs text-muted">
          {routine.enabled ? (next ? <>Next run: <span className="text-text">{formatSlot(next)}</span></> : 'Next run: —') : <span className="text-warn">Paused</span>}
        </div>
        {confirming ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-text">Delete routine and its run history?</span>
            <button className={BTN} disabled={busy} onClick={() => { setConfirming(false); onDelete(); }}>Yes</button>
            <button className={BTN} onClick={() => setConfirming(false)}>No</button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <button className={BTN} disabled={busy || !routine.directoryId} onClick={onRunNow}>Run now</button>
            <button className={BTN} disabled={busy} onClick={onTogglePaused}>{routine.enabled ? 'Pause' : 'Resume'}</button>
            <button className={BTN} disabled={busy} onClick={onEdit}>Edit</button>
            <button className={BTN} disabled={busy} onClick={() => setConfirming(true)}>Delete</button>
          </div>
        )}
        {confirming && <div className="text-[11px] text-subtle">Chats started by this routine are kept.</div>}
      </div>

      <div className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wider text-muted">History</div>
      <ul className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        {history.length === 0 && <li className="px-2 py-2 text-xs text-subtle">No runs yet.</li>}
        {history.map((run) => {
          const highlighted = run.id === highlightRunId;
          const detail = run.error ?? run.summary;
          const body = (
            <>
              <span className="shrink-0 text-xs text-text tabular-nums">{formatSlot(run.slotAt)}</span>
              <StatusMark status={run.status} shape="dot" />
              <span className={`shrink-0 text-xs ${STATUS_TEXT[run.status]}`}>{STATUS_LABEL[run.status]}</span>
              {run.trigger !== 'schedule' && (
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-subtle border border-border rounded px-1">{run.trigger}</span>
              )}
              {detail && <span className="min-w-0 flex-1 truncate text-xs text-muted" title={detail}>{detail}</span>}
            </>
          );
          const cls = `w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left ${highlighted ? 'bg-accent/15' : ''}`;
          return (
            <li key={run.id}>
              {run.conversationId ? (
                <button
                  ref={highlighted ? (el) => { highlightRef.current = el; } : undefined}
                  onClick={() => onOpenRun(run)}
                  className={`${cls} hover:bg-panel2`}
                  title="Open this run's chat"
                >{body}</button>
              ) : (
                <div ref={highlighted ? (el) => { highlightRef.current = el; } : undefined} className={cls}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
