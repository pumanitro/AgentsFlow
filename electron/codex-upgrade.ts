// Moving the running Codex app-server onto a newer CLI.
//
// The server is pinned to the CLI it was started with (codex-cli.ts), which is
// what keeps a global update from reaching open chats. Left at that, the app
// would sit on an old Codex until something else restarted the server. This is
// the other half: when the machine has a newer healthy install, restart the
// server onto it — but only while nothing is running, because a restart ends
// any turn in flight and closes any open Codex pane.
//
// Threads are not lost by it: each lives in its rollout file and is resumed the
// next time its row is opened, exactly as after an app restart.

export interface CodexUpgradeDeps {
  /** Version the running server reports; null when no server is running, '' when it will not say. */
  serverVersion(): Promise<string | null>;
  /** A different healthy install to move to, or null (see `codexUpgradeAvailable`). */
  available(serverVersion: string): Promise<{ from: string; to: string } | null>;
  /** Why the server cannot be restarted right now, or null when it can. */
  busy(): Promise<string | null>;
  /** Restart the server; the new one pins the current install. */
  restart(note: string): Promise<void>;
  log(message: string, detail?: Record<string, unknown>): void;
}

export type CodexUpgradeOutcome =
  | { kind: 'none' }
  | { kind: 'deferred'; to: string; reason: string }
  | { kind: 'upgraded'; from: string; to: string }
  | { kind: 'failed'; to: string; error: string };

export const upgradeNote = (to: string): string => `Codex updated to ${to} — reopen to continue`;

// Only a change is worth a log line: this runs every few minutes, for days.
let lastLogged = '';
function logOnce(deps: CodexUpgradeDeps, message: string, detail: Record<string, unknown>): void {
  const line = `${message} ${JSON.stringify(detail)}`;
  if (line === lastLogged) return;
  lastLogged = line;
  deps.log(message, detail);
}

export async function upgradeCodexWhenIdle(deps: CodexUpgradeDeps): Promise<CodexUpgradeOutcome> {
  const serverVersion = await deps.serverVersion();
  // No server: nothing to restart, and the next one to start pins today's install anyway.
  if (!serverVersion) return { kind: 'none' };
  const upgrade = await deps.available(serverVersion);
  if (!upgrade) return { kind: 'none' };
  const reason = await deps.busy();
  if (reason) {
    logOnce(deps, 'a newer Codex is installed; waiting for Codex to be idle', { ...upgrade, reason });
    return { kind: 'deferred', to: upgrade.to, reason };
  }
  try {
    await deps.restart(upgradeNote(upgrade.to));
    const running = await deps.serverVersion();
    if (running !== upgrade.to) throw new Error(`the restarted server reports ${running || 'no version'}`);
    logOnce(deps, 'moved the Codex app-server to the newly installed CLI', { ...upgrade });
    return { kind: 'upgraded', ...upgrade };
  } catch (error) {
    const message = (error as Error).message;
    logOnce(deps, 'could not move the Codex app-server to the new CLI', { ...upgrade, error: message });
    return { kind: 'failed', to: upgrade.to, error: message };
  }
}
