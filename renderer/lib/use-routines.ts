import { useCallback, useEffect, useRef, useState } from 'react';
import type { Routine, RoutineRun, RoutinesSnapshot } from '../../shared/routines';
import { api } from './ipc';

// How often "now" is re-derived locally so today rolls over without a push.
const CLOCK_RESYNC_MS = 30_000;

export interface UseRoutines {
  routines: Routine[];
  runs: RoutineRun[];
  nowMs: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Routines + runs from main: one `listRoutines` on mount, then every
 * `onRoutinesUpdated` push replaces the snapshot. `nowMs` follows main's clock
 * (the snapshot's `now`) and is advanced locally by the elapsed time between
 * snapshots, so renderer and main agree on "today".
 */
export function useRoutines(): UseRoutines {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Main's clock minus ours at the last snapshot; applied on every local tick.
  const skewRef = useRef(0);

  const apply = useCallback((snap: RoutinesSnapshot) => {
    setRoutines(snap.routines);
    setRuns(snap.runs);
    const mainNow = Date.parse(snap.now);
    const local = Date.now();
    skewRef.current = Number.isFinite(mainNow) ? mainNow - local : 0;
    setNowMs(local + skewRef.current);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await api().listRoutines());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    let alive = true;
    api().listRoutines()
      .then((snap) => { if (alive) { apply(snap); setError(null); } })
      .catch((e) => { if (alive) setError(errorMessage(e)); })
      .finally(() => { if (alive) setLoading(false); });
    const off = api().onRoutinesUpdated((snap) => { if (alive) { apply(snap); setLoading(false); } });
    return () => { alive = false; off(); };
  }, [apply]);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now() + skewRef.current), CLOCK_RESYNC_MS);
    return () => clearInterval(t);
  }, []);

  return { routines, runs, nowMs, loading, error, refresh };
}

/** Move an anchor by whole weeks or calendar months (local time, day clamped to the target month). */
export function shiftAnchor(anchorMs: number, range: 'week' | 'month', dir: -1 | 1): number {
  const d = new Date(anchorMs);
  if (range === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * dir, 12).getTime();
  // Day 1 of the target month: the month calendar only cares which month it is.
  return new Date(d.getFullYear(), d.getMonth() + dir, 1, 12).getTime();
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '6 – 12 Oct 2026' · '29 Sep – 5 Oct 2026' · '29 Dec 2026 – 4 Jan 2027' for a week; 'October 2026' for a month. */
export function rangeLabel(anchorMs: number, range: 'week' | 'month'): string {
  const a = new Date(anchorMs);
  if (range === 'month') return `${MONTHS_LONG[a.getMonth()]} ${a.getFullYear()}`;
  const offset = (a.getDay() + 6) % 7;                 // Monday = 0
  const mon = new Date(a.getFullYear(), a.getMonth(), a.getDate() - offset);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  if (mon.getFullYear() !== sun.getFullYear()) {
    return `${mon.getDate()} ${MONTHS_SHORT[mon.getMonth()]} ${mon.getFullYear()} – ${sun.getDate()} ${MONTHS_SHORT[sun.getMonth()]} ${sun.getFullYear()}`;
  }
  if (mon.getMonth() !== sun.getMonth()) {
    return `${mon.getDate()} ${MONTHS_SHORT[mon.getMonth()]} – ${sun.getDate()} ${MONTHS_SHORT[sun.getMonth()]} ${sun.getFullYear()}`;
  }
  return `${mon.getDate()} – ${sun.getDate()} ${MONTHS_SHORT[sun.getMonth()]} ${sun.getFullYear()}`;
}

/** A rejected IPC promise's message, without Electron's "Error invoking remote method 'x': Error: " prefix. */
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
