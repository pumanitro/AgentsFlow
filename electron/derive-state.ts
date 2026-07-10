import type { ClaudeAgentJsonRow, JobState } from './claude-cli';
import type { Conversation } from '../shared/types';

// The live fields a `claude agents --json` row carries for a running session.
// `status` (busy | idle | waiting) reflects the OS process in real time;
// `state` (working | blocked | done | …) is the logical turn state; `waitingFor`
// explains a `waiting` status. All three come straight from the CLI's own view,
// which stays live even after a session is re-opened via `claude --resume` and
// its --bg daemon's state.json freezes on the previous turn.
export type LiveAgentRow = Pick<ClaudeAgentJsonRow, 'state' | 'status' | 'waitingFor'>;

// The conversation fields that identify which `claude agents --json` row (if
// any) belongs to a conversation.
export type ConvIdentity = Pick<Conversation, 'sessionName' | 'daemonShort' | 'sessionId'>;

/**
 * Find the live `claude agents --json` row for a conversation, if it's running.
 *
 * Three handles, in order of specificity:
 *  1. `sessionName` — legacy, matched against the row's `name`.
 *  2. `daemonShort` — the 8-char id of a `--bg` daemon, a prefix of its sessionId.
 *  3. `sessionId` — exact. This is the only handle a *fork* has: it runs as an
 *     interactive `--resume … --fork-session --session-id <new>` process, so it
 *     never gets a daemonShort or a sessionName. Omitting this lookup is what
 *     pinned forked rows to a permanently grey status dot.
 */
export function findLiveRow<R extends ClaudeAgentJsonRow>(c: ConvIdentity, rows: R[]): R | undefined {
  if (c.sessionName) {
    const byName = rows.find((r) => r.name === c.sessionName);
    if (byName) return byName;
  }
  if (c.daemonShort) {
    const byShort = rows.find((r) => r.sessionId.startsWith(c.daemonShort));
    if (byShort) return byShort;
  }
  if (c.sessionId) {
    return rows.find((r) => r.sessionId === c.sessionId);
  }
  return undefined;
}

function isBlocked(job: JobState): boolean {
  if ((job.tempo || '').toLowerCase() === 'blocked') return true;
  if (job.block?.questions && job.block.questions.length > 0) return true;
  if (typeof job.needs === 'string' && job.needs.trim().length > 0) return true;
  return false;
}

export function effectiveState(job: JobState): string | undefined {
  const tempo = (job.tempo || '').toLowerCase();
  const tasks = job.inFlight?.tasks ?? 0;
  // Blocked is authoritative: the daemon sometimes leaves `state: "working"`
  // stale when a turn ends straight on AskUserQuestion, so trust tempo /
  // block.questions / needs instead.
  if (isBlocked(job)) return 'blocked';
  if (tempo === 'active' || tasks > 0) return 'working';
  return job.state;
}

/**
 * Reconcile a live `claude agents --json` row with the daemon's own state.json
 * into a single effective state, preferring the CLI's real-time view.
 *
 * The live `status` is the most authoritative signal available: it only exists
 * for an actually-running process and updates in real time, so it must override
 * a stale state.json. This is the crux of the "green dot while still thinking"
 * bug — a session re-opened via `claude --resume` keeps working (status "busy")
 * but never rewrites its --bg daemon's state.json, leaving it frozen on the
 * previous turn's "done".
 *
 * Without a live row (the state.json file-watcher path) callers should keep
 * using `effectiveState(job)` directly — this is only for the poller's tick,
 * which is the one place holding the live agents listing.
 */
export function reconcileLiveState(
  row: LiveAgentRow | undefined,
  job: JobState | null,
): string | undefined {
  const status = (row?.status || '').toLowerCase();
  const rowState = (row?.state || '').toLowerCase();

  // Real-time process status wins over any recorded logical state.
  if (status === 'busy') return 'working';
  if (status === 'waiting') return 'blocked'; // e.g. waitingFor: "permission prompt"

  // A background daemon also reports a fresh logical `state` on its row.
  if (rowState === 'working') return 'working';

  // Otherwise defer to the daemon's own state.json (blocked-on-question
  // detection, terminal states, …), then fall back to the row's logical state.
  const eff = job ? effectiveState(job) : undefined;
  if (eff) return eff;
  if (rowState) return rowState;

  // Nothing but a live `status: "idle"` — an interactive session with no `--bg`
  // daemon behind it, i.e. a fork. It has no state.json and its row carries no
  // logical `state`, so `status` is the only signal there will ever be. The row
  // exists only while the process is alive, and an alive-but-idle Claude has
  // finished its turn and is sitting at the prompt: that's "done". Returning
  // undefined here would freeze the conversation on whatever it last was —
  // pulsing blue forever once a turn ended.
  if (status === 'idle') return 'done';
  return undefined;
}

/**
 * Live-aware description: when a re-opened session is working/blocked but its
 * state.json is frozen on a past turn, the recorded detail/result is misleading,
 * so surface the live status instead.
 */
export function deriveLiveDescription(
  row: LiveAgentRow | undefined,
  job: JobState | null,
): string {
  const status = (row?.status || '').toLowerCase();
  if (status === 'busy') return 'working…';
  if (status === 'waiting') {
    const what = (row?.waitingFor || '').trim();
    return what ? `waiting — ${what}` : 'waiting for your input';
  }
  if (job) return deriveDescription(job);
  // Daemonless (forked) session, live and idle — mirrors the "done" that
  // `reconcileLiveState` derives, so the row's text can't linger on "working…".
  if (status === 'idle') return 'completed';
  return '';
}

export function deriveDescription(job: JobState): string {
  // When blocked on a question, the pending question itself is the most
  // accurate description — `detail` is sometimes left as "starting…" or the
  // previous turn's text in this case.
  if (isBlocked(job)) {
    const q = job.block?.questions?.[0]?.question?.trim();
    if (q) return q;
    const needs = job.needs?.trim();
    if (needs) return needs;
    return 'waiting for your input';
  }

  const detail = (job.detail || job.output?.result || '').trim();
  if (detail) return detail;

  const state = (job.state || '').toLowerCase();
  const tempo = (job.tempo || '').toLowerCase();
  const kinds = job.inFlight?.kinds ?? [];
  const tasks = job.inFlight?.tasks ?? 0;
  if (state === 'failed' || state === 'error') return 'failed';
  if (state === 'done' || state === 'completed') return 'completed';
  if (state === 'starting') return 'starting…';
  const active = state === 'working' || state === 'active' || tempo === 'active' || tasks > 0;
  if (active) {
    if (kinds.length > 0) {
      const uniq = Array.from(new Set(kinds)).slice(0, 3).join(', ').toLowerCase();
      return `working — ${uniq}…`;
    }
    return 'working…';
  }
  return state || 'idle';
}
