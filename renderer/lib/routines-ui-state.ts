import { useCallback, useEffect, useState } from 'react';

/**
 * Routines-screen preferences that survive navigation and reload: which range
 * the board shows, which week/month it is parked on, and the open routine.
 * Stored as a single JSON blob under `agentsflow:routines-ui`, same idiom as
 * `ui-state.ts`.
 */
export interface RoutinesUIState {
  range: 'week' | 'month';
  anchorMs: number | null;          // null = follow "now"
  selectedRoutineId: string | null;
}

const STORE_KEY = 'agentsflow:routines-ui';

const DEFAULT: RoutinesUIState = {
  range: 'week',
  anchorMs: null,
  selectedRoutineId: null,
};

const CHANGE_EVENT = 'agentsflow:routines-ui-state';

export function loadRoutinesUIState(): RoutinesUIState {
  if (typeof localStorage === 'undefined') return { ...DEFAULT };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<RoutinesUIState>;
    const next = { ...DEFAULT, ...parsed };
    if (next.range !== 'week' && next.range !== 'month') next.range = DEFAULT.range;
    if (next.anchorMs !== null && !Number.isFinite(next.anchorMs)) next.anchorMs = null;
    if (next.selectedRoutineId !== null && typeof next.selectedRoutineId !== 'string') next.selectedRoutineId = null;
    return next;
  } catch {
    return { ...DEFAULT };
  }
}

export function saveRoutinesUIState(patch: Partial<RoutinesUIState>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const next = { ...loadRoutinesUIState(), ...patch };
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // best-effort
  }
}

/**
 * Read+write a single routines UI key. Starts at the default to avoid SSR
 * hydration mismatches, then hydrates from localStorage on mount.
 */
export function useRoutinesUIState<K extends keyof RoutinesUIState>(
  key: K,
): [RoutinesUIState[K], (v: RoutinesUIState[K]) => void] {
  const [value, setRaw] = useState<RoutinesUIState[K]>(DEFAULT[key]);
  useEffect(() => {
    const read = () => setRaw(loadRoutinesUIState()[key]);
    read();
    window.addEventListener(CHANGE_EVENT, read);
    return () => window.removeEventListener(CHANGE_EVENT, read);
  }, [key]);
  const setValue = useCallback((v: RoutinesUIState[K]) => {
    setRaw(v);
    saveRoutinesUIState({ [key]: v } as Partial<RoutinesUIState>);
  }, [key]);
  return [value, setValue];
}
