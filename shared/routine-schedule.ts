import type { Routine, RoutineCadence, RoutineInput, RoutineSchedule } from './routines';
import type { TrackedDirectory } from './types';

// Schedule math for routines. Everything is LOCAL calendar time: a slot is
// built with the (y, m, d, hh, mm) constructor, so "09:00 daily" stays 09:00
// on both sides of a DST change instead of drifting by an hour.

const pad2 = (n: number) => String(n).padStart(2, '0');

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_OCCURRENCES = 400;
const NEXT_SEARCH_DAYS = 62;
// Day-loop bound so an open-ended window over a schedule that never fires
// (e.g. monthDays: []) cannot spin forever.
const MAX_SCAN_DAYS = 40_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const DEFAULT_MONTH_DAYS: Record<'monthly' | 'twiceMonthly', number[]> = { monthly: [1], twiceMonthly: [1, 15] };
// An every-2-days schedule without an anchor should not happen (defaultSchedule
// and the store fill it from createdAt); a fixed fallback keeps the parity
// stable across calls instead of shifting with the query window.
const FALLBACK_ANCHOR = '1970-01-01';

/** 'HH:MM' strict, else null. */
export function parseTime(time: string): { hh: number; mm: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time ?? '');
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

/** 'YYYY-MM-DD' in LOCAL time. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local midnight of that day (new Date(y, m-1, d)). */
export function dayKeyStartMs(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Calendar days, DST-safe. */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return localDayKey(new Date(y, m - 1, d + n).getTime());
}

/** Whole calendar days b − a (Date.UTC arithmetic). */
export function dayDistance(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  // UTC has no DST, so the difference is always a whole number of days.
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** max(createdAt, enabledAt ?? 0). */
export function routineFloorMs(r: Pick<Routine, 'createdAt' | 'enabledAt'>): number {
  const created = Date.parse(r.createdAt);
  const enabled = r.enabledAt ? Date.parse(r.enabledAt) : 0;
  return Math.max(Number.isFinite(created) ? created : 0, Number.isFinite(enabled) ? enabled : 0);
}

function firesOn(schedule: RoutineSchedule, key: string, date: Date): boolean {
  switch (schedule.cadence) {
    case 'daily':
      return true;
    case 'every2days': {
      const d = dayDistance(schedule.anchorDate ?? FALLBACK_ANCHOR, key);
      // Days before the anchor give negative distances; JS % keeps the sign.
      return ((d % 2) + 2) % 2 === 0;
    }
    case 'weekly':
      return date.getDay() === (schedule.weekday ?? 1);
    case 'twiceMonthly':
    case 'monthly':
      return (schedule.monthDays ?? DEFAULT_MONTH_DAYS[schedule.cadence]).includes(date.getDate());
    default:
      return false;
  }
}

/** Slots of `schedule` with fromMs ≤ slot < toMs, ascending ISO (UTC) strings. Local-time construction (new Date(y,m,d,hh,mm)) so DST days are right. Hard cap 400. */
export function occurrencesBetween(schedule: RoutineSchedule, fromMs: number, toMs: number): string[] {
  const t = parseTime(schedule.time);
  if (!t || !(fromMs < toMs)) return [];
  const out: string[] = [];
  const lastKey = localDayKey(toMs);
  const [y, m, d] = localDayKey(fromMs).split('-').map(Number);
  for (let i = 0; i < MAX_SCAN_DAYS && out.length < MAX_OCCURRENCES; i++) {
    const day = new Date(y, m - 1, d + i);
    const key = localDayKey(day.getTime());
    if (key > lastKey) break;
    if (!firesOn(schedule, key, day)) continue;
    const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), t.hh, t.mm).getTime();
    if (slot >= fromMs && slot < toMs) out.push(new Date(slot).toISOString());
  }
  return out;
}

/** Strictly after; searches ≤ 62 days. */
export function nextOccurrence(schedule: RoutineSchedule, afterMs: number): string | null {
  const until = dayKeyStartMs(addDays(localDayKey(afterMs), NEXT_SEARCH_DAYS + 1));
  return occurrencesBetween(schedule, afterMs + 1, until)[0] ?? null;
}

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** '09:00' | '09:00 (every 2 days)' | '09:00 (Mondays)' | '12:00 (1st and 15th)' | '07:00 (1st)' */
export function cadenceLabel(schedule: RoutineSchedule): string {
  const time = schedule.time;
  switch (schedule.cadence) {
    case 'daily':
      return time;
    case 'every2days':
      return `${time} (every 2 days)`;
    case 'weekly':
      return `${time} (${WEEKDAYS_PLURAL[schedule.weekday ?? 1] ?? WEEKDAYS_PLURAL[1]})`;
    case 'twiceMonthly':
    case 'monthly': {
      const days = [...(schedule.monthDays ?? DEFAULT_MONTH_DAYS[schedule.cadence])].sort((a, b) => a - b);
      return `${time} (${days.map(ordinal).join(' and ')})`;
    }
    default:
      return time;
  }
}

/** '10 Oct 09:00' local, en-GB-ish, no year. */
export function formatSlot(slotIso: string): string {
  const ms = Date.parse(slotIso);
  if (!Number.isFinite(ms)) return slotIso;
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** time '09:00', weekday 1, monthDays [1]/[1,15], anchorDate = localDayKey(nowMs). */
export function defaultSchedule(cadence: RoutineCadence, nowMs: number): RoutineSchedule {
  const time = '09:00';
  switch (cadence) {
    case 'every2days':
      return { cadence, time, anchorDate: localDayKey(nowMs) };
    case 'weekly':
      return { cadence, time, weekday: 1 };
    case 'twiceMonthly':
    case 'monthly':
      return { cadence, time, monthDays: [...DEFAULT_MONTH_DAYS[cadence]] };
    default:
      return { cadence, time };
  }
}

function isDayKey(key: string): boolean {
  const m = DAY_KEY.exec(key);
  if (!m) return false;
  // Round-trip through the constructor to reject 2026-02-30 and friends.
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

/** null = ok, else a one-line human message. Checks: name 1..60 after trim; directoryId ∈ dirs; prompt non-empty; schedule shape per cadence (time parses; weekday 0..6; monthDays 1..28, 1 or 2 distinct entries; anchorDate 'YYYY-MM-DD'). */
export function validateRoutineInput(input: RoutineInput, dirs: Pick<TrackedDirectory, 'id'>[]): string | null {
  const name = (input.name ?? '').trim();
  if (!name) return 'name is required';
  if (name.length > 60) return 'name must be 60 characters or fewer';
  if (!input.directoryId || !dirs.some((d) => d.id === input.directoryId)) return 'pick a directory';
  if (!(input.prompt ?? '').trim()) return 'prompt is required';
  const s = input.schedule;
  if (!s) return 'schedule is required';
  if (!parseTime(s.time)) return 'time must be HH:MM';
  switch (s.cadence) {
    case 'daily':
      return null;
    case 'every2days':
      if (s.anchorDate !== undefined && !isDayKey(s.anchorDate)) return 'start date must be YYYY-MM-DD';
      return null;
    case 'weekly':
      if (s.weekday !== undefined && !(Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6)) return 'weekday must be 0–6';
      return null;
    case 'twiceMonthly':
    case 'monthly': {
      if (s.monthDays === undefined) return null;
      if (!s.monthDays.every((d) => Number.isInteger(d) && d >= 1 && d <= 28)) return 'month days must be 1–28';
      if (s.cadence === 'monthly') return s.monthDays.length === 1 ? null : 'monthly needs exactly one day';
      if (s.monthDays.length !== 2 || s.monthDays[0] === s.monthDays[1]) return 'twice a month needs two different days';
      return null;
    }
    default:
      return 'unknown cadence';
  }
}
