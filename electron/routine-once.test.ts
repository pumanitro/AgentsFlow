// One-off routines (cadence 'once'): the schedule math, the scheduler's "the
// computer was off for days, it still runs — once" rule, the calendar marks
// and the MCP tools, all against the real shared code.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRoutinesStore } from './routines-store';
import { createRoutineScheduler } from './routine-scheduler';
import { handleRoutinesOp, type RoutinesToolDeps } from './routines-mcp';
import { cadenceLabel, nextOccurrence, occurrencesBetween, validateRoutineInput } from '../shared/routine-schedule';
import { buildDayCells } from '../shared/routine-board';
import type { Conversation, TrackedDirectory } from '../shared/types';
import type { Routine, RoutineRun, RoutineSchedule } from '../shared/routines';

const DAY = 24 * 60 * 60_000;
const at = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm).getTime();   // Oct 2026, local
const isoOf = (ms: number) => new Date(ms).toISOString();
const ONCE: RoutineSchedule = { cadence: 'once', time: '14:30', date: '2026-10-25' };
const DIR = { id: 'dir-1', path: '/tmp/peer', displayName: 'peer', addedAt: isoOf(at(1, 0)) } as TrackedDirectory;

describe('once: schedule math', () => {
  it('has exactly one slot, on its date at its time, found from any window', () => {
    assert.deepEqual(occurrencesBetween(ONCE, 0, Number.MAX_SAFE_INTEGER), [isoOf(at(25, 14, 30))]);
    assert.deepEqual(occurrencesBetween(ONCE, at(25, 14, 31), at(31, 0)), []);
    assert.equal(nextOccurrence(ONCE, at(1, 0)), isoOf(at(25, 14, 30)));
    // Further than the 62-day search of the repeating cadences.
    assert.equal(nextOccurrence({ ...ONCE, date: '2027-06-01' }, at(1, 0)), isoOf(new Date(2027, 5, 1, 14, 30).getTime()));
    assert.equal(nextOccurrence(ONCE, at(26, 0)), null);
    assert.equal(cadenceLabel(ONCE), '14:30 (once, 25 Oct 2026)');
  });

  it('validation needs a real date, and a new one must not be in the past', () => {
    const input = { name: 'x', directoryId: 'dir-1', prompt: 'p', schedule: ONCE };
    assert.equal(validateRoutineInput(input, [DIR]), null);
    assert.match(validateRoutineInput({ ...input, schedule: { cadence: 'once', time: '09:00' } }, [DIR])!, /date/);
    assert.match(validateRoutineInput({ ...input, schedule: { ...ONCE, date: '2026-02-30' } }, [DIR])!, /date/);
    assert.equal(validateRoutineInput(input, [DIR], at(25, 14, 0)), null);
    assert.match(validateRoutineInput(input, [DIR], at(26, 9, 0))!, /already passed/);
    // Without a clock (an untouched routine being renamed) a past one-off still validates.
    assert.equal(validateRoutineInput(input, [DIR]), null);
  });
});

function harness(startMs: number) {
  let now = startMs;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routine-once-')), 'routines.json');
  const store = createRoutinesStore(file, { now: () => now });
  const spawns: RoutineRun[] = [];
  const sched = createRoutineScheduler({
    store,
    now: () => now,
    getDirectories: () => [DIR],
    getConversation: (id) => ({ id, state: 'working', status: 'busy' } as Conversation),
    spawn: async (_r, run) => { spawns.push(run); return { conversationId: `conv-${spawns.length}` }; },
    onChange: () => {},
    log: () => {},
  });
  const add = (extra: Partial<Routine> = {}) => store.addRoutine({
    id: 'r1', name: 'One-off', directoryId: 'dir-1', provider: 'claude', prompt: 'do it', schedule: ONCE, icon: 'star',
    enabled: true, createdAt: isoOf(at(20, 10)), updatedAt: isoOf(at(20, 10)), enabledAt: isoOf(at(20, 10)), ...extra,
  });
  return { store, sched, spawns, add, setNow: (ms: number) => { now = ms; } };
}

describe('once: scheduler', () => {
  it('does nothing before its time, runs at its time, and never again', async () => {
    const h = harness(at(25, 14, 0));
    h.add();
    await h.sched.tick();
    assert.equal(h.spawns.length, 0);
    h.setNow(at(25, 14, 30, ) + 10_000);
    await h.sched.tick();
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0].slotAt, isoOf(at(25, 14, 30)));
    assert.equal(h.spawns[0].trigger, 'schedule');
    // Finished; days later nothing new is dispatched.
    h.store.upsertRun({ ...h.store.getRun(h.spawns[0].id)!, status: 'success', endedAt: isoOf(at(25, 15)) });
    for (const ms of [at(25, 16), at(26, 14, 30), at(31, 9)]) { h.setNow(ms); await h.sched.tick(); }
    assert.equal(h.spawns.length, 1);
  });

  it('the computer was off on the day and for days after: it runs late, once', async () => {
    const h = harness(at(29, 8, 0));   // four days late
    h.add();
    await h.sched.tick();
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0].trigger, 'catchup');
    assert.equal(h.spawns[0].slotAt, isoOf(at(25, 14, 30)));
    h.setNow(at(29, 8, 1));
    await h.sched.tick();
    assert.equal(h.spawns.length, 1);
  });

  it('catch-up off is ignored, and so is the 40-day look-back: a one-off always runs', async () => {
    const h = harness(at(25, 14, 30) + 90 * DAY);
    h.add({ catchUp: false });
    await h.sched.tick();
    assert.equal(h.spawns.length, 1);
    assert.equal(h.store.listRuns({ routineId: 'r1' }).filter((r) => r.status === 'missed').length, 0);
  });

  it('a paused one-off waits, and runs once it is resumed', async () => {
    const h = harness(at(27, 9, 0));
    h.add({ enabled: false });
    await h.sched.tick();
    assert.equal(h.spawns.length, 0);
    h.store.updateRoutine('r1', { enabled: true });
    await h.sched.tick();
    assert.equal(h.spawns.length, 1);
  });
});

describe('once: calendar', () => {
  const routine: Routine = {
    id: 'r1', name: 'One-off', directoryId: 'dir-1', provider: 'claude', prompt: 'p', schedule: ONCE, icon: 'star',
    enabled: true, createdAt: isoOf(at(20, 10)), updatedAt: isoOf(at(20, 10)), catchUp: false,
  };
  it('shows one scheduled mark on its day', () => {
    const [d24, d25] = buildDayCells([routine], [], ['2026-10-24', '2026-10-25'], at(20, 12));
    assert.equal(d24.once.length, 0);
    assert.equal(d25.once.length, 1);
    assert.equal(d25.once[0].status, 'scheduled');
  });
  it('an overdue one-off still shows as pending, not missed', () => {
    const [d25] = buildDayCells([routine], [], ['2026-10-25'], at(28, 12));
    assert.equal(d25.once[0].status, 'scheduled');
  });
});

describe('once: MCP tools', () => {
  const T0 = at(23, 12);
  function setup() {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routine-once-mcp-')), 'routines.json');
    const store = createRoutinesStore(file, { now: () => T0 });
    let n = 0;
    const deps: RoutinesToolDeps = {
      store, getDirectories: () => [DIR], callerDirectoryId: () => 'dir-1',
      runNow: async () => { throw new Error('unused'); }, now: () => T0, newId: () => `r${++n}`, onChange: () => {},
    };
    return { store, call: (op: string, args: Record<string, unknown>) => handleRoutinesOp(op, args, deps) as Promise<any> };
  }

  it('create_routine with cadence once and a date', async () => {
    const { store, call } = setup();
    const r = await call('create', { name: 'Send report', prompt: 'p', cadence: 'once', date: '2026-10-25', time: '14:30' });
    assert.equal(r.status, 'success');
    assert.equal(r.routine.date, '2026-10-25');
    assert.equal(r.routine.schedule, '14:30 (once, 25 Oct 2026)');
    assert.equal(r.routine.nextRunAt, isoOf(at(25, 14, 30)));
    assert.deepEqual(store.getRoutine('r1')!.schedule, ONCE);
  });

  it('refuses a missing date, a past date, and a date on a repeating cadence', async () => {
    const { store, call } = setup();
    assert.match((await call('create', { name: 'a', prompt: 'p', cadence: 'once', time: '09:00' })).error, /date/);
    assert.match((await call('create', { name: 'a', prompt: 'p', cadence: 'once', date: '2026-10-20', time: '09:00' })).error, /already passed/);
    assert.match((await call('create', { name: 'a', prompt: 'p', cadence: 'daily', date: '2026-10-25', time: '09:00' })).error, /only goes with cadence "once"/);
    assert.equal(store.listRoutines().length, 0);
  });

  it('update moves the date; a past one is refused, a rename of a past one is not', async () => {
    const { store, call } = setup();
    await call('create', { name: 'a', prompt: 'p', cadence: 'once', date: '2026-10-25', time: '09:00' });
    assert.equal((await call('update', { routine: 'a', date: '2026-11-02' })).status, 'success');
    assert.equal(store.getRoutine('r1')!.schedule.date, '2026-11-02');
    assert.match((await call('update', { routine: 'a', date: '2026-10-01' })).error, /already passed/);
    store.updateRoutine('r1', { schedule: { ...ONCE, date: '2026-10-01' } });   // its day went by
    assert.equal((await call('update', { routine: 'a', name: 'b' })).status, 'success');
  });
});
