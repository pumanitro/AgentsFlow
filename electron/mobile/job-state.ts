// Job-state readers for the mobile gateway: a `claude` --bg daemon's
// state.json + timeline.jsonl, reduced to the wire `JobSlice`.
// Pure, synchronous `fs`; no electron import.
import * as fs from 'fs';
import * as path from 'path';
import type { JobSlice, MobileConvState } from '../../shared/mobile';
import type { JobState } from '../claude-cli';
import { deriveDescription } from '../derive-state';

const TIMELINE_TAIL_BYTES = 64 * 1024;

/** Same rule as derive-state's (unexported) `isBlocked`. */
export function jobIsBlocked(job: JobState | null | undefined): boolean {
  if (!job) return false;
  if ((job.tempo || '').toLowerCase() === 'blocked') return true;
  if (job.block?.questions && job.block.questions.length > 0) return true;
  if (typeof job.needs === 'string' && job.needs.trim().length > 0) return true;
  return false;
}

export function normalizeState(raw: string | undefined, blocked: boolean): MobileConvState {
  if (blocked) return 'blocked';
  switch ((raw || '').toLowerCase()) {
    case 'working': case 'active': return 'working';
    case 'done': case 'completed': return 'done';
    case 'failed': case 'error': return 'failed';
    case 'starting': return 'starting';
    case 'blocked': case 'needs-input': return 'blocked';
    default: return 'idle';
  }
}

export function sliceFromJobState(job: JobState & { suggestedReply?: string }, timeline: JobSlice['timeline']): JobSlice {
  const blocked = jobIsBlocked(job);
  const slice: JobSlice = {
    state: normalizeState(job.state, blocked),
    rawState: job.state ?? '',
    detail: deriveDescription(job),
    questions: (job.block?.questions ?? []).map((q, i) => ({
      id: 'q' + i,
      question: q?.question ?? '',
      options: (q?.options ?? []).map((o) => {
        const opt: { label: string; description?: string } = { label: o?.label ?? '' };
        if (o?.description !== undefined) opt.description = o.description;
        return opt;
      }),
    })),
    inFlight: {
      tasks: job.inFlight?.tasks ?? 0,
      queued: job.inFlight?.queued ?? 0,
      kinds: job.inFlight?.kinds ?? [],
    },
    timeline,
  };
  if (job.tempo !== undefined) slice.tempo = job.tempo;
  if (job.needs !== undefined) slice.needs = job.needs;
  if (typeof job.suggestedReply === 'string') slice.suggestedReply = job.suggestedReply;
  if (job.updatedAt !== undefined) slice.updatedAt = job.updatedAt;
  return slice;
}

export function readTimelineTail(jobsRoot: string, daemonShort: string, n = 20): JobSlice['timeline'] {
  const file = path.join(jobsRoot, daemonShort, 'timeline.jsonl');
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TIMELINE_TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    // Keep only complete lines: drop a trailing partial (no '\n') unless it parses.
    const lines = text.split('\n');
    const out: JobSlice['timeline'] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      try {
        const o = JSON.parse(t);
        out.push({
          at: typeof o.at === 'string' ? o.at : '',
          state: typeof o.state === 'string' ? o.state : '',
          detail: typeof o.detail === 'string' ? o.detail : '',
        });
      } catch { /* partial or corrupt line */ }
    }
    return out.slice(-n);
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

export function readJobSlice(jobsRoot: string, daemonShort: string): JobSlice | null {
  if (!daemonShort) return null;
  let job: (JobState & { suggestedReply?: string }) | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(jobsRoot, daemonShort, 'state.json'), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) job = raw;
  } catch {
    return null;
  }
  if (!job) return null;
  return sliceFromJobState(job, readTimelineTail(jobsRoot, daemonShort));
}
