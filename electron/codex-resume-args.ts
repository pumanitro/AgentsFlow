/** Config override that stops a Codex TUI from offering to update itself. */
export const CODEX_NO_SELF_UPDATE = ['-c', 'check_for_update_on_startup=false'];

/**
 * Argv construction for the `codex resume` PTY that backs a Codex chat pane.
 *
 * Its own module (rather than inline in pty-manager) for the same reason
 * `resume-args.ts` is: it can be unit-tested without pulling in `electron` and
 * `node-pty`. `pty-manager` re-exports `codexResumeArgs`, so the PTY layer
 * remains the single import site for callers.
 *
 * Unlike `claude --resume`, this command does NOT execute the agent. The thread
 * already lives inside the app-server we own; `--remote` points the TUI at that
 * server's control socket and it becomes one more subscriber to a thread that
 * is running with or without it. So:
 *
 *  - there is nothing per-invocation to re-assert (no permission mode, no MCP
 *    config, no system prompt) — the thread carries all of that from the
 *    options it was started with;
 *  - killing this PTY is a pure DETACH. The thread keeps its turn, and other
 *    clients cannot even observe that a TUI came and went.
 *
 * `--no-alt-screen` is what makes the pane behave like the Claude terminal:
 * the TUI renders inline in the normal buffer, so the app's own scrollback
 * (and the replay buffer a second viewer is rebuilt from) holds the history
 * instead of it vanishing with the alternate screen.
 *
 * `check_for_update_on_startup=false` keeps the TUI from opening on its
 * self-update prompt, whose default answer runs `npm install -g @openai/codex`
 * INSIDE this PTY. The pane's PTY is killed on its last detach, so the install
 * dies half-way and takes the machine's Codex CLI with it (2026-09-18: no
 * `codex` on PATH, every Codex chat exiting 1 on open). Updating is something
 * the user does in their own terminal; see `codex-cli.ts` for why even that
 * cannot reach a running chat.
 */
export function codexResumeArgs(threadId: string, socketPath: string): string[] {
  return ['resume', threadId, '--remote', codexRemoteUrl(socketPath), '--no-alt-screen', ...CODEX_NO_SELF_UPDATE];
}

/**
 * `unix://` + an ABSOLUTE socket path, i.e. three slashes for a real path.
 * A relative path would be resolved against the TUI's cwd — the conversation's
 * directory, never ours — so it is rejected rather than silently mis-targeted.
 */
export function codexRemoteUrl(socketPath: string): string {
  if (!socketPath.startsWith('/')) throw new Error(`codex socket path must be absolute: ${socketPath}`);
  return `unix://${socketPath}`;
}
