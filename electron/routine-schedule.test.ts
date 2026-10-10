import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  addDays, cadenceLabel, dayDistance, dayKeyStartMs, defaultSchedule, formatSlot, localDayKey,
  nextOccurrence, occurrencesBetween, parseTime, routineFloorMs, validateRoutineInput,
} from '../shared/routine-schedule';
import type { RoutineInput, RoutineSchedule } from '../shared/routines';

// Every timestamp is built with the LOCAL constructor so the suite passes in any TZ.
const at = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();
const iso = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(at(y, m, d, hh, mm)).toISOString();
const keys = (slots: string[]) => slots.map((s) => localDayKey(Date.parse(s)));

describe('parseTime / day keys', () => {
  it('parses strict HH:MM and rejects the rest', () => {
    assert.deepEqual(parseTime('09:05'), { hh: 9, mm: 5 });
    assert.deepEqual(parseTime('23:59'), { hh: 23, mm: 59 });
    for (const bad of ['9:00', '24:00', '12:60', '12:00 ', 'ab:cd', '']) assert.equal(parseTime(bad), null, bad);
  });

  it('round-trips a local day key through its local midnight', () => {
    assert.equal(localDayKey(at(2026, 10, 10, 23, 59)), '2026-10-10');
    assert.equal(dayKeyStartMs('2026-10-10'), at(2026, 10, 10));
  });

  it('adds calendar days across month, year and DST boundaries', () => {
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2026-10-24', 2), '2026-10-26');
    assert.equal(addDays('2026-03-28', 2), '2026-03-30');
  });

  it('measures whole calendar days, negative when b is earlier', () => {
    assert.equal(dayDistance('2026-10-10', '2026-10-12'), 2);
    assert.equal(dayDistance('2026-10-12', '2026-10-10'), -2);
    assert.equal(dayDistance('2026-10-20', '2026-11-03'), 14);
    assert.equal(dayDistance('2026-03-25', '2026-04-01'), 7);
  });

  it('routine floor is the later of createdAt and enabledAt', () => {
    assert.equal(routineFloorMs({ createdAt: iso(2026, 10, 1, 14) }), at(2026, 10, 1, 14));
    assert.equal(routineFloorMs({ createdAt: iso(2026, 10, 1), enabledAt: iso(2026, 10, 5, 8) }), at(2026, 10, 5, 8));
    assert.equal(routineFloorMs({ createdAt: iso(2026, 10, 5), enabledAt: iso(2026, 10, 1) }), at(2026, 10, 5));
  });
});

describe('occurrencesBetween', () => {
  it('daily: one slot per day, from inclusive, to exclusive', () => {
    const s: RoutineSchedule = { cadence: 'daily', time: '09:00' };
    const out = occurrencesBetween(s, at(2026, 10, 10, 9), at(2026, 10, 13, 9));
    assert.deepEqual(out, [iso(2026, 10, 10, 9), iso(2026, 10, 11, 9), iso(2026, 10, 12, 9)]);
  });

  it('daily: a window starting after today\'s slot skips it', () => {
    const s: RoutineSchedule = { cadence: 'daily', time: '09:00' };
    assert.deepEqual(occurrencesBetween(s, at(2026, 10, 10, 9, 1), at(2026, 10, 11, 23)), [iso(2026, 10, 11, 9)]);
  });

  it('every2days fires on even distances from the anchor, before it too', () => {
    const s: RoutineSchedule = { cadence: 'every2days', time: '08:30', anchorDate: '2026-10-10' };
    const out = occurrencesBetween(s, at(2026, 10, 5), at(2026, 10, 15));
    assert.deepEqual(keys(out), ['2026-10-06', '2026-10-08', '2026-10-10', '2026-10-12', '2026-10-14']);
    assert.equal(new Date(Date.parse(out[0])).getMinutes(), 30);
  });

  it('every2days keeps parity across a month boundary', () => {
    const s: RoutineSchedule = { cadence: 'every2days', time: '09:00', anchorDate: '2026-10-30' };
    assert.deepEqual(keys(occurrencesBetween(s, at(2026, 10, 29), at(2026, 11, 4))), ['2026-10-30', '2026-11-01', '2026-11-03']);
  });

  it('weekly defaults to Monday and honours an explicit weekday', () => {
    const mon: RoutineSchedule = { cadence: 'weekly', time: '09:00' };
    assert.deepEqual(keys(occurrencesBetween(mon, at(2026, 10, 1), at(2026, 10, 20))), ['2026-10-05', '2026-10-12', '2026-10-19']);
    const sun: RoutineSchedule = { cadence: 'weekly', time: '09:00', weekday: 0 };
    assert.deepEqual(keys(occurrencesBetween(sun, at(2026, 10, 1), at(2026, 10, 20))), ['2026-10-04', '2026-10-11', '2026-10-18']);
  });

  it('twiceMonthly defaults to the 1st and 15th', () => {
    const s: RoutineSchedule = { cadence: 'twiceMonthly', time: '12:00' };
    assert.deepEqual(keys(occurrencesBetween(s, at(2026, 10, 1), at(2026, 12, 1))), ['2026-10-01', '2026-10-15', '2026-11-01', '2026-11-15']);
  });

  it('monthly honours monthDays and defaults to the 1st', () => {
    const s: RoutineSchedule = { cadence: 'monthly', time: '07:00', monthDays: [28] };
    assert.deepEqual(keys(occurrencesBetween(s, at(2026, 1, 1), at(2026, 4, 1))), ['2026-01-28', '2026-02-28', '2026-03-28']);
    const d: RoutineSchedule = { cadence: 'monthly', time: '07:00' };
    assert.deepEqual(keys(occurrencesBetween(d, at(2026, 1, 1), at(2026, 3, 2))), ['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('returns nothing for a bad time, an empty window or a never-firing schedule', () => {
    assert.deepEqual(occurrencesBetween({ cadence: 'daily', time: '9:00' }, at(2026, 10, 1), at(2026, 10, 5)), []);
    assert.deepEqual(occurrencesBetween({ cadence: 'daily', time: '09:00' }, at(2026, 10, 5), at(2026, 10, 5)), []);
    assert.deepEqual(occurrencesBetween({ cadence: 'monthly', time: '09:00', monthDays: [] }, 0, at(2026, 10, 5)), []);
  });

  it('caps at 400 slots', () => {
    const out = occurrencesBetween({ cadence: 'daily', time: '09:00' }, at(2024, 1, 1), at(2027, 1, 1));
    assert.equal(out.length, 400);
    assert.equal(out[0], iso(2024, 1, 1, 9));
  });

  it('stays at the local wall-clock time all year (DST-safe)', () => {
    const out = occurrencesBetween({ cadence: 'daily', time: '09:00' }, at(2026, 1, 1), at(2026, 12, 31));
    assert.equal(out.length, 364);
    for (const s of out) {
      const d = new Date(Date.parse(s));
      assert.equal(`${d.getHours()}:${d.getMinutes()}`, '9:0', s);
    }
  });

  it('a DST change day is 23 or 25 h long, not a shifted slot', (t) => {
    const out = occurrencesBetween({ cadence: 'daily', time: '09:00' }, at(2026, 1, 1), at(2026, 12, 31));
    const gaps = out.slice(1).map((s, i) => (Date.parse(s) - Date.parse(out[i])) / 3_600_000);
    const odd = gaps.filter((h) => h !== 24);
    if (odd.length === 0) {
      t.skip(`no DST in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
      return;
    }
    assert.deepEqual([...new Set(odd)].sort(), [23, 25]);
  });
});

describe('nextOccurrence', () => {
  const daily: RoutineSchedule = { cadence: 'daily', time: '09:00' };

  it('is strictly after the given instant', () => {
    assert.equal(nextOccurrence(daily, at(2026, 10, 10, 9)), iso(2026, 10, 11, 9));
    assert.equal(nextOccurrence(daily, at(2026, 10, 10, 8, 59)), iso(2026, 10, 10, 9));
  });

  it('finds the next monthly slot in a later month', () => {
    assert.equal(nextOccurrence({ cadence: 'monthly', time: '07:00', monthDays: [1] }, at(2026, 10, 10)), iso(2026, 11, 1, 7));
  });

  it('is null when nothing fires within 62 days', () => {
    assert.equal(nextOccurrence({ cadence: 'monthly', time: '07:00', monthDays: [] }, at(2026, 10, 10)), null);
    assert.equal(nextOccurrence({ cadence: 'daily', time: 'bad' }, at(2026, 10, 10)), null);
  });
});

describe('labels', () => {
  it('cadenceLabel speaks each cadence', () => {
    assert.equal(cadenceLabel({ cadence: 'daily', time: '09:00' }), '09:00');
    assert.equal(cadenceLabel({ cadence: 'every2days', time: '09:00', anchorDate: '2026-10-10' }), '09:00 (every 2 days)');
    assert.equal(cadenceLabel({ cadence: 'weekly', time: '09:00' }), '09:00 (Mondays)');
    assert.equal(cadenceLabel({ cadence: 'weekly', time: '18:30', weekday: 0 }), '18:30 (Sundays)');
    assert.equal(cadenceLabel({ cadence: 'twiceMonthly', time: '12:00', monthDays: [15, 1] }), '12:00 (1st and 15th)');
    assert.equal(cadenceLabel({ cadence: 'twiceMonthly', time: '12:00', monthDays: [2, 23] }), '12:00 (2nd and 23rd)');
    assert.equal(cadenceLabel({ cadence: 'monthly', time: '07:00' }), '07:00 (1st)');
    assert.equal(cadenceLabel({ cadence: 'monthly', time: '07:00', monthDays: [11] }), '07:00 (11th)');
  });

  it('formatSlot is local "d Mon HH:MM"', () => {
    assert.equal(formatSlot(iso(2026, 10, 10, 9)), '10 Oct 09:00');
    assert.equal(formatSlot(iso(2026, 1, 3, 7, 5)), '3 Jan 07:05');
    assert.equal(formatSlot('not a date'), 'not a date');
  });

  it('defaultSchedule fills the per-cadence defaults', () => {
    const now = at(2026, 10, 10, 15);
    assert.deepEqual(defaultSchedule('daily', now), { cadence: 'daily', time: '09:00' });
    assert.deepEqual(defaultSchedule('every2days', now), { cadence: 'every2days', time: '09:00', anchorDate: '2026-10-10' });
    assert.deepEqual(defaultSchedule('weekly', now), { cadence: 'weekly', time: '09:00', weekday: 1 });
    assert.deepEqual(defaultSchedule('twiceMonthly', now), { cadence: 'twiceMonthly', time: '09:00', monthDays: [1, 15] });
    assert.deepEqual(defaultSchedule('monthly', now), { cadence: 'monthly', time: '09:00', monthDays: [1] });
  });
});

describe('validateRoutineInput', () => {
  const dirs = [{ id: 'd1' }];
  const ok: RoutineInput = { name: 'Reddit daily', directoryId: 'd1', prompt: '/reddit-daily-routine', schedule: { cadence: 'daily', time: '09:00' } };
  const v = (patch: Partial<RoutineInput>) => validateRoutineInput({ ...ok, ...patch }, dirs);
  const vs = (schedule: RoutineSchedule) => v({ schedule });

  it('accepts a valid input of every cadence', () => {
    assert.equal(v({}), null);
    for (const c of ['daily', 'every2days', 'weekly', 'twiceMonthly', 'monthly'] as const) assert.equal(vs(defaultSchedule(c, at(2026, 10, 10))), null, c);
  });

  it('checks name, directory and prompt', () => {
    assert.equal(v({ name: '   ' }), 'name is required');
    assert.equal(v({ name: 'x'.repeat(61) }), 'name must be 60 characters or fewer');
    assert.equal(v({ name: `  ${'x'.repeat(60)}  ` }), null);
    assert.equal(v({ directoryId: '' }), 'pick a directory');
    assert.equal(v({ directoryId: 'gone' }), 'pick a directory');
    assert.equal(v({ prompt: ' \n' }), 'prompt is required');
  });

  it('checks the schedule shape per cadence', () => {
    assert.equal(vs({ cadence: 'daily', time: '25:00' }), 'time must be HH:MM');
    assert.equal(vs({ cadence: 'weekly', time: '09:00', weekday: 7 }), 'weekday must be 0–6');
    assert.equal(vs({ cadence: 'weekly', time: '09:00', weekday: 1.5 }), 'weekday must be 0–6');
    assert.equal(vs({ cadence: 'monthly', time: '09:00', monthDays: [29] }), 'month days must be 1–28');
    assert.equal(vs({ cadence: 'twiceMonthly', time: '09:00', monthDays: [0, 15] }), 'month days must be 1–28');
    assert.equal(vs({ cadence: 'twiceMonthly', time: '09:00', monthDays: [5, 5] }), 'twice a month needs two different days');
    assert.equal(vs({ cadence: 'twiceMonthly', time: '09:00', monthDays: [5] }), 'twice a month needs two different days');
    assert.equal(vs({ cadence: 'monthly', time: '09:00', monthDays: [1, 15] }), 'monthly needs exactly one day');
    assert.equal(vs({ cadence: 'every2days', time: '09:00', anchorDate: '2026-02-30' }), 'start date must be YYYY-MM-DD');
  });
});
