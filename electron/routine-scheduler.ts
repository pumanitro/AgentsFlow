import { v4 as uuid } from 'uuid';
import type { RoutineScheduler, RoutineSchedulerDeps } from './routines-api';
import { occurrencesBetween, routineFloorMs } from '../shared/routine-schedule';
import {
  CATCHUP_LOOKBACK_MS,
  CATCHUP_OFF_GRACE_MS,
  RUN_TIMEOUT_MS,
  SCHEDULER_TICK_MS,
  isOnce,
  routineCatchesUp,
  runStatusFromConversation,
  type Routine,
  type RoutineRun,
  type RunTrigger,
} from '../shared/routines';

const FIRST_TICK_DELAY_MS = 10_000;
// A slot dispatched this close to its time is "on schedule"; later than that it is a catch-up.
const ON_TIME_MS = 90_000;
// The conversation row appears a beat after spawn returns; give it a minute before calling it removed.
const CONV_GRACE_MS = 60_000;
const QUIET_MIN_AGE_MS = 2 * 60_000;
const QUIET_TICKS = 3;
const SPAWN_HANG_MS = 2 * 60_000;
// After a restart the poller needs a beat to replace the chat's stale 'failed' state.
const RESTART_GRACE_MS = 60_000;
/** A chat's peersflow MCP server says hello over the bridge within seconds of starting; two minutes of silence means it never came up. */
export const MCP_HELLO_GRACE_MS = 120_000;

/** The daemon's verdict for a worker that died before its session started: nothing ran, so it is safe to start again. */
export const isPreInitCrash = (detail: string | undefined) => /\bbefore init\b/.test(detail || '');

const isLive = (r: RoutineRun) => (r.status === 'running' || r.status === 'attention') && !r.endedAt;

/** Same as the shared helper; kept local too so a routine's floor holds even before that helper is filled in. */
function floorMs(r: Routine): number {
  if (isOnce(r)) return 0;
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
  // runId → when its never-started chat was restarted. One restart per run.
  const restarted = new Map<string, number>();
  // Runs this instance started (a run already in the store at app start may predate
  // the hello protocol), and those already warned about a missing MCP server.
  const dispatchedHere = new Set<string>();
  const mcpWarned = new Set<string>();

  const iso = (ms: number) => new Date(ms).toISOString();

  function write(run: RoutineRun): RoutineRun {
    const prev = store.getRun(run.id);
    store.upsertRun(run);
    deps.onChange();
    // Only the transition into failed/missed counts: a later rewrite of the same
    // failed run (a summary, a late spawn result) must not warn the user twice.
    if ((run.status === 'failed' || run.status === 'missed') && prev?.status !== run.status) {
      deps.onRunEnded?.(run, store.getRoutine(run.routineId));
    }
    return run;
  }

  function endRun(run: RoutineRun, status: 'success' | 'failed', nowMs: number, extra: Partial<RoutineRun>): void {
    quietTicks.delete(run.id);
    restarted.delete(run.id);
    dispatchedHere.delete(run.id);
    mcpWarned.delete(run.id);
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
    dispatchedHere.add(run.id);
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
      // Marked done by hand while the spawn was in flight: keep the mark, just remember the chat.
      if (cur.markedDoneAt) { if (patch.conversationId) write({ ...cur, conversationId: patch.conversationId }); return; }
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
    // A one-off is looked for with no look-back limit: however long the computer
    // was off, its single slot still runs when the app is back.
    const from = isOnce(routine) ? 0 : Math.max(floorMs(routine), nowMs - CATCHUP_LOOKBACK_MS);
    if (from >= nowMs) return;
    const slots = occ(routine.schedule, from, nowMs);
    const due = slots.filter((slot) => !store.findRun(routine.id, slot));
    if (!due.length) return;
    const nowIso = iso(nowMs);
    // Only the routine's latest slot can still run; an unrun slot with a later one after it is missed.
    const newest = slots[slots.length - 1];
    for (const slot of due) if (slot !== newest) missSlot(routine, slot, nowIso);
    if (due[due.length - 1] !== newest) return;
    const age = nowMs - Date.parse(newest);
    // Catch-up on: the newest slot runs however late the app notices it. Off: only inside a short grace.
    if (!routineCatchesUp(routine) && age > CATCHUP_OFF_GRACE_MS) { missSlot(routine, newest, nowIso); return; }
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
    // The chat runs, but its peersflow tools never said hello: warn once, leave the run alone.
    if (run.status === 'running' && dispatchedHere.has(run.id) && !mcpWarned.has(run.id) && !conv.mcpReadyAt
      && s !== 'failed' && s !== 'success' && age > MCP_HELLO_GRACE_MS) {
      mcpWarned.add(run.id);
      deps.onMcpMissing?.(run, store.getRoutine(run.routineId), conv);
    }
    const restartedAt = restarted.get(run.id);
    if (s === 'failed' && restartedAt !== undefined && nowMs - restartedAt < RESTART_GRACE_MS) return;
    if (s === 'failed' && restartedAt === undefined && deps.restartNeverStarted && isPreInitCrash(conv.description)) {
      // e.g. macOS killed the worker mid-exec while two routines started at once. The
      // session never began, so start it again in place (same chat, same prompt).
      restarted.set(run.id, nowMs);
      const ok = await deps.restartNeverStarted(conv).catch(() => false);
      deps.log('restart never-started chat', { runId: run.id, conversationId: conv.id, detail: conv.description, ok });
      if (ok) return;
    }
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
      for (const listed of store.listRuns().filter(isLive)) {
        // Re-read: an earlier await in this loop may have let the user mark this run done.
        const run = store.getRun(listed.id);
        if (!run || !isLive(run)) continue;
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
