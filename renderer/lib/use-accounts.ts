import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './ipc';
import type { AccountsSnapshot } from '../../shared/types';

/**
 * The accounts snapshot, live.
 *
 * Everything account-shaped in the UI (the Claude pool and which of it is
 * active, the Codex pool and which of it is the CLI's login) reads from one
 * place so the Usage pane and the Accounts panel can never disagree.
 *
 * Tolerates an older preload in two ways: a missing `listAccounts` leaves the
 * defaults in place instead of throwing, and a snapshot that predates the
 * provider fields is filled in as Claude-only — the renderer is shipped inside
 * the app, but a stale Electron main process is a normal dev state.
 */
export const EMPTY_ACCOUNTS: AccountsSnapshot = {
  accounts: [],
  activeId: null,
  codexAccounts: [],
  activeCodexId: null,
};

export function normaliseAccounts(s: Partial<AccountsSnapshot> | null | undefined): AccountsSnapshot {
  return {
    accounts: s?.accounts ?? [],
    activeId: s?.activeId ?? null,
    authIssue: s?.authIssue ?? null,
    codexAccounts: s?.codexAccounts ?? [],
    activeCodexId: s?.activeCodexId ?? null,
  };
}

export function useAccountsSnapshot(): { snapshot: AccountsSnapshot; reload: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState<AccountsSnapshot>(EMPTY_ACCOUNTS);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    const a = api();
    if (typeof a.listAccounts !== 'function') return;
    try {
      const s = await a.listAccounts();
      if (mounted.current) setSnapshot(normaliseAccounts(s));
    } catch { /* keep the previous value */ }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    const a = api();
    const off = typeof a.onAccountsUpdated === 'function'
      ? a.onAccountsUpdated((s) => { if (mounted.current) setSnapshot(normaliseAccounts(s)); })
      : undefined;
    return () => { mounted.current = false; off?.(); };
  }, [reload]);

  return { snapshot, reload };
}
