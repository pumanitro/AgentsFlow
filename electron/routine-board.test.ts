import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildDayCells, dayKeysOfMonthGrid, dayKeysOfWeek, markStatusFor } from '../shared/routine-board';
import { CATCHUP_WINDOW_MS } from '../shared/routines';
import type { Routine, RoutineRun, RoutineSchedule } from '../shared/routines';

// Local-constructor timestamps keep the suite TZ-independent.
const at = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();
const iso = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(at(y, m, d, hh, mm)).toISOString();

const routine = (id: string, schedule: RoutineSchedule, extra: Partial<Routine> = {}): Routine => ({
  id, name: id, directoryId: 'd1', provider: 'claude', prompt: '/x', schedule, icon: 'star', enabled: true,
  createdAt: iso(2026, 9, 1), updatedAt: iso(2026, 9, 1), ...extra,
});
const run = (routineId: string, slotAt: string, status: RoutineRun['status'], extra: Partial<RoutineRun> = {}): RoutineRun => ({
  id: `${routineId}@${slotAt}`, routineId, slotAt, trigger: 'schedule', status, startedAt: slotAt, ...extra,
});
const daily = (time = '09:00'): RoutineSchedule => ({ cadence: 'daily', time });
const cell = (cells: ReturnType<typeof buildDayCells>, key: string) => cells.find((c) => c.dayKey === key)!;

describe('day key grids', () => {
  it('week runs Monday..Sunday around a mid-week anchor', () => {
    assert.deepEqual(dayKeysOfWeek(at(2026, 10, 10, 15)), [
      '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11',
    ]);
  });

  it('a Sunday belongs to the week that started the previous Monday', () => {
    assert.equal(dayKeysOfWeek(at(2026, 10, 11, 23))[0], '2026-10-05');
    assert.equal(dayKeysOfWeek(at(2026, 10, 12))[0], '2026-10-12');
  });

  it('a week spanning the autumn DST change still has 7 distinct days', () => {
    const w = dayKeysOfWeek(at(2026, 10, 25, 12));
    assert.deepEqual(w, ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  });

  it('month grid is 42 keys from the Monday on or before the 1st', () => {
    const g = dayKeysOfMonthGrid(at(2026, 10, 20));
    assert.equal(g.length, 42);
    assert.equal(g[0], '2026-09-28');
    assert.equal(g[41], '2026-11-08');
    assert.equal(new Set(g).size, 42);
    // June 2026 starts on a Monday: the grid starts on the 1st itself.
    assert.equal(dayKeysOfMonthGrid(at(2026, 6, 15))[0], '2026-06-01');
  });
});

describe('markStatusFor', () => {
  const now = at(2026, 10, 10, 12);

  it('a run always wins', () => {
    assert.equal(markStatusFor(run('a', iso(2026, 10, 1, 9), 'failed'), at(2026, 10, 1, 9), now, true), 'failed');
    assert.equal(markStatusFor(run('a', iso(2026, 10, 11, 9), 'running'), at(2026, 10, 11, 9), now, false), 'running');
  });

  it('a future slot is scheduled', () => {
    assert.equal(markStatusFor(undefined, at(2026, 10, 11, 9), now, true), 'scheduled');
  });

  it('a past slot is scheduled while catch-up can still run it, then missed', () => {
    assert.equal(markStatusFor(undefined, now - CATCHUP_WINDOW_MS + 1, now, true), 'scheduled');
    assert.equal(markStatusFor(undefined, now - CATCHUP_WINDOW_MS, now, true), 'missed');
    assert.equal(markStatusFor(undefined, at(2026, 10, 10, 9), now, false), 'missed');
  });
});

describe('buildDayCells', () => {
  const now = at(2026, 10, 10, 12);   // Saturday
  const week = dayKeysOfWeek(now);

  it('flags today and the past', () => {
    const cells = buildDayCells([], [], week, now);
    assert.deepEqual(cells.map((c) => c.dayKey), week);
    assert.equal(cell(cells, '2026-10-10').isToday, true);
    assert.equal(cell(cells, '2026-10-09').isPast, true);
    assert.equal(cell(cells, '2026-10-11').isPast, false);
  });

  it('joins runs to occurrences and derives statuses for the rest', () => {
    const r = routine('reddit', daily());
    const runs = [run('reddit', iso(2026, 10, 8, 9), 'success'), run('reddit', iso(2026, 10, 10, 9), 'running')];
    const cells = buildDayCells([r], runs, week, now);
    const st = (k: string) => cell(cells, k).dailies.map((m) => m.status);
    assert.deepEqual(st('2026-10-08'), ['success']);
    assert.equal(cell(cells, '2026-10-08').dailies[0].run, runs[0]);
    assert.deepEqual(st('2026-10-07'), ['missed']);
    assert.deepEqual(st('2026-10-10'), ['running']);
    assert.deepEqual(st('2026-10-11'), ['scheduled']);
  });

  it('joins a run whose slotAt was written without milliseconds', () => {
    const r = routine('reddit', daily());
    const slot = iso(2026, 10, 9, 9).replace('.000Z', 'Z');
    const cells = buildDayCells([r], [run('reddit', slot, 'success')], week, now);
    assert.deepEqual(cell(cells, '2026-10-09').dailies.map((m) => m.status), ['success']);
  });

  it('shows nothing from before the routine existed', () => {
    const r = routine('seed', daily(), { createdAt: iso(2026, 10, 10, 14) });
    const cells = buildDayCells([r], [], week, at(2026, 10, 10, 15));
    assert.deepEqual(week.map((k) => cell(cells, k).dailies.length), [0, 0, 0, 0, 0, 0, 1]);
    assert.equal(cell(cells, '2026-10-11').dailies[0].status, 'scheduled');
  });

  it('a re-enable moves the floor: earlier slots vanish but their runs still show', () => {
    const r = routine('r', daily(), { enabledAt: iso(2026, 10, 8, 10) });
    const cells = buildDayCells([r], [run('r', iso(2026, 10, 6, 9), 'success')], week, now);
    assert.deepEqual(week.map((k) => cell(cells, k).dailies.length), [0, 1, 0, 0, 1, 1, 1]);
    assert.equal(cell(cells, '2026-10-09').dailies[0].status, 'missed');
  });

  it('a paused routine has no scheduled/missed marks, only its recorded runs', () => {
    const r = routine('p', daily(), { enabled: false });
    const cells = buildDayCells([r], [run('p', iso(2026, 10, 7, 9), 'failed')], week, now);
    assert.deepEqual(week.map((k) => cell(cells, k).dailies.length), [0, 0, 1, 0, 0, 0, 0]);
    assert.equal(cell(cells, '2026-10-07').dailies[0].status, 'failed');
  });

  it('manual runs land in their routine\'s cadence bucket on their day', () => {
    const r = routine('w', { cadence: 'weekly', time: '09:00' });
    const manual = run('w', iso(2026, 10, 9, 16, 42), 'success', { trigger: 'manual' });
    const cells = buildDayCells([r], [manual], week, now);
    assert.deepEqual(cell(cells, '2026-10-09').weekly.map((m) => m.run?.trigger), ['manual']);
    assert.deepEqual(cell(cells, '2026-10-05').weekly.map((m) => m.status), ['missed']);
  });

  it('runs of a deleted routine and runs outside the days are dropped', () => {
    const r = routine('r', daily());
    const cells = buildDayCells([r], [run('gone', iso(2026, 10, 7, 9), 'success'), run('r', iso(2026, 9, 1, 9), 'success')], week, now);
    const all = cells.flatMap((c) => [...c.dailies, ...c.every2days, ...c.weekly, ...c.twiceMonthly, ...c.monthly]);
    assert.equal(all.length, 7);
    assert.ok(all.every((m) => m.routine.id === 'r'));
  });

  it('buckets each cadence separately', () => {
    const rs = [
      routine('d', daily()),
      routine('e', { cadence: 'every2days', time: '09:00', anchorDate: '2026-10-05' }),
      routine('w', { cadence: 'weekly', time: '09:00', weekday: 3 }),
      routine('t', { cadence: 'twiceMonthly', time: '09:00', monthDays: [1, 8] }),
      routine('m', { cadence: 'monthly', time: '09:00', monthDays: [9] }),
    ];
    const cells = buildDayCells(rs, [], week, now);
    const count = (b: 'dailies' | 'every2days' | 'weekly' | 'twiceMonthly' | 'monthly') =>
      week.map((k) => cell(cells, k)[b].length).join('');
    assert.equal(count('dailies'), '1111111');
    assert.equal(count('every2days'), '1010101');
    assert.equal(count('weekly'), '0010000');
    assert.equal(count('twiceMonthly'), '0001000');
    assert.equal(count('monthly'), '0000100');
  });

  it('sorts by slot time, then routine name', () => {
    const rs = [routine('zeta', daily('08:00')), routine('beta', daily('09:00')), routine('alpha', daily('09:00'))];
    const cells = buildDayCells(rs, [], week, now);
    assert.deepEqual(cell(cells, '2026-10-11').dailies.map((m) => m.routine.name), ['zeta', 'alpha', 'beta']);
  });

  it('daily score counts routines with a slot that day and their successes', () => {
    const rs = [routine('a', daily()), routine('b', daily()), routine('c', daily('18:00'))];
    const runs = [
      run('a', iso(2026, 10, 10, 9), 'success'),
      run('b', iso(2026, 10, 10, 9), 'failed'),
      // A manual re-run of b that day: still one segment, now a success.
      run('b', iso(2026, 10, 10, 11), 'success', { trigger: 'manual' }),
    ];
    const cells = buildDayCells(rs, runs, week, now);
    assert.deepEqual(cell(cells, '2026-10-10').score, { done: 2, total: 3 });
    assert.deepEqual(cell(cells, '2026-10-11').score, { done: 0, total: 3 });
  });

  it('keeps the caller\'s day order on a 42-day month grid', () => {
    const grid = dayKeysOfMonthGrid(now);
    const cells = buildDayCells([routine('d', daily())], [], grid, now);
    assert.deepEqual(cells.map((c) => c.dayKey), grid);
    assert.ok(cells.every((c) => c.dailies.length === 1));
  });
});
