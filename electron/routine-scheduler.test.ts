import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRoutinesStore } from './routines-store';
import { createRoutineScheduler } from './routine-scheduler';
import type { RoutineSchedulerDeps } from './routines-api';
import type { Conversation, TrackedDirectory } from '../shared/types';
import { CATCHUP_LOOKBACK_MS, CATCHUP_OFF_GRACE_MS } from '../shared/routines';
import type { Routine, RoutineRun, RoutineSchedule } from '../shared/routines';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Fixed local times so the suite is TZ-independent.
const at = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm).getTime();
const isoOf = (ms: number) => new Date(ms).toISOString();

/** Stand-in for the shared occurrencesBetween (WP-01 fills the real one in parallel): daily at schedule.time, local. */
function fakeOccurrences(schedule: RoutineSchedule, fromMs: number, toMs: number): string[] {
  const [hh, mm] = schedule.time.split(':').map(Number);
  const out: string[] = [];
  const start = new Date(fromMs);
  for (let i = -1; i < 400; i++) {
    const slot = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, hh, mm).getTime();
    if (slot >= toMs) break;
    if (slot >= fromMs) out.push(isoOf(slot));
  }
  return out;
}

const DIR: TrackedDirectory = { id: 'dir-1', path: '/tmp/peer', displayName: 'peer', addedAt: isoOf(at(1, 0)) };

const conv = (id: string, fields: Partial<Conversation>): Conversation => ({
  id, sessionId: 's', daemonShort: 'd', sessionName: 'n', directoryId: 'dir-1', directoryPath: '/tmp/peer',
  displayName: 'peer', title: 't', description: '', pinned: true, state: 'working', status: 'busy', intent: '',
  createdAt: isoOf(at(1, 0)), lastPrompt: '', ...fields,
} as Conversation);

interface Harness {
  deps: RoutineSchedulerDeps;
  sched: ReturnType<typeof createRoutineScheduler>;
  store: ReturnType<typeof createRoutinesStore>;
  setNow: (ms: number) => void;
  spawns: { routine: Routine; run: RoutineRun; existedBeforeSpawn: boolean }[];
  convs: Map<string, Conversation>;
  logs: string[];
  changes: () => number;
}

function harness(startMs: number, over: Partial<RoutineSchedulerDeps> = {}): Harness {
  let now = startMs;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routine-sched-')), 'routines.json');
  const store = createRoutinesStore(file, { now: () => now });
  const spawns: Harness['spawns'] = [];
  const convs = new Map<string, Conversation>();
  const logs: string[] = [];
  let changes = 0;
  const deps: RoutineSchedulerDeps = {
    store,
    now: () => now,
    getDirectories: () => [DIR],
    getConversation: (id) => convs.get(id) ?? null,
    spawn: async (routine, run) => {
      spawns.push({ routine, run, existedBeforeSpawn: Boolean(store.getRun(run.id)) });
      const conversationId = `conv-${spawns.length}`;
      convs.set(conversationId, conv(conversationId, {}));
      return { conversationId };
    },
    onChange: () => { changes++; },
    log: (m, d) => { logs.push(`${m} ${JSON.stringify(d ?? {})}`); },
    occurrencesBetween: fakeOccurrences,
    ...over,
  };
  return { deps, sched: createRoutineScheduler(deps), store, setNow: (ms) => { now = ms; }, spawns, convs, logs, changes: () => changes };
}

const addRoutine = (h: Harness, extra: Partial<Routine> = {}): Routine => h.store.addRoutine({
  id: extra.id ?? 'r1', name: 'Reddit daily', directoryId: 'dir-1', provider: 'claude', prompt: '/secret-prompt-text',
  schedule: { cadence: 'daily', time: '09:00' }, icon: 'reddit', enabled: true,
  createdAt: isoOf(at(10, 0)), updatedAt: isoOf(at(10, 0)), ...extra,
});

const runsOf = (h: Harness, routineId = 'r1') => h.store.listRuns({ routineId });

describe('scheduler rule 1: tick re-entrancy and start/stop', () => {
  it('a tick while one is in flight does nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness(at(10, 9, 0) + 10_000, {
      spawn: async () => { await gate; return { conversationId: 'c' }; },
    });
    addRoutine(h);
    const first = h.sched.tick();
    await h.sched.tick();
    assert.equal(runsOf(h).length, 1);
    release();
    await first;
    assert.equal(runsOf(h).length, 1);
    assert.equal(runsOf(h)[0].conversationId, 'c');
  });

  it('start: first tick after 10 s, then every 15 s; idempotent; stop halts', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
      let ticks = 0;
      const h = harness(at(10, 12, 0), { getDirectories: () => { ticks++; return [DIR]; } });
      h.sched.start();
      h.sched.start();
      mock.timers.tick(9_999);
      await Promise.resolve();
      assert.equal(ticks, 0);
      mock.timers.tick(1);
      await new Promise((r) => setImmediate(r));
      assert.equal(ticks, 1);
      mock.timers.tick(15_000);
      await new Promise((r) => setImmediate(r));
      assert.equal(ticks, 2);
      h.sched.stop();
      mock.timers.tick(60_000);
      await new Promise((r) => setImmediate(r));
      assert.equal(ticks, 2);
    } finally {
      mock.timers.reset();
    }
  });
});

describe('scheduler rule 2: due slots', () => {
  it('a slot that just came due dispatches with trigger schedule', async () => {
    const h = harness(at(10, 9, 0) + 30_000);
    addRoutine(h);
    await h.sched.tick();
    assert.equal(h.spawns.length, 1);
    const [r] = runsOf(h);
    assert.equal(r.slotAt, isoOf(at(10, 9)));
    assert.equal(r.trigger, 'schedule');
    assert.equal(r.status, 'running');
    assert.equal(r.conversationId, 'conv-1');
    assert.equal(h.spawns[0].routine.id, 'r1');
  });

  it('a slot older than 90 s runs as catchup', async () => {
    const h = harness(at(10, 12, 0));
    addRoutine(h);
    await h.sched.tick();
    assert.equal(runsOf(h)[0].trigger, 'catchup');
  });

  it('only the newest unrun slot runs; every older one is recorded missed', async () => {
    const h = harness(at(10, 12, 0));
    addRoutine(h, { createdAt: isoOf(at(7, 0)) });
    await h.sched.tick();
    const runs = runsOf(h);
    assert.deepEqual(runs.map((r) => [new Date(r.slotAt).getDate(), r.status]), [[7, 'missed'], [8, 'missed'], [9, 'missed'], [10, 'running']]);
    const missed = runs[0];
    assert.equal(missed.conversationId, undefined);
    assert.equal(missed.startedAt, isoOf(at(10, 12)));
    assert.equal(missed.endedAt, isoOf(at(10, 12)));
    assert.equal(h.spawns.length, 1);
  });

  it('never looks back more than CATCHUP_LOOKBACK_MS', async () => {
    const h = harness(at(20, 8, 0));
    addRoutine(h, { createdAt: isoOf(new Date(2026, 6, 1).getTime()) });
    await h.sched.tick();
    assert.equal(runsOf(h).length, CATCHUP_LOOKBACK_MS / DAY);
    assert.equal(h.spawns.length, 1);
  });

  it('an old unrun slot with a later slot already recorded is missed, never run', async () => {
    const h = harness(at(20, 12, 0));
    addRoutine(h, { createdAt: isoOf(at(17, 0)) });
    for (const d of [19, 20]) h.store.upsertRun({ id: `done-${d}`, routineId: 'r1', slotAt: isoOf(at(d, 9)), trigger: 'schedule', status: 'success', startedAt: isoOf(at(d, 9)), endedAt: isoOf(at(d, 9, 5)) });
    await h.sched.tick();
    assert.equal(h.spawns.length, 0);
    assert.deepEqual(runsOf(h).map((r) => [new Date(r.slotAt).getDate(), r.status]), [[17, 'missed'], [18, 'missed'], [19, 'success'], [20, 'success']]);
  });

  it('a live run holds the newest slot unrun (not missed) until it ends', async () => {
    const h = harness(at(10, 9, 0) + 5_000);
    addRoutine(h, { createdAt: isoOf(at(10, 0)) });
    h.store.upsertRun({ id: 'live', routineId: 'r1', slotAt: isoOf(at(10, 8)), trigger: 'manual', status: 'running', startedAt: isoOf(at(10, 8)), conversationId: 'cl' });
    h.convs.set('cl', conv('cl', { state: 'working', status: 'busy' }));
    await h.sched.tick();
    assert.equal(h.spawns.length, 0);
    assert.equal(h.store.findRun('r1', isoOf(at(10, 9))), null);
    h.convs.set('cl', conv('cl', { state: 'done', status: 'idle' }));
    h.setNow(at(10, 9, 2));
    await h.sched.tick();
    assert.equal(h.spawns.length, 1);
    assert.equal(h.store.findRun('r1', isoOf(at(10, 9)))?.trigger, 'catchup');
  });

  it('a paused routine and a peer-less routine record nothing', async () => {
    const h = harness(at(10, 12, 0));
    addRoutine(h, { id: 'paused', enabled: false });
    addRoutine(h, { id: 'nodir', directoryId: '' });
    addRoutine(h, { id: 'gone', directoryId: 'dir-removed' });
    await h.sched.tick();
    assert.equal(h.store.listRuns().length, 0);
    assert.equal(h.spawns.length, 0);
  });

  it('slots before createdAt do not exist: seeding at 14:00 never fires that 09:00', async () => {
    const h = harness(at(10, 14, 0));
    addRoutine(h, { createdAt: isoOf(at(10, 14, 0)) });
    await h.sched.tick();
    h.setNow(at(10, 20, 0));
    await h.sched.tick();
    assert.equal(h.store.listRuns().length, 0);
    h.setNow(at(11, 9, 0) + 1000);
    await h.sched.tick();
    assert.deepEqual(runsOf(h).map((r) => [r.slotAt, r.trigger]), [[isoOf(at(11, 9)), 'schedule']]);
  });

  it('slots before enabledAt do not exist: resuming creates no misses for the pause', async () => {
    const h = harness(at(10, 12, 0));
    addRoutine(h, { createdAt: isoOf(at(1, 0)), enabledAt: isoOf(at(10, 11, 0)) });
    await h.sched.tick();
    assert.equal(h.store.listRuns().length, 0);
  });
});

describe('scheduler rule 2: catch-up switch', () => {
  // The real schedule math, so weekly and monthly slots exist.
  const real = { occurrencesBetween: undefined };

  it('default (catchUp undefined) runs the newest slot however old it is', async () => {
    const h = harness(at(10, 8, 0));   // yesterday 09:00 is 23 h old
    addRoutine(h, { createdAt: isoOf(at(9, 0)) });
    await h.sched.tick();
    assert.equal(h.spawns.length, 1);
    assert.deepEqual(runsOf(h).map((r) => [r.slotAt, r.status, r.trigger]), [[isoOf(at(9, 9)), 'running', 'catchup']]);
  });

  it('on: a weekly slot missed 2 days ago runs once, older ones are missed', async () => {
    const h = harness(at(7, 12, 0), real);   // Wednesday; the slot was Monday 5 Oct 09:00
    addRoutine(h, { catchUp: true, schedule: { cadence: 'weekly', time: '09:00', weekday: 1 }, createdAt: isoOf(new Date(2026, 8, 20).getTime()) });
    await h.sched.tick();
    assert.deepEqual(runsOf(h).map((r) => [new Date(r.slotAt).getDate(), r.status, r.trigger]), [[21, 'missed', 'schedule'], [28, 'missed', 'schedule'], [5, 'running', 'catchup']]);
    assert.equal(h.spawns.length, 1);
    h.setNow(at(7, 12, 1));
    await h.sched.tick();
    assert.equal(h.spawns.length, 1, 'the caught-up slot is taken, never run twice');
  });

  it('on: custom weekdays slept through run once for the newest day, older ones are missed', async () => {
    const h = harness(at(11, 12, 0), real);   // Sunday; Mon 5, Wed 7 and Fri 9 Oct 06:00 all passed while asleep
    addRoutine(h, { catchUp: true, schedule: { cadence: 'weekdays', time: '06:00', weekdays: [1, 3, 5] }, createdAt: isoOf(at(4, 0)) });
    await h.sched.tick();
    assert.deepEqual(runsOf(h).map((r) => [r.slotAt, r.status, r.trigger]), [
      [isoOf(at(5, 6)), 'missed', 'schedule'], [isoOf(at(7, 6)), 'missed', 'schedule'], [isoOf(at(9, 6)), 'running', 'catchup'],
    ]);
    assert.equal(h.spawns.length, 1);
    h.convs.set('conv-1', conv('conv-1', { state: 'done', status: 'completed' }));
    h.setNow(at(12, 6, 0) + 1000);            // Monday's own slot, over the week boundary
    await h.sched.tick();
    await h.sched.tick();
    assert.equal(h.spawns.length, 2);
    assert.deepEqual(runsOf(h).map((r) => [r.slotAt, r.trigger]).pop(), [isoOf(at(12, 6)), 'schedule']);
  });

  it('off: custom weekdays slept through are all missed, and the next chosen day still runs', async () => {
    const h = harness(at(11, 12, 0), real);
    addRoutine(h, { catchUp: false, schedule: { cadence: 'weekdays', time: '06:00', weekdays: [1, 3, 5] }, createdAt: isoOf(at(4, 0)) });
    await h.sched.tick();
    assert.equal(h.spawns.length, 0);
    assert.deepEqual(runsOf(h).map((r) => [r.slotAt, r.status]), [[isoOf(at(5, 6)), 'missed'], [isoOf(at(7, 6)), 'missed'], [isoOf(at(9, 6)), 'missed']]);
    h.setNow(at(12, 6, 0) + 1000);
    await h.sched.tick();
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0].run.slotAt, isoOf(at(12, 6)));
  });

  it('on: a monthly slot missed 10 days ago still runs', async () => {
    const h = harness(at(11, 12, 0), real);
    addRoutine(h, { schedule: { cadence: 'monthly', time: '09:00', monthDays: [1] }, createdAt: isoOf(new Date(2026, 7, 20).getTime()) });
    await h.sched.tick();
    assert.deepEqual(runsOf(h).map((r) => [r.slotAt, r.status, r.trigger]), [[isoOf(at(1, 9)), 'running', 'catchup']]);
  });

  it('off: a slot noticed inside the grace is dispatched', async () => {
    const h = harness(at(10, 9, 0) + CATCHUP_OFF_GRACE_MS - 1000);
    addRoutine(h, { catchUp: false });
    await h.sched.tick();
    assert.equal(h.spawns.length, 1);
    assert.deepEqual(runsOf(h).map((r) => [r.status, r.trigger]), [['running', 'catchup']]);
  });

  it('off: a slot noticed after the grace is recorded missed and never run', async () => {
    const h = harness(at(10, 9, 0) + CATCHUP_OFF_GRACE_MS + 1000);
    addRoutine(h, { catchUp: false });
    await h.sched.tick();
    h.setNow(at(10, 12, 0));
    await h.sched.tick();
    assert.equal(h.spawns.length, 0);
    assert.deepEqual(runsOf(h).map((r) => [r.slotAt, r.status]), [[isoOf(at(10, 9)), 'missed']]);
  });

  it('off: a slot held by a live run past the grace is missed', async () => {
    const h = harness(at(10, 9, 0) + 5_000);
    addRoutine(h, { catchUp: false });
    h.store.upsertRun({ id: 'live', routineId: 'r1', slotAt: isoOf(at(10, 8)), trigger: 'manual', status: 'running', startedAt: isoOf(at(10, 8)), conversationId: 'cl' });
    h.convs.set('cl', conv('cl', { state: 'working', status: 'busy' }));
    await h.sched.tick();
    assert.equal(h.store.findRun('r1', isoOf(at(10, 9))), null);
    h.setNow(at(10, 9, 10));
    await h.sched.tick();
    assert.equal(h.spawns.length, 0);
    assert.equal(h.store.findRun('r1', isoOf(at(10, 9)))?.status, 'missed');
  });

  it('flipping off → on does not resurrect a slot already recorded missed', async () => {
    const h = harness(at(10, 12, 0));
    addRoutine(h, { catchUp: false });
    await h.sched.tick();
    assert.deepEqual(runsOf(h).map((r) => r.status), ['missed']);
    h.store.updateRoutine('r1', { catchUp: true });
    h.setNow(at(10, 12, 1));
    await h.sched.tick();
    assert.equal(h.spawns.length, 0);
    assert.deepEqual(runsOf(h).map((r) => r.status), ['missed']);
    // The next slot is a fresh one and catches up as usual.
    h.setNow(at(11, 15, 0));
    await h.sched.tick();
    assert.deepEqual(runsOf(h).map((r) => [r.status, r.trigger]), [['missed', 'schedule'], ['running', 'catchup']]);
  });
});

describe('scheduler rule 3: dispatch', () => {
  it('writes the running row before spawn is awaited', async () => {
    const h = harness(at(10, 9, 0) + 1000);
    addRoutine(h);
    await h.sched.tick();
    assert.equal(h.spawns[0].existedBeforeSpawn, true);
    assert.equal(h.spawns[0].run.status, 'running');
    assert.ok(h.changes() >= 2);
  });

  it('a spawn rejection fails the run with the message', async () => {
    const h = harness(at(10, 9, 0) + 1000, { spawn: async () => { throw new Error('peer not found — pick one'); } });
    addRoutine(h);
    await h.sched.tick();
    const [r] = runsOf(h);
    assert.equal(r.status, 'failed');
    assert.equal(r.error, 'peer not found — pick one');
    assert.ok(r.endedAt);
    await h.sched.tick();
    assert.equal(runsOf(h).length, 1, 'a failed slot is taken, never retried');
  });

  it('a routine deleted mid-spawn leaves no orphan run', async () => {
    let h!: Harness;
    h = harness(at(10, 9, 0) + 1000, { spawn: async () => { h.store.removeRoutine('r1'); return { conversationId: 'c' }; } });
    addRoutine(h);
    await h.sched.tick();
    assert.equal(h.store.listRuns().length, 0);
  });
});

describe('scheduler rule 4: live run tracking', () => {
  async function started(): Promise<Harness & { runId: string }> {
    const h = harness(at(10, 9, 0) + 1000);
    addRoutine(h);
    await h.sched.tick();
    return Object.assign(h, { runId: runsOf(h)[0].id });
  }

  it('flips running ↔ attention with the chat', async () => {
    const h = await started();
    h.convs.set('conv-1', conv('conv-1', { state: 'blocked', status: 'waiting' }));
    await h.sched.tick();
    assert.equal(h.store.getRun(h.runId)?.status, 'attention');
    h.convs.set('conv-1', conv('conv-1', { state: 'working', status: 'busy' }));
    await h.sched.tick();
    assert.equal(h.store.getRun(h.runId)?.status, 'running');
  });

  it('success ends the run with a ≤200-char summary from lastResult, then description', async () => {
    const h = await started();
    h.convs.set('conv-1', conv('conv-1', { state: 'done', status: 'idle', lastResult: `  ${'x'.repeat(300)}  `, description: 'desc' }));
    h.setNow(at(10, 9, 5));
    await h.sched.tick();
    const r = h.store.getRun(h.runId)!;
    assert.equal(r.status, 'success');
    assert.equal(r.summary, 'x'.repeat(200));
    assert.equal(r.endedAt, isoOf(at(10, 9, 5)));
  });

  it('failed ends the run with an error', async () => {
    const h = await started();
    h.convs.set('conv-1', conv('conv-1', { state: 'failed', status: '', description: 'boom' }));
    await h.sched.tick();
    const r = h.store.getRun(h.runId)!;
    assert.equal(r.status, 'failed');
    assert.equal(r.summary, 'boom');
    assert.ok(r.error);
  });

  it('a chat that disappears fails the run after 60 s, not before', async () => {
    const h = await started();
    h.convs.delete('conv-1');
    h.setNow(at(10, 9, 0) + 30_000);
    await h.sched.tick();
    assert.equal(h.store.getRun(h.runId)?.status, 'running');
    h.setNow(at(10, 9, 2));
    await h.sched.tick();
    assert.equal(h.store.getRun(h.runId)?.error, 'chat was removed');
  });

  it('times out after 6 h', async () => {
    const h = await started();
    h.setNow(at(10, 15, 1));
    await h.sched.tick();
    const r = h.store.getRun(h.runId)!;
    assert.equal(r.status, 'failed');
    assert.equal(r.error, 'timed out after 6 h');
  });

  it('a quiet chat is settled through settleQuietRun after 3 consecutive quiet ticks past 2 min', async () => {
    let calls = 0;
    const h = harness(at(10, 9, 0) + 1000, { settleQuietRun: async () => { calls++; return { summary: 'posted 3 comments' }; } });
    addRoutine(h);
    await h.sched.tick();
    const runId = runsOf(h)[0].id;
    h.convs.set('conv-1', conv('conv-1', { state: 'working', status: 'idle' }));
    h.setNow(at(10, 9, 1));        // younger than 2 min: does not count
    await h.sched.tick();
    for (const m of [3, 4]) { h.setNow(at(10, 9, m)); await h.sched.tick(); }
    assert.equal(calls, 0);
    h.setNow(at(10, 9, 5));
    await h.sched.tick();
    assert.equal(calls, 1);
    const r = h.store.getRun(runId)!;
    assert.equal(r.status, 'success');
    assert.equal(r.summary, 'posted 3 comments');
  });

  it('a busy tick resets the quiet count; a null settle keeps waiting', async () => {
    let calls = 0;
    const h = harness(at(10, 9, 0) + 1000, { settleQuietRun: async () => { calls++; return null; } });
    addRoutine(h);
    await h.sched.tick();
    const runId = runsOf(h)[0].id;
    const quiet = conv('conv-1', { state: 'working', status: 'idle' });
    const busy = conv('conv-1', { state: 'working', status: 'busy' });
    for (const [m, c] of [[3, quiet], [4, quiet], [5, busy], [6, quiet], [7, quiet]] as const) {
      h.convs.set('conv-1', c); h.setNow(at(10, 9, m)); await h.sched.tick();
    }
    assert.equal(calls, 0);
    h.setNow(at(10, 9, 8)); await h.sched.tick();
    assert.equal(calls, 1);
    assert.equal(h.store.getRun(runId)?.status, 'running');
  });

  it('a spawn that never returns fails after 2 min as spawn did not return', async () => {
    const h = harness(at(10, 9, 0) + 1000, { spawn: () => new Promise(() => {}) });
    addRoutine(h);
    void h.sched.tick();                       // hangs on spawn forever
    await new Promise((r) => setImmediate(r));
    const h2 = createRoutineScheduler({ ...h.deps });   // a fresh pass, as the next interval would after a restart
    h.setNow(at(10, 9, 3));
    await h2.tick();
    const [r] = runsOf(h);
    assert.equal(r.status, 'failed');
    assert.equal(r.error, 'spawn did not return');
  });
});

describe('scheduler rule 5: runNow', () => {
  it('dispatches immediately as manual with slotAt = now and returns the running row', async () => {
    const h = harness(at(10, 15, 12));
    addRoutine(h, { createdAt: isoOf(at(10, 15, 0)) });
    const run = await h.sched.runNow('r1');
    assert.equal(run.trigger, 'manual');
    assert.equal(run.status, 'running');
    assert.equal(run.slotAt, isoOf(at(10, 15, 12)));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.spawns.length, 1);
    assert.equal(h.store.getRun(run.id)?.conversationId, 'conv-1');
  });

  it('is allowed while another run is live', async () => {
    const h = harness(at(10, 9, 0) + 1000);
    addRoutine(h);
    await h.sched.tick();
    h.setNow(at(10, 9, 10));
    await h.sched.runNow('r1');
    await new Promise((r) => setImmediate(r));
    assert.equal(h.spawns.length, 2);
  });

  it('rejects an unknown routine and an unresolved peer', async () => {
    const h = harness(at(10, 12, 0));
    addRoutine(h, { id: 'nodir', directoryId: '', enabled: false });
    await assert.rejects(h.sched.runNow('missing'), /not found/);
    await assert.rejects(h.sched.runNow('nodir'), /directory/);
    assert.equal(h.spawns.length, 0);
  });
});

describe('scheduler rule 7: logging', () => {
  it('logs through deps.log and never logs the prompt', async () => {
    const h = harness(at(10, 12, 0), { spawn: async () => { throw new Error('nope'); } });
    addRoutine(h, { createdAt: isoOf(at(8, 0)) });
    await h.sched.tick();
    await h.sched.runNow('r1').catch(() => {});
    await new Promise((r) => setImmediate(r));
    assert.ok(h.logs.length >= 3);
    assert.ok(h.logs.every((l) => !l.includes('secret-prompt-text')));
  });
});
