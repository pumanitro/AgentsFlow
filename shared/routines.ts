import type { AgentProvider, Conversation } from './types';

export type RoutineCadence = 'daily' | 'every2days' | 'weekdays' | 'weekly' | 'twiceMonthly' | 'monthly';
export const CADENCES: RoutineCadence[] = ['daily', 'every2days', 'weekdays', 'weekly', 'twiceMonthly', 'monthly'];
export const CADENCE_GROUP_LABEL: Record<RoutineCadence, string> = {
  daily: 'DAILY', every2days: 'EVERY 2 DAYS', weekdays: 'CUSTOM DAYS', weekly: 'WEEKLY', twiceMonthly: 'TWICE A MONTH', monthly: 'MONTHLY',
};

export interface RoutineSchedule {
  cadence: RoutineCadence;
  time: string;            // 'HH:MM' 24 h, LOCAL time
  weekday?: number;        // weekly: 0..6 (0 = Sunday, Date#getDay). Default 1 (Monday)
  weekdays?: number[];     // weekdays: the days it runs on, each 0..6 (0 = Sunday), at least one, distinct, ascending. No default: without it the routine never fires
  monthDays?: number[];    // monthly: [d]; twiceMonthly: [d1, d2]; each 1..28. Defaults [1] / [1, 15]
  anchorDate?: string;     // every2days: 'YYYY-MM-DD' local; fires on days whose calendar-day distance from it is even. Default: createdAt's local date
}

export type RoutineIcon = 'reddit' | 'mail' | 'chart' | 'broom' | 'bug' | 'rocket' | 'book' | 'bell' | 'shield' | 'leaf' | 'coin' | 'star' | 'gear' | 'globe' | 'clock' | 'flask';
export const ROUTINE_ICONS: RoutineIcon[] = ['reddit', 'mail', 'chart', 'broom', 'bug', 'rocket', 'book', 'bell', 'shield', 'leaf', 'coin', 'star', 'gear', 'globe', 'clock', 'flask'];

export interface Routine {
  id: string;
  name: string;
  directoryId: string;        // TrackedDirectory.id. '' = unresolved (a seed whose peer is not tracked); a routine with '' can never be enabled
  provider: AgentProvider;    // 'claude' unless the form says otherwise
  model?: string;             // alias for `claude --model`; undefined = CLI default
  prompt: string;             // the chat's first prompt, verbatim, e.g. '/reddit-daily-routine'
  schedule: RoutineSchedule;
  icon: RoutineIcon;
  enabled: boolean;
  createdAt: string;          // ISO
  updatedAt: string;          // ISO
  enabledAt?: string;         // ISO of the latest false→true flip. Slots earlier than max(createdAt, enabledAt) do not exist
  catchUp?: boolean;          // run a slot late if the app was closed at its time. undefined = true
  seedKey?: string;           // present on app-seeded routines; makes seeding idempotent
}

export type RunStatus = 'running' | 'attention' | 'success' | 'failed' | 'missed';
export type MarkStatus = RunStatus | 'scheduled';
export type RunTrigger = 'schedule' | 'catchup' | 'manual';

export interface RoutineRun {
  id: string;
  routineId: string;
  slotAt: string;             // ISO (UTC) of the slot this run fulfils; a manual run uses the click time. Unique per (routineId, slotAt)
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: string;          // ISO: dispatch time (for 'missed': when the miss was recorded)
  endedAt?: string;           // ISO: set on success / failed / missed
  conversationId?: string;    // the Peers Flow chat this run IS; absent for missed runs and dispatches that died before a row existed
  summary?: string;           // one line (≤ 200 chars): the chat's final description / result
  error?: string;             // failed: why
}

export interface RoutineInput {
  name: string;
  directoryId: string;
  prompt: string;
  schedule: RoutineSchedule;
  provider?: AgentProvider;
  model?: string;
  icon?: RoutineIcon;
  catchUp?: boolean;
}
export type RoutinePatch = Partial<RoutineInput> & { enabled?: boolean };

export interface RoutinesSnapshot {
  routines: Routine[];
  runs: RoutineRun[];   // every run whose slotAt is newer than RUNS_SNAPSHOT_DAYS, plus every non-ended run
  now: string;          // main's clock (ISO) so renderer and main agree on "today"
}

export const ROUTINES_IPC = {
  list: 'routines:list',
  create: 'routines:create',
  update: 'routines:update',
  remove: 'routines:remove',
  runNow: 'routines:runNow',
  updated: 'routines:updated',
} as const;

export const SCHEDULER_TICK_MS = 15_000;
export const CATCHUP_OFF_GRACE_MS = 5 * 60 * 1000;      // catch-up off: a slot noticed later than this is missed, never run
export const CATCHUP_LOOKBACK_MS = 40 * 24 * 60 * 60 * 1000;   // how far back an unrun slot is looked for; longer than a month so a monthly slot is found
export const RUN_TIMEOUT_MS = 6 * 60 * 60 * 1000;       // a run still live after this fails as 'timed out'
export const RUNS_RETENTION_DAYS = 180;                   // runs older than this are pruned from routines.json
export const RUNS_SNAPSHOT_DAYS = 120;                    // runs older than this are not sent to the renderer
export const MAX_RUNNING_PER_ROUTINE = 1;                 // a new slot waits while the previous run is live

/** Catch-up is on unless the routine says otherwise, so files written before the switch existed keep running late slots. */
export function routineCatchesUp(r: Pick<Routine, 'catchUp'>): boolean {
  return r.catchUp !== false;
}

/**
 * The run status a chat's live fields imply. null = no signal yet (starting /
 * idle / unknown): the caller keeps the run's previous status.
 * Mirrors renderer/lib/status.ts (working/busy wins over blocked; terminal last).
 */
export function runStatusFromConversation(c: Pick<Conversation, 'state' | 'status'> | null | undefined): RunStatus | null {
  if (!c) return null;
  const state = (c.state || '').toLowerCase();
  const status = (c.status || '').toLowerCase();
  if (status === 'busy' || status === 'working' || state === 'working' || state === 'active' || state === 'starting') return 'running';
  if (status === 'waiting' || status === 'needs-input' || state === 'blocked' || state === 'needs-input') return 'attention';
  if (state === 'failed' || state === 'error' || status === 'failed' || status === 'error') return 'failed';
  if (state === 'done' || state === 'completed' || status === 'completed') return 'success';
  return null;
}
