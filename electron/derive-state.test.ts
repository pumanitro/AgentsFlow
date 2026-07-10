import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { effectiveState, deriveDescription, reconcileLiveState, deriveLiveDescription, findLiveRow } from './derive-state';
import type { ClaudeAgentJsonRow, JobState } from './claude-cli';

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

describe('findLiveRow', () => {
  // Verbatim shapes from a real `claude agents --json`. A `--bg` daemon carries
  // `id` (the daemonShort) and a logical `state`; a fork's interactive process
  // carries neither — only `status`.
  const daemonRow: ClaudeAgentJsonRow = {
    pid: 54609, cwd: '/Users/iij/IdeaProjects/atlas-of-doors', kind: 'background',
    startedAt: 1783582564525, sessionId: 'caecd0f9-cbe2-4094-946e-16ba9cf8a96b',
    name: 'game council bootstrap protocol', status: 'waiting',
    waitingFor: 'permission prompt', state: 'blocked',
  };
  const forkRow: ClaudeAgentJsonRow = {
    pid: 58416, cwd: '/Users/iij/IdeaProjects/atlas-of-doors', kind: 'interactive',
    startedAt: 1783587950584, sessionId: '42c61f94-fe9e-458f-99a5-558ccf9d6f56',
    name: 'game council bootstrap protocol', status: 'idle',
  };
  const rows = [daemonRow, forkRow];

  it('regression: finds a fork by exact sessionId (no daemonShort, no sessionName)', () => {
    // The store's real "V2 · /game-council" fork entry.
    const fork = { sessionName: '', daemonShort: '', sessionId: '42c61f94-fe9e-458f-99a5-558ccf9d6f56' };
    assert.equal(findLiveRow(fork, rows), forkRow);
    // …and it must resolve to a real dot state, not stay grey.
    assert.equal(reconcileLiveState(findLiveRow(fork, rows), null), 'done');
  });

  it('a fork whose interactive process is gone matches nothing', () => {
    const fork = { sessionName: '', daemonShort: '', sessionId: 'deadbeef-0000-0000-0000-000000000000' };
    assert.equal(findLiveRow(fork, rows), undefined);
  });

  it('an unopened fork (empty sessionId would match nothing) never grabs a row', () => {
    assert.equal(findLiveRow({ sessionName: '', daemonShort: '', sessionId: '' }, rows), undefined);
  });

  it('a --bg conversation still matches by daemonShort prefix', () => {
    const conv = { sessionName: '', daemonShort: 'caecd0f9', sessionId: '' };
    assert.equal(findLiveRow(conv, rows), daemonRow);
  });

  it('the fork does not steal its source conversation\'s row (same name, different session)', () => {
    // Both rows carry name "game council bootstrap protocol" — the fork inherits
    // the source's CLI-derived name. daemonShort must still win for the source.
    const source = { sessionName: '', daemonShort: 'caecd0f9', sessionId: 'caecd0f9-cbe2-4094-946e-16ba9cf8a96b' };
    assert.equal(findLiveRow(source, rows), daemonRow);
  });

  it('sessionName takes precedence when set (legacy path)', () => {
    const conv = { sessionName: 'game council bootstrap protocol', daemonShort: '', sessionId: '' };
    assert.equal(findLiveRow(conv, rows), daemonRow);
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
  });

  it('regression: a forked session (interactive row, no state.json) resolves a real state', () => {
    // A fork runs as `--resume … --fork-session`: no --bg daemon, so no
    // state.json and no logical `state` on its agents row. Its only signal is
    // the live `status`. Returning undefined for all of these left the fork on
    // its seeded "idle" forever — the permanently-grey dot.
    assert.equal(reconcileLiveState({ status: 'busy' }, null), 'working');
    assert.equal(reconcileLiveState({ status: 'waiting', waitingFor: 'permission prompt' }, null), 'blocked');
    // Alive but idle = the turn finished and it's waiting at the prompt.
    assert.equal(reconcileLiveState({ status: 'idle' }, null), 'done');
    assert.equal(deriveLiveDescription({ status: 'idle' }, null), 'completed');
  });

  it('an unknown status with no job and no row state stays undecided', () => {
    assert.equal(reconcileLiveState({ status: '' }, null), undefined);
    assert.equal(reconcileLiveState(undefined, null), undefined);
  });
});
