/**
 * Argv construction for a `claude --resume` / `--fork-session` PTY.
 *
 * Its own module (rather than inline in pty-manager) so it can be unit-tested
 * without pulling in `electron` and `node-pty`.
 *
 * Everything built here is a per-INVOCATION flag that a resume does NOT inherit
 * from the session it is reopening: the CLI rebuilds its permission mode, its
 * MCP server set and its system prompt from this command line alone, never from
 * the transcript. So each one has to be re-asserted on every resume:
 *
 *  - `--permission-mode` — else the user lands back in default/auto after a
 *    detach + reattach.
 *  - `--mcp-config` — else the `peersflow` MCP server is simply absent: no
 *    `open_file`, no `delegate`, no `list_peers`. The chat looks identical,
 *    which is why this hid for so long — the session just quietly stops
 *    believing Peers Flow can open a file and shells out to `open -a` instead.
 *  - `--append-system-prompt` — else the session boots with no peer registry and
 *    no idea the open_file tool exists.
 *
 * A `claude attach` needs none of this: there the daemon is still the original
 * spawn and carries whatever it was given at spawn time.
 */
export interface ResumeArgsOpts {
  sessionId: string;
  // Fork mode: branch `forkFrom` into the pre-assigned `sessionId`.
  forkFrom?: string;
  mcpConfigPath?: string;
  appendSystemPrompt?: string;
}

export function buildResumeArgs(opts: ResumeArgsOpts): string[] {
  const args = opts.forkFrom
    ? ['--resume', opts.forkFrom, '--fork-session', '--session-id', opts.sessionId, '--permission-mode', 'bypassPermissions']
    : ['--resume', opts.sessionId, '--permission-mode', 'bypassPermissions'];
  if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath);
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  return args;
}

/**
 * The same argv with the system prompt elided. It runs to multi-KB of registry
 * text and the spawn line is logged on every attach — see the log-storm freeze.
 */
export function redactResumeArgs(args: string[]): string[] {
  return args.map((a, i) => (args[i - 1] === '--append-system-prompt' ? `<${a.length} chars>` : a));
}
