import type { Conversation, TrackedDirectory } from '../shared/types';
import type { Routine, RoutineRun, RoutinesSnapshot } from '../shared/routines';
import type { occurrencesBetween } from '../shared/routine-schedule';

export interface RoutinesStore {
  listRoutines(): Routine[];
  getRoutine(id: string): Routine | null;
  addRoutine(r: Routine): Routine;
  updateRoutine(id: string, patch: Partial<Routine>): Routine | null;   // stamps updatedAt; enabled false→true also stamps enabledAt
  removeRoutine(id: string): void;                                       // also deletes its runs; a seeded routine leaves a tombstone for its seedKey
  isSeedDeleted(seedKey: string): boolean;                               // the owner deleted this seed; ensureSeedRoutines must not bring it back
  listRuns(opts?: { routineId?: string; sinceMs?: number }): RoutineRun[];
  getRun(id: string): RoutineRun | null;
  findRun(routineId: string, slotAt: string): RoutineRun | null;
  upsertRun(run: RoutineRun): RoutineRun;
  snapshot(nowMs: number): RoutinesSnapshot;                             // applies RUNS_SNAPSHOT_DAYS; always includes non-ended runs
  flushSync(): void;
}

export interface RoutineSchedulerDeps {
  store: RoutinesStore;
  now: () => number;
  getDirectories: () => TrackedDirectory[];
  getConversation: (id: string) => Conversation | null;
  /** Start the chat for this run. Resolves with the new conversation id; rejects with a human message (→ run.status 'failed', run.error). */
  spawn: (routine: Routine, run: RoutineRun) => Promise<{ conversationId: string }>;
  /** A run looks finished although the daemon never wrote a terminal state (main.ts has the transcript heuristic). Return a summary to settle it as success, null to keep waiting. Optional. */
  settleQuietRun?: (conv: Conversation, run: RoutineRun) => Promise<{ summary: string } | null>;
  onChange: () => void;                                                  // routines/runs changed → broadcast
  log: (msg: string, detail?: Record<string, unknown>) => void;
  occurrencesBetween?: typeof occurrencesBetween;                        // test seam; default = shared impl
}

export interface RoutineScheduler {
  start(): void;                       // first tick after 10 s, then every SCHEDULER_TICK_MS; idempotent
  stop(): void;
  tick(): Promise<void>;               // one full pass (due slots → dispatch/miss; live runs → status); re-entrancy guarded
  runNow(routineId: string): Promise<RoutineRun>;   // trigger 'manual', slotAt = now; dispatch immediately; rejects if the routine is unknown or its peer is unresolved
}
