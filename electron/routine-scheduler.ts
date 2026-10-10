import { v4 as uuid } from 'uuid';
import type { RoutineScheduler, RoutineSchedulerDeps } from './routines-api';
import { occurrencesBetween, routineFloorMs } from '../shared/routine-schedule';
import {
  CATCHUP_WINDOW_MS,
  RUN_TIMEOUT_MS,
  SCHEDULER_TICK_MS,
  runStatusFromConversation,
  type Routine,
  type RoutineRun,
  type RunTrigger,
} from '../shared/routines';

const FIRST_TICK_DELAY_MS = 10_000;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
// A slot dispatched this close to its time is "on schedule"; later than that it is a catch-up.
const ON_TIME_MS = 90_000;
// The conversation row appears a beat after spawn returns; give it a minute before calling it removed.
const CONV_GRACE_MS = 60_000;
const QUIET_MIN_AGE_MS = 2 * 60_000;
const QUIET_TICKS = 3;
const SPAWN_HANG_MS = 2 * 60_000;

const isLive = (r: RoutineRun) => (r.status === 'running' || r.status === 'attention') && !r.endedAt;

/** Same as the shared helper; kept local too so a routine's floor holds even before that helper is filled in. */
function floorMs(r: Routine): number {
  const own = Math.max(Date.parse(r.createdAt) || 0, r.enabledAt ? Date.parse(r.enabledAt) || 0 : 0);
  return Math.max(own, routineFloorMs(r));
}

export function createRoutineScheduler(deps: RoutineSchedulerDeps): RoutineScheduler {
  const { store } = deps;
  const occ = deps.occurrencesBetween ?? occurrencesBetween;
  let firstTimer: NodeJS.Timeout | null = null;
  let interval: NodeJS.Timeout | null = null;
  let ticking = false;
  // runId → consecutive ticks the chat sat in state 'working' with no busy daemon.
  const quietTicks = new Map<string, number>();
  const settling = new Set<string>();

  const iso = (ms: number) => new Date(ms).toISOString();

  function write(run: RoutineRun): RoutineRun {
    store.upsertRun(run);
    deps.onChange();
    return run;
  }

  function endRun(run: RoutineRun, status: 'success' | 'failed', nowMs: number, extra: Partial<RoutineRun>): void {
    quietTicks.delete(run.id);
    write({ ...run, ...extra, status, endedAt: iso(nowMs) });
    deps.log('run ended', { routineId: run.routineId, runId: run.id, status, error: extra.error });
  }

  /**
   * The run row is written BEFORE spawn is awaited, so the next tick sees the slot
   * taken and cannot fire it twice. Returns the run as first written plus the
   * spawn's settlement for callers that want to wait for it.
   */
  function dispatch(routine: Routine, slotAt: string, trigger: RunTrigger, nowMs: number): { run: RoutineRun; done: Promise<void> } {
    const run: RoutineRun = { id: uuid(), routineId: routine.id, slotAt, trigger, status: 'running', startedAt: iso(nowMs) };
    write(run);
    deps.log('dispatch', { routineId: routine.id, routine: routine.name, slotAt, trigger, runId: run.id });
    const done = (async () => {
      let patch: Partial<RoutineRun>;
      try {
        const { conversationId } = await deps.spawn(routine, run);
        patch = { conversationId };
      } catch (err: any) {
        const error = String(err?.message ?? err ?? 'spawn failed').slice(0, 200) || 'spawn failed';
        patch = { status: 'failed', error, endedAt: iso(deps.now()) };
        deps.log('spawn failed', { routineId: routine.id, runId: run.id, error });
      }
      // The routine (and its runs) may have been deleted while the spawn was in flight.
      const cur = store.getRun(run.id);
      if (!cur || !store.getRoutine(routine.id)) return;
      if (patch.conversationId && cur.status === 'failed' && cur.error === 'spawn did not return') {
        // A slow spawn that the hang check gave up on came back after all: the chat exists, track it.
        write({ ...cur, ...patch, status: 'running', endedAt: undefined, error: undefined });
      } else {
        write({ ...cur, ...patch });
      }
    })();
    return { run, done };
  }

  function missSlot(routine: Routine, slotAt: string, nowIso: string): void {
    write({ id: uuid(), routineId: routine.id, slotAt, trigger: 'schedule', status: 'missed', startedAt: nowIso, endedAt: nowIso });
    deps.log('missed', { routineId: routine.id, slotAt });
  }

  function planRoutine(routine: Routine, nowMs: number, dirIds: Set<string>, pending: Promise<void>[]): void {
    // A paused or peer-less routine records nothing: no runs, and no missed marks either.
    if (!routine.enabled || !routine.directoryId || !dirIds.has(routine.directoryId)) return;
    const from = Math.max(floorMs(routine), nowMs - LOOKBACK_MS);
    if (from >= nowMs) return;
    const due = occ(routine.schedule, from, nowMs).filter((slot) => !store.findRun(routine.id, slot));
    if (!due.length) return;
    const nowIso = iso(nowMs);
    const newest = due[due.length - 1];
    for (const slot of due.slice(0, -1)) missSlot(routine, slot, nowIso);
    const age = nowMs - Date.parse(newest);
    if (age > CATCHUP_WINDOW_MS) { missSlot(routine, newest, nowIso); return; }
    // One run at a time per routine: the newest slot waits for the live one and is re-checked next tick.
    if (store.listRuns({ routineId: routine.id }).some(isLive)) return;
    pending.push(dispatch(routine, newest, age < ON_TIME_MS ? 'schedule' : 'catchup', nowMs).done);
  }

  async function trackRun(run: RoutineRun, nowMs: number): Promise<void> {
    const age = nowMs - Date.parse(run.startedAt);
    if (!run.conversationId) {
      if (run.status === 'running' && age > SPAWN_HANG_MS) endRun(run, 'failed', nowMs, { error: 'spawn did not return' });
      return;
    }
    const conv = deps.getConversation(run.conversationId);
    if (!conv) {
      if (age > CONV_GRACE_MS) endRun(run, 'failed', nowMs, { error: 'chat was removed' });
      return;
    }
    const s = runStatusFromConversation(conv);
    if (s === 'success' || s === 'failed') {
      const summary = (conv.lastResult || conv.description || '').trim().slice(0, 200);
      endRun(run, s, nowMs, {
        ...(summary ? { summary } : {}),
        ...(s === 'failed' ? { error: summary || 'chat failed' } : {}),
      });
      return;
    }
    if (age > RUN_TIMEOUT_MS) { endRun(run, 'failed', nowMs, { error: 'timed out after 6 h' }); return; }
    if ((s === 'running' || s === 'attention') && s !== run.status) {
      run = write({ ...run, status: s });
    }
    // The daemon sometimes never writes a terminal state; after three quiet ticks ask main's transcript heuristic.
    const quiet = (conv.state || '').toLowerCase() === 'working' && (conv.status || '').toLowerCase() !== 'busy';
    if (!deps.settleQuietRun || !quiet || age <= QUIET_MIN_AGE_MS) { quietTicks.delete(run.id); return; }
    const n = (quietTicks.get(run.id) ?? 0) + 1;
    quietTicks.set(run.id, n);
    if (n < QUIET_TICKS || settling.has(run.id)) return;
    settling.add(run.id);
    try {
      const res = await deps.settleQuietRun(conv, run);
      const cur = store.getRun(run.id);
      if (res && cur && isLive(cur)) endRun(cur, 'success', deps.now(), { summary: res.summary.trim().slice(0, 200) });
      else quietTicks.set(run.id, 0);
    } catch (err: any) {
      deps.log('settleQuietRun failed', { runId: run.id, error: String(err?.message ?? err) });
      quietTicks.set(run.id, 0);
    } finally {
      settling.delete(run.id);
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const nowMs = deps.now();
      // Settle live runs first so a run that just finished frees its routine for this tick's slot.
      for (const run of store.listRuns().filter(isLive)) {
        try { await trackRun(run, nowMs); }
        catch (err: any) { deps.log('track failed', { runId: run.id, error: String(err?.message ?? err) }); }
      }
      const dirIds = new Set(deps.getDirectories().map((d) => d.id));
      const pending: Promise<void>[] = [];
      for (const routine of store.listRoutines()) {
        try { planRoutine(routine, nowMs, dirIds, pending); }
        catch (err: any) { deps.log('plan failed', { routineId: routine.id, error: String(err?.message ?? err) }); }
      }
      await Promise.allSettled(pending);
    } finally {
      ticking = false;
    }
  }

  const safeTick = () => { tick().catch((err) => deps.log('tick failed', { error: String(err?.message ?? err) })); };

  return {
    start() {
      if (firstTimer || interval) return;
      firstTimer = setTimeout(() => {
        firstTimer = null;
        safeTick();
        interval = setInterval(safeTick, SCHEDULER_TICK_MS);
      }, FIRST_TICK_DELAY_MS);
    },
    stop() {
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
      if (interval) { clearInterval(interval); interval = null; }
    },
    tick,
    async runNow(routineId) {
      const routine = store.getRoutine(routineId);
      if (!routine) throw new Error('routine not found');
      if (!routine.directoryId || !deps.getDirectories().some((d) => d.id === routine.directoryId)) {
        throw new Error('peer not found — edit the routine and pick a directory');
      }
      const nowMs = deps.now();
      return dispatch(routine, iso(nowMs), 'manual', nowMs).run;
    },
  };
}
