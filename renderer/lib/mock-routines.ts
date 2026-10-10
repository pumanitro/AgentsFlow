import type { TrackedDirectory } from '../../shared/types';
import { CATCHUP_WINDOW_MS, type Routine, type RoutineRun, type RoutineSchedule } from '../../shared/routines';

const DAY_MS = 864e5;
const pad2 = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// The browser demo builds its own slots instead of calling
// shared/routine-schedule, so the fixtures stay full while that module is a
// stub and never depend on its correctness.
function mockSlots(s: RoutineSchedule, fromMs: number, toMs: number): number[] {
  const [hh, mm] = s.time.split(':').map(Number);
  const start = new Date(fromMs);
  const anchor = s.anchorDate ? s.anchorDate.split('-').map(Number) : null;
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (day.getTime() >= toMs) break;
    let fires = false;
    switch (s.cadence) {
      case 'daily': fires = true; break;
      case 'every2days': {
        const a = anchor ? Date.UTC(anchor[0], anchor[1] - 1, anchor[2]) : 0;
        const dist = Math.round((Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) - a) / DAY_MS);
        fires = ((dist % 2) + 2) % 2 === 0;
        break;
      }
      case 'weekly': fires = day.getDay() === (s.weekday ?? 1); break;
      case 'monthly': fires = (s.monthDays ?? [1]).includes(day.getDate()); break;
      case 'twiceMonthly': fires = (s.monthDays ?? [1, 15]).includes(day.getDate()); break;
    }
    if (!fires) continue;
    const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm).getTime();
    if (slot >= fromMs && slot < toMs) out.push(slot);
  }
  return out;
}

/**
 * Deterministic routines + 30 days of history for the browser demo
 * (mock-ipc). Every past occurrence has a run: success, every 5th failed,
 * every 11th missed; today's dailies show the live states (attention, running);
 * one manual run yesterday at 15:12.
 */
export function buildMockRoutines(dirs: TrackedDirectory[], nowMs: number): { routines: Routine[]; runs: RoutineRun[] } {
  const createdAt = new Date(nowMs - 45 * DAY_MS).toISOString();
  const dirAt = (i: number) => dirs[i % Math.max(dirs.length, 1)]?.id ?? '';
  const base = (id: string, name: string, dirIdx: number, prompt: string, schedule: RoutineSchedule, icon: Routine['icon']): Routine => ({
    id, name, directoryId: dirAt(dirIdx), provider: 'claude', prompt, schedule, icon,
    enabled: true, createdAt, updatedAt: createdAt, enabledAt: createdAt,
  });
  const routines: Routine[] = [
    { ...base('mock-reddit-daily', 'Reddit daily', 0, '/reddit-daily-routine', { cadence: 'daily', time: '09:00' }, 'reddit'), seedKey: 'reddit-daily' },
    base('mock-inbox-sweep', 'Inbox sweep', 1, 'Sweep the inbox and file what needs an answer', { cadence: 'daily', time: '18:00' }, 'mail'),
    base('mock-changelog', 'Changelog', 0, '/devlog', { cadence: 'every2days', time: '10:00', anchorDate: dayKey(new Date(nowMs - 45 * DAY_MS)) }, 'book'),
    base('mock-weekly-metrics', 'Weekly metrics', 2, 'Summarise last week\'s metrics', { cadence: 'weekly', time: '08:30', weekday: 1 }, 'chart'),
    base('mock-invoice-run', 'Invoice run', 1, 'Prepare the invoices', { cadence: 'twiceMonthly', time: '12:00', monthDays: [1, 15] }, 'coin'),
    base('mock-dependency-audit', 'Dependency audit', 2, 'Audit dependencies for known issues', { cadence: 'monthly', time: '07:00', monthDays: [1] }, 'shield'),
  ];

  const now = new Date(nowMs);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const fromMs = todayStart - 30 * DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString();

  // Every past slot, in time order, so "every 5th / 11th" reads across routines.
  const slots = routines
    .flatMap((r) => mockSlots(r.schedule, fromMs, nowMs).map((ms) => ({ r, ms })))
    .sort((a, b) => a.ms - b.ms || a.r.name.localeCompare(b.r.name));

  const runs: RoutineRun[] = slots.map(({ r, ms }, i) => {
    const n = i + 1;
    const id = `run-${r.id}-${ms}`;
    if (n % 11 === 0) {
      return { id, routineId: r.id, slotAt: iso(ms), trigger: 'schedule', status: 'missed', startedAt: iso(Math.min(ms + CATCHUP_WINDOW_MS, nowMs)), endedAt: iso(Math.min(ms + CATCHUP_WINDOW_MS, nowMs)) };
    }
    const failed = n % 5 === 0;
    return {
      id, routineId: r.id, slotAt: iso(ms), trigger: 'schedule',
      status: failed ? 'failed' : 'success',
      startedAt: iso(ms + 4_000), endedAt: iso(ms + 9 * 60_000),
      conversationId: `mock-conv-${r.id}-${ms}`,
      ...(failed ? { error: 'the chat exited with an error' } : { summary: `${r.name} finished — nothing unusual` }),
    };
  });

  // Today's dailies carry the live states. With two past dailies the first
  // needs attention and the latest is running; with one, it is running.
  const todayDailies = runs.filter((run) => {
    const r = routines.find((x) => x.id === run.routineId);
    return r?.schedule.cadence === 'daily' && Date.parse(run.slotAt) >= todayStart;
  });
  const live = (run: RoutineRun, status: 'attention' | 'running') => {
    run.status = status;
    run.trigger = 'schedule';
    run.conversationId = run.conversationId ?? `mock-conv-${run.routineId}-${Date.parse(run.slotAt)}`;
    delete run.endedAt; delete run.error;
    run.summary = status === 'attention' ? 'Waiting for your approval' : undefined;
  };
  if (todayDailies.length >= 2) live(todayDailies[0], 'attention');
  if (todayDailies.length >= 1) live(todayDailies[todayDailies.length - 1], 'running');

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 15, 12).getTime();
  runs.push({
    id: `run-manual-${yesterday}`, routineId: 'mock-reddit-daily', slotAt: iso(yesterday), trigger: 'manual', status: 'success',
    startedAt: iso(yesterday), endedAt: iso(yesterday + 6 * 60_000), conversationId: `mock-conv-manual-${yesterday}`, summary: 'Ran by hand — 3 replies posted',
  });

  return { routines, runs };
}
