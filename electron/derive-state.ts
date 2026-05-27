import type { JobState } from './claude-cli';

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
