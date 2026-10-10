import { useEffect, useMemo, useState } from 'react';
import { CADENCES, CADENCE_GROUP_LABEL, ROUTINE_ICONS } from '../../../shared/routines';
import type { AgentProvider } from '../../../shared/types';
import type { RoutineCadence, RoutineIcon, RoutineInput, RoutineSchedule } from '../../../shared/routines';
import { localDayKey, validateRoutineInput } from '../../../shared/routine-schedule';
import { CLAUDE_MODELS } from '../../lib/models';
import type { RoutineFormProps } from './props';
import { CadenceIcon, RoutineGlyph } from './marks';

const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

export function defaultIconFor(name: string): RoutineIcon {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ROUTINE_ICONS[h % ROUTINE_ICONS.length];
}

const FIELD = 'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-text focus:outline-none focus:border-accent';
const BTN = 'px-3 py-1 text-[11px] uppercase tracking-wider rounded-md border border-border bg-panel text-muted hover:text-text hover:bg-panel2 disabled:opacity-40';

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wider text-muted mb-1">{label}</label>
      {children}
      {hint && !error && <div className="text-[11px] text-subtle mt-1">{hint}</div>}
      {error && <div className="text-xs text-err mt-1">{error}</div>}
    </div>
  );
}

export default function RoutineForm({ mode, initial, dirs, error, onSubmit, onCancel }: RoutineFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [directoryId, setDirectoryId] = useState(initial?.directoryId || dirs[0]?.id || '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [provider, setProvider] = useState<AgentProvider>(initial?.provider ?? 'claude');
  const [model, setModel] = useState(initial?.model ?? '');
  const [cadence, setCadence] = useState<RoutineCadence>(initial?.schedule.cadence ?? 'daily');
  const [time, setTime] = useState(initial?.schedule.time ?? '09:00');
  const [weekday, setWeekday] = useState(initial?.schedule.weekday ?? 1);
  const [day1, setDay1] = useState(initial?.schedule.monthDays?.[0] ?? 1);
  const [day2, setDay2] = useState(initial?.schedule.monthDays?.[1] ?? 15);
  const [anchorDate] = useState(initial?.schedule.anchorDate ?? localDayKey(Date.now()));
  const [pickedIcon, setPickedIcon] = useState<RoutineIcon | null>(initial?.icon ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const icon = pickedIcon ?? defaultIconFor(name.trim());

  const input = useMemo((): RoutineInput => {
    const schedule: RoutineSchedule = { cadence, time };
    if (cadence === 'weekly') schedule.weekday = weekday;
    if (cadence === 'monthly') schedule.monthDays = [day1];
    if (cadence === 'twiceMonthly') schedule.monthDays = [day1, day2];
    if (cadence === 'every2days') schedule.anchorDate = anchorDate;
    return {
      name: name.trim(), directoryId, prompt: prompt.trim(), schedule, provider,
      model: provider === 'claude' && model ? model : undefined, icon,
    };
  }, [name, directoryId, prompt, cadence, time, weekday, day1, day2, anchorDate, provider, model, icon]);

  const problem = validateRoutineInput(input, dirs);
  // Attach the one-line message to the field it is about (best effort on its wording).
  const lower = (problem ?? '').toLowerCase();
  const at = (...words: string[]) => (touched && problem && words.some((w) => lower.includes(w)) ? problem : null);
  const nameErr = at('name');
  const peerErr = at('director', 'peer');
  const promptErr = at('prompt');
  const schedErr = at('time', 'weekday', 'day', 'schedule', 'anchor');
  const placed = nameErr || peerErr || promptErr || schedErr;
  const shownGeneral = touched && problem && !placed ? problem : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (problem || submitting) return;
    setSubmitting(true);
    try { await onSubmit(input); } finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6" onClick={onCancel}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'create' ? 'New routine' : 'Edit routine'}
        className="w-full max-w-lg max-h-full bg-panel border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        <header className="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between">
          <div className="text-sm font-semibold text-text flex items-center gap-2">
            <RoutineGlyph icon={icon} name={name} size={16} className="text-accent" />
            {mode === 'create' ? 'New routine' : 'Edit routine'}
          </div>
          <button type="button" onClick={onCancel} className="text-muted hover:text-text px-2 py-1 rounded hover:bg-panel2" aria-label="Close form">✕</button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          <Field label="Name" error={nameErr}>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={FIELD} placeholder="Reddit daily" />
          </Field>

          <Field label="Peer" error={peerErr}>
            <select value={directoryId} onChange={(e) => setDirectoryId(e.target.value)} className={FIELD}>
              {directoryId === '' && <option value="">Pick a peer…</option>}
              {dirs.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
            </select>
          </Field>

          <Field label="Prompt" hint="a slash command like /reddit-daily-routine or a plain prompt" error={promptErr}>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className={`${FIELD} font-mono text-xs resize-y`} />
          </Field>

          <div className="flex gap-4">
            <div className="flex-1">
              <Field label="Provider">
                <div className="flex gap-3 text-sm text-text py-1.5">
                  {(['claude', 'codex'] as AgentProvider[]).map((p) => (
                    <label key={p} className="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" name="routine-provider" checked={provider === p} onChange={() => setProvider(p)} className="accent-[#ff7847]" />
                      {p === 'claude' ? 'Claude' : 'Codex'}
                    </label>
                  ))}
                </div>
              </Field>
            </div>
            {provider === 'claude' && (
              <div className="flex-1">
                <Field label="Model">
                  <select value={model} onChange={(e) => setModel(e.target.value)} className={FIELD}>
                    {CLAUDE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </Field>
              </div>
            )}
          </div>

          <Field label="Cadence" error={schedErr}>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-text">
              {CADENCES.map((c) => (
                <label key={c} className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name="routine-cadence" checked={cadence === c} onChange={() => setCadence(c)} className="accent-[#ff7847]" />
                  <CadenceIcon cadence={c} size={12} className="text-muted" />
                  {CADENCE_GROUP_LABEL[c].charAt(0) + CADENCE_GROUP_LABEL[c].slice(1).toLowerCase()}
                </label>
              ))}
            </div>
          </Field>

          <div className="flex flex-wrap gap-4">
            <Field label="Time">
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`${FIELD} w-32`} />
            </Field>
            {cadence === 'weekly' && (
              <Field label="Weekday">
                <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className={`${FIELD} w-40`}>
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{WEEKDAYS[d]}</option>)}
                </select>
              </Field>
            )}
            {(cadence === 'monthly' || cadence === 'twiceMonthly') && (
              <Field label={cadence === 'monthly' ? 'Day of month' : 'Days of month'}>
                <div className="flex items-center gap-2">
                  <select value={day1} onChange={(e) => setDay1(Number(e.target.value))} className={`${FIELD} w-20`} aria-label="Day of month">
                    {MONTH_DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  {cadence === 'twiceMonthly' && (
                    <>
                      <span className="text-muted text-xs">and</span>
                      <select value={day2} onChange={(e) => setDay2(Number(e.target.value))} className={`${FIELD} w-20`} aria-label="Second day of month">
                        {MONTH_DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </>
                  )}
                </div>
              </Field>
            )}
          </div>

          <Field label="Icon">
            <div className="grid grid-cols-8 gap-1.5" role="radiogroup" aria-label="Icon">
              {ROUTINE_ICONS.map((i) => (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={icon === i}
                  aria-label={i}
                  onClick={() => setPickedIcon(i)}
                  className={`h-8 flex items-center justify-center rounded-md border ${icon === i ? 'border-accent bg-accent/25 text-text' : 'border-border text-muted hover:text-text hover:bg-panel2'}`}
                >
                  <RoutineGlyph icon={i} name={name} size={18} />
                </button>
              ))}
            </div>
          </Field>

          {(shownGeneral || error) && (
            <div className="text-xs text-err" role="alert">{error ?? shownGeneral}</div>
          )}
        </div>

        <footer className="shrink-0 px-5 py-3 border-t border-border flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={BTN}>Cancel</button>
          <button
            type="submit"
            disabled={submitting}
            className="px-3 py-1 text-[11px] uppercase tracking-wider rounded-md bg-accent text-bg font-semibold disabled:opacity-50"
          >{mode === 'create' ? 'Create routine' : 'Save'}</button>
        </footer>
      </form>
    </div>
  );
}
