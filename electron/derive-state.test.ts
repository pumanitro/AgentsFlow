import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { effectiveState, deriveDescription, reconcileLiveState, deriveLiveDescription } from './derive-state';
import type { JobState } from './claude-cli';

const base = (over: Partial<JobState> = {}): JobState => ({
  inFlight: { tasks: 0, queued: 0, kinds: [] },
  ...over,
});

describe('effectiveState', () => {
  it('returns "working" when tempo is active', () => {
    assert.equal(effectiveState(base({ state: 'done', tempo: 'active' })), 'working');
  });

  it('returns "working" when inFlight.tasks > 0', () => {
    assert.equal(
      effectiveState(base({ state: 'done', tempo: 'idle', inFlight: { tasks: 1 } })),
      'working',
    );
  });

  it('returns "blocked" when tempo is blocked even if state still says "working"', () => {
    // Real-world bug: daemon transitions straight from starting → AskUserQuestion
    // and leaves state="working" stale.
    const job = base({ state: 'working', tempo: 'blocked' });
    assert.equal(effectiveState(job), 'blocked');
  });

  it('returns "blocked" when block.questions is populated, even with stale state', () => {
    const job = base({
      state: 'working',
      tempo: 'idle',
      block: { questions: [{ question: 'Which color do you prefer?' }] },
    });
    assert.equal(effectiveState(job), 'blocked');
  });

  it('returns "blocked" when needs is set, even with stale state', () => {
    const job = base({ state: 'working', needs: 'answer: pick one' });
    assert.equal(effectiveState(job), 'blocked');
  });

  it('blocked beats working: tempo=blocked wins over tasks>0', () => {
    // Defensive: if both signals collide, blocked should win because the
    // surfaced dot color matters more to the user than "is something running".
    const job = base({ state: 'working', tempo: 'blocked', inFlight: { tasks: 1 } });
    assert.equal(effectiveState(job), 'blocked');
  });

  it('falls through to job.state when neither blocked nor active', () => {
    assert.equal(effectiveState(base({ state: 'done', tempo: 'idle' })), 'done');
    assert.equal(effectiveState(base({ state: 'failed', tempo: 'idle' })), 'failed');
  });

  it('ignores empty needs string', () => {
    const job = base({ state: 'done', tempo: 'idle', needs: '   ' });
    assert.equal(effectiveState(job), 'done');
  });
});

describe('deriveDescription', () => {
  it('uses block.questions[0].question when blocked', () => {
    const job = base({
      state: 'working',
      tempo: 'blocked',
      detail: 'starting…', // stale
      block: { questions: [{ question: 'Which color do you prefer?' }] },
    });
    assert.equal(deriveDescription(job), 'Which color do you prefer?');
  });

  it('falls back to needs when blocked without block.questions', () => {
    const job = base({
      state: 'working',
      tempo: 'blocked',
      detail: 'starting…',
      needs: 'Want me to verify what is on disk?',
    });
    assert.equal(deriveDescription(job), 'Want me to verify what is on disk?');
  });

  it('falls back to "waiting for your input" if blocked but no question text', () => {
    const job = base({ tempo: 'blocked' });
    assert.equal(deriveDescription(job), 'waiting for your input');
  });

  it('returns detail when present and not blocked', () => {
    const job = base({ state: 'done', detail: 'Pushed abc123 to origin/main.' });
    assert.equal(deriveDescription(job), 'Pushed abc123 to origin/main.');
  });

  it('returns output.result when detail is empty', () => {
    const job = base({ state: 'done', detail: '', output: { result: 'all good' } });
    assert.equal(deriveDescription(job), 'all good');
  });

  it('says "completed" when state=done with no detail', () => {
    assert.equal(deriveDescription(base({ state: 'done' })), 'completed');
  });

  it('says "starting…" when state=starting with no detail', () => {
    assert.equal(deriveDescription(base({ state: 'starting' })), 'starting…');
  });

  it('says "working — <kinds>…" when active with kinds', () => {
    const job = base({
      state: 'working',
      tempo: 'active',
      inFlight: { tasks: 2, kinds: ['Read', 'Edit', 'Read'] },
    });
    assert.equal(deriveDescription(job), 'working — read, edit…');
  });

  it('says "working…" when active without kinds', () => {
    const job = base({ tempo: 'active' });
    assert.equal(deriveDescription(job), 'working…');
  });

  it('regression: the screenshot scenario (job 0cb8f155)', () => {
    // Exact shape from ~/.claude/jobs/0cb8f155/state.json — used to produce a
    // blue dot stuck on "starting…" forever.
    const job: JobState = {
      state: 'working',
      detail: 'starting…',
      tempo: 'blocked',
      inFlight: { tasks: 0, queued: 0, kinds: [] },
      needs: 'answer: Which color do you prefer? (Red · Blue · Green)',
      block: {
        questions: [
          {
            question: 'Which color do you prefer?',
            options: [
              { label: 'Red', description: 'A warm, bold color…' },
              { label: 'Blue', description: 'A cool, calming color…' },
              { label: 'Green', description: 'A natural, refreshing color…' },
            ],
          },
        ],
      },
    };
    assert.equal(effectiveState(job), 'blocked');
    assert.equal(deriveDescription(job), 'Which color do you prefer?');
  });
});

describe('reconcileLiveState', () => {
  it('regression: interactive --resume reports busy while state.json is frozen on "done"', () => {
    // The exact "green dot while still thinking" bug (job 0a3ae346): the --bg
    // daemon's state.json froze on the previous turn's terminal "done", but the
    // re-opened interactive process is live and busy. The live row must win.
    const job = base({ state: 'done', tempo: 'idle', detail: 'draft reply created' });
    const row = { kind: 'interactive', status: 'busy' } as const;
    assert.equal(reconcileLiveState(row, job), 'working');
    assert.equal(deriveLiveDescription(row, job), 'working…');
  });

  it('maps status "waiting" to blocked (e.g. a permission prompt)', () => {
    const job = base({ state: 'working' });
    const row = { status: 'waiting', waitingFor: 'permission prompt' } as const;
    assert.equal(reconcileLiveState(row, job), 'blocked');
    assert.equal(deriveLiveDescription(row, job), 'waiting — permission prompt');
  });

  it('honors a live row state "working" even when state.json says done', () => {
    // Background daemon rows carry their own logical `state`; it too is fresher
    // than a state.json we might read a beat later.
    const job = base({ state: 'done', tempo: 'idle' });
    assert.equal(reconcileLiveState({ state: 'working', status: 'idle' }, job), 'working');
  });

  it('falls back to state.json when the row carries no decisive live signal', () => {
    // A live-but-idle interactive session that has genuinely finished: no busy/
    // waiting status and no row state → defer to the recorded terminal state.
    const job = base({ state: 'done', tempo: 'idle' });
    assert.equal(reconcileLiveState({ status: 'idle' }, job), 'done');
    assert.equal(deriveLiveDescription({ status: 'idle' }, job), 'completed');
  });

  it('still surfaces a blocked-on-question daemon via the job when status is idle', () => {
    const job = base({ state: 'working', block: { questions: [{ question: 'Pick one?' }] } });
    assert.equal(reconcileLiveState({ state: 'blocked', status: 'idle' }, job), 'blocked');
  });

  it('handles a missing job (no state.json yet) using the row alone', () => {
    assert.equal(reconcileLiveState({ status: 'busy' }, null), 'working');
    assert.equal(reconcileLiveState({ state: 'working' }, null), 'working');
    assert.equal(reconcileLiveState({ status: 'idle' }, null), undefined);
  });
});
