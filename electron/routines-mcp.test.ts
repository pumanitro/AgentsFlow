// The `*_routine` MCP tools, main-process half: raw tool arguments in, an
// envelope out, against a real routines store on a temp file.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRoutinesStore } from './routines-store';
import { handleRoutinesOp, scheduleFromArgs, type RoutinesToolDeps } from './routines-mcp';
import type { TrackedDirectory } from '../shared/types';
import type { RoutineRun } from '../shared/routines';

const T0 = new Date(2026, 9, 11, 12, 0).getTime();   // Sun 11 Oct 2026, 12:00 local
const DIRS = [
  { id: 'dir-atlas', path: '/p/atlas-of-doors', displayName: 'atlas-of-doors' },
  { id: 'dir-abi', path: '/p/abi', displayName: 'abi' },
] as TrackedDirectory[];

function setup(callerDir: string | null = 'dir-atlas') {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routines-mcp-')), 'routines.json');
  const store = createRoutinesStore(file, { now: () => T0 });
  let n = 0;
  const seen = { changes: 0, ran: [] as string[] };
  const deps: RoutinesToolDeps = {
    store,
    getDirectories: () => DIRS,
    callerDirectoryId: () => callerDir,
    runNow: async (id) => { seen.ran.push(id); return { id: 'run-1', routineId: id, slotAt: new Date(T0).toISOString(), trigger: 'manual', status: 'running', startedAt: new Date(T0).toISOString(), conversationId: 'conv-7' } as RoutineRun; },
    now: () => T0,
    newId: () => `r${++n}`,
    onChange: () => { seen.changes++; },
  };
  const call = (op: string, args: Record<string, unknown> = {}) => handleRoutinesOp(op, args, deps) as Promise<any>;
  return { store, seen, call };
}

describe('routine tools', () => {
  it('create defaults to the calling session\'s peer and a daily cadence', async () => {
    const { store, seen, call } = setup();
    const r = await call('create', { name: ' Reddit daily ', prompt: '/reddit-daily-routine', time: '09:00' });
    assert.equal(r.status, 'success');
    assert.equal(r.routine.peer, 'atlas-of-doors');
    assert.equal(r.routine.schedule, '09:00');
    assert.equal(r.routine.nextRunAt, new Date(2026, 9, 12, 9, 0).toISOString());
    assert.deepEqual(store.getRoutine('r1'), {
      id: 'r1', name: 'Reddit daily', directoryId: 'dir-atlas', provider: 'claude', model: undefined, prompt: '/reddit-daily-routine',
      schedule: { cadence: 'daily', time: '09:00' }, icon: 'star', enabled: true,
      createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), enabledAt: new Date(T0).toISOString(),
    });
    assert.equal(seen.changes, 1);
  });

  it('create takes a named peer, a weekday name and the optional fields', async () => {
    const { store, call } = setup();
    const r = await call('create', { name: 'Digest', prompt: 'Summarise the week', directory: 'ABI', cadence: 'weekly', time: '17:30', weekday: 'fri', provider: 'codex', model: 'opus', icon: 'mail', catch_up: false, enabled: false });
    assert.equal(r.status, 'success');
    const saved = store.getRoutine('r1')!;
    assert.equal(saved.directoryId, 'dir-abi');
    assert.deepEqual(saved.schedule, { cadence: 'weekly', time: '17:30', weekday: 5 });
    assert.deepEqual([saved.provider, saved.model, saved.icon, saved.catchUp, saved.enabled], ['codex', 'opus', 'mail', false, false]);
    assert.equal(r.routine.schedule, '17:30 (Fridays)');
    assert.equal(r.routine.nextRun, null);   // paused
  });

  it('create refuses bad input and stores nothing', async () => {
    const { store, seen, call } = setup();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ name: 'x', prompt: 'p' }, /`time` is required/],
      [{ name: 'x', prompt: 'p', time: '9am' }, /time must be HH:MM/],
      [{ name: '', prompt: 'p', time: '09:00' }, /name is required/],
      [{ name: 'x', prompt: ' ', time: '09:00' }, /prompt is required/],
      [{ name: 'x', prompt: 'p', time: '09:00', cadence: 'hourly' }, /cadence must be one of/],
      [{ name: 'x', prompt: 'p', time: '09:00', cadence: 'weekly', weekday: 'someday' }, /weekday must be/],
      [{ name: 'x', prompt: 'p', time: '09:00', cadence: 'monthly', month_days: [31] }, /month days must be 1–28/],
      [{ name: 'x', prompt: 'p', time: '09:00', cadence: 'twiceMonthly', month_days: [5] }, /two different days/],
      [{ name: 'x', prompt: 'p', time: '09:00', directory: 'nope' }, /Unknown peer "nope"/],
      [{ name: 'x', prompt: 'p', time: '09:00', icon: 'unicorn' }, /icon must be one of/],
      [{ name: 'x', prompt: 'p', time: '09:00', provider: 'gpt' }, /provider must be/],
    ];
    for (const [args, re] of cases) {
      const r = await call('create', args);
      assert.equal(r.status, 'failure', JSON.stringify(args));
      assert.match(r.error, re);
    }
    assert.deepEqual(store.listRoutines(), []);
    assert.equal(seen.changes, 0);
  });

  it('create with no peer to default to asks for a directory', async () => {
    const { call } = setup(null);
    const r = await call('create', { name: 'x', prompt: 'p', time: '09:00' });
    assert.equal(r.status, 'failure');
    assert.match(r.error, /`directory` is required/);
  });

  it('update reschedules, renames, moves and pauses by name', async () => {
    const { store, call } = setup();
    await call('create', { name: 'Reddit daily', prompt: '/reddit', time: '09:00' });
    let r = await call('update', { routine: 'reddit DAILY', time: '07:15' });
    assert.deepEqual(store.getRoutine('r1')!.schedule, { cadence: 'daily', time: '07:15' });
    r = await call('update', { routine: 'r1', cadence: 'twiceMonthly', month_days: [3, 17], name: 'Reddit', directory: 'abi' });
    assert.equal(r.status, 'success');
    assert.deepEqual(store.getRoutine('r1')!.schedule, { cadence: 'twiceMonthly', time: '07:15', monthDays: [3, 17] });
    assert.equal(r.routine.peer, 'abi');
    assert.equal(r.routine.schedule, '07:15 (3rd and 17th)');
    // Leaving the month-day cadence drops its days; every2days anchors on today.
    await call('update', { routine: 'Reddit', cadence: 'every2days' });
    assert.deepEqual(store.getRoutine('r1')!.schedule, { cadence: 'every2days', time: '07:15', anchorDate: '2026-10-11' });
    r = await call('update', { routine: 'Reddit', enabled: false });
    assert.equal(store.getRoutine('r1')!.enabled, false);
    assert.equal(r.routine.nextRun, null);
  });

  it('update refuses an unknown routine, an empty patch and a bad schedule', async () => {
    const { store, call } = setup();
    await call('create', { name: 'A', prompt: 'p', time: '09:00' });
    assert.match((await call('update', { routine: 'B', time: '10:00' })).error, /no routine "B"\. Known: A/);
    assert.match((await call('update', { routine: 'A' })).error, /nothing to change/);
    assert.match((await call('update', { routine: 'A', time: '25:00' })).error, /time must be HH:MM/);
    assert.match((await call('update', { routine: 'A', name: '' })).error, /name is required/);
    assert.deepEqual(store.getRoutine('r1')!.schedule, { cadence: 'daily', time: '09:00' });
  });

  it('two routines with one name must be addressed by id', async () => {
    const { call } = setup();
    await call('create', { name: 'Twin', prompt: 'p', time: '09:00' });
    await call('create', { name: 'Twin', prompt: 'q', time: '10:00' });
    const r = await call('delete', { routine: 'twin' });
    assert.equal(r.status, 'failure');
    assert.match(r.error, /2 routines are named "twin" — pass the id instead: r1, r2/);
    assert.equal((await call('delete', { routine: 'r2' })).status, 'success');
  });

  it('list, run and delete', async () => {
    const { store, seen, call } = setup();
    await call('create', { name: 'A', prompt: 'p', time: '09:00' });
    await call('create', { name: 'B', prompt: 'q', time: '10:00', cadence: 'monthly' });
    const l = await call('list');
    assert.equal(l.count, 2);
    assert.deepEqual(l.routines.map((x: any) => [x.name, x.schedule, x.lastRun]), [['A', '09:00', null], ['B', '10:00 (1st)', null]]);
    const run = await call('run', { routine: 'A' });
    assert.deepEqual(run, { status: 'success', routine: { id: 'r1', name: 'A' }, run: { id: 'run-1', status: 'running', conversationId: 'conv-7', error: null } });
    assert.deepEqual(seen.ran, ['r1']);
    const d = await call('delete', { routine: 'A' });
    assert.deepEqual(d, { status: 'success', deleted: { id: 'r1', name: 'A' } });
    assert.deepEqual(store.listRoutines().map((r) => r.name), ['B']);
  });

  it('an unknown operation is a failure, not a throw', async () => {
    const { call } = setup();
    assert.deepEqual(await call('explode'), { status: 'failure', error: 'unknown routines operation "explode"' });
  });

  it('scheduleFromArgs keeps the fields of an unchanged cadence', () => {
    assert.deepEqual(scheduleFromArgs({ time: '08:00' }, { cadence: 'weekly', time: '09:00', weekday: 3 }, T0), { cadence: 'weekly', time: '08:00', weekday: 3 });
    assert.deepEqual(scheduleFromArgs({ weekday: 0 }, { cadence: 'weekly', time: '09:00', weekday: 3 }, T0), { cadence: 'weekly', time: '09:00', weekday: 0 });
  });
});
