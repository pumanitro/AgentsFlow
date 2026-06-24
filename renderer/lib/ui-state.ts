import { useCallback, useEffect, useState } from 'react';

/**
 * App-wide UI preferences that survive navigation and reload.
 * Stored as a single JSON blob under `agentsflow:ui`.
 */
export interface UIState {
  selectedDirId: string | null;
  rightPane: 'chat' | 'file';
  sidebarMode: 'changes' | 'files';
  view: 'home' | 'stats';
}

const STORE_KEY = 'agentsflow:ui';

const DEFAULT: UIState = {
  selectedDirId: null,
  rightPane: 'chat',
  sidebarMode: 'changes',
  view: 'home',
};

export function loadUIState(): UIState {
  if (typeof localStorage === 'undefined') return { ...DEFAULT };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<UIState>;
    return { ...DEFAULT, ...parsed };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveUIState(patch: Partial<UIState>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const current = loadUIState();
    const next = { ...current, ...patch };
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // best-effort
  }
}

/**
 * Read+write a single UI state key. Starts at the default to avoid SSR hydration
 * mismatches, then hydrates from localStorage on mount.
 */
export function useUIState<K extends keyof UIState>(key: K): [UIState[K], (v: UIState[K]) => void] {
  const [value, setRaw] = useState<UIState[K]>(DEFAULT[key]);
  useEffect(() => {
    setRaw(loadUIState()[key]);
  }, [key]);
  // Stable identity (only `key` matters) so consumers can safely use the setter
  // as an effect dependency without it churning on every render.
  const setValue = useCallback((v: UIState[K]) => {
    setRaw(v);
    saveUIState({ [key]: v } as Partial<UIState>);
  }, [key]);
  return [value, setValue];
}

/**
 * Numeric preference scoped to a tracked directory — e.g. shell-area height
 * and sidebar width, which the user wants persisted independently for each
 * project. Falls back to `defaultValue` while no directory key is known
 * (e.g. while the session page is still hydrating its Conversation).
 */
export function useDirectoryNumber(
  directoryKey: string | null | undefined,
  field: string,
  defaultValue: number,
): [number, (v: number) => void] {
  const [value, setRaw] = useState<number>(defaultValue);
  useEffect(() => {
    if (!directoryKey || typeof localStorage === 'undefined') {
      setRaw(defaultValue);
      return;
    }
    try {
      const raw = localStorage.getItem(`agentsflow:dir:${directoryKey}:${field}`);
      if (raw === null) {
        setRaw(defaultValue);
      } else {
        const n = Number(raw);
        setRaw(Number.isFinite(n) ? n : defaultValue);
      }
    } catch {
      setRaw(defaultValue);
    }
  }, [directoryKey, field, defaultValue]);
  const setValue = useCallback((v: number) => {
    setRaw(v);
    if (!directoryKey || typeof localStorage === 'undefined') return;
    try { localStorage.setItem(`agentsflow:dir:${directoryKey}:${field}`, String(v)); } catch {
      // best-effort
    }
  }, [directoryKey, field]);
  return [value, setValue];
}
