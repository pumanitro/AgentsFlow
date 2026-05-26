import { useEffect, useState } from 'react';

/**
 * App-wide UI preferences that survive navigation and reload.
 * Stored as a single JSON blob under `agentsflow:ui`.
 */
export interface UIState {
  selectedDirId: string | null;
  rightPane: 'chat' | 'file';
  sidebarMode: 'changes' | 'files';
  shellHeight: number;
}

const STORE_KEY = 'agentsflow:ui';

const DEFAULT: UIState = {
  selectedDirId: null,
  rightPane: 'chat',
  sidebarMode: 'changes',
  shellHeight: 260,
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
  const setValue = (v: UIState[K]) => {
    setRaw(v);
    saveUIState({ [key]: v } as Partial<UIState>);
  };
  return [value, setValue];
}
