export interface TrackedDirectory {
  id: string;
  path: string;
  displayName: string;
  addedAt: string;
}

// test
export interface Conversation {
  id: string;
  sessionId: string;
  daemonShort: string;
  sessionName: string;
  directoryId: string;
  directoryPath: string;
  displayName: string;
  title: string;
  description: string;
  pinned: boolean;
  attachments?: string[];
  state: string;
  status: string;
  intent: string;
  createdAt: string;
  // ISO timestamp of the most recent pin→unpin transition. In AgentsFlow an
  // unpinned conversation means the task is considered "done", so this doubles
  // as the completion time. Undefined while still pinned / never unpinned.
  unpinnedAt?: string;
  lastPrompt: string;
  // Set when this conversation was spawned by a peer delegation (the `delegate`
  // MCP tool). Holds the id of the *root* conversation that requested it, so the
  // UI can nest it under its parent and the root's session view can show a live
  // "a peer is working" banner. Undefined for normal user-spawned conversations.
  delegatedByConversationId?: string;
  // Set when this conversation is a fork of another session. `sessionId` is
  // pre-assigned at fork time (passed to the CLI via `--session-id`), but the
  // transcript only materializes on first attach, which runs
  // `claude --resume <forkFromSessionId> --fork-session`. The field stays set —
  // attach routing checks the transcript file on disk to decide whether the
  // fork still needs to be performed, so a failed fork just retries.
  forkFromSessionId?: string;
  // Absolute path of the git worktree this chat is working inside, when that
  // differs from the peer's own directory. Nothing needs to observe worktree
  // *creation* to know this: a session that enters a worktree reports the new
  // cwd, so the association is simply read off the session rather than tracked.
  // Two sources, in order of authority:
  //   1. `claude agents --json` → row.cwd, while the daemon is alive (the
  //      poller reconciles it every tick, so a chat that moves is followed);
  //   2. the transcript's most recent `cwd`, backfilled lazily for chats whose
  //      daemon has already exited.
  // Persisted so the association outlives the process that established it.
  // Undefined means "the peer's own working tree" — the default.
  worktreePath?: string;
}

export interface PinnedDivider {
  id: string;
  title: string;
  createdAt: string;
}

// A plain task row in the pinned list — scoped to a peer but with no agent
// session behind it. Lives alongside conversations/dividers in `pinnedOrder`;
// marking it done removes it from the list and surfaces it in History (the
// same lifecycle as unpinning a conversation), from where it can be restored.
export interface PinnedTodo {
  id: string;
  // The peer this task belongs to (TrackedDirectory.id).
  directoryId: string;
  // Single text field — todos have no title/description split.
  text: string;
  createdAt: string;
  done: boolean;
  // When it was last marked done; mirrors Conversation.unpinnedAt and drives
  // the History timeline bucket. Cleared again on undo/restore.
  doneAt?: string;
}

export type PinnedItemRef =
  | { kind: 'conversation'; id: string }
  | { kind: 'divider'; id: string }
  | { kind: 'todo'; id: string };

// A slash command / skill discoverable under a `.claude` directory. Surfaced
// in the Spawn bar's autocomplete when the prompt starts with "/".
export interface SlashCommand {
  // The base name without extension, e.g. "smart-commit". For nested command
  // folders this is namespaced with ":" (e.g. "git:commit").
  name: string;
  // What gets inserted into the prompt, e.g. "/smart-commit".
  invocation: string;
  // One-line summary pulled from YAML frontmatter `description:` if present,
  // otherwise the first non-empty line of the file.
  description: string;
  // Where it was found. Project (the spawn target's .claude) shadows user (~/.claude).
  scope: 'project' | 'user';
  // A plain command (.claude/commands/*.md) or a skill (.claude/skills/*/SKILL.md).
  kind: 'command' | 'skill';
  // Absolute path to the backing file.
  source: string;
}

export interface SpawnRequest {
  directoryId: string;
  prompt: string;
  attachments?: string[];
  // Model alias passed straight to `claude --model` (e.g. 'fable', 'opus',
  // 'sonnet', 'haiku'). Omitted ⇒ the session uses the user's configured default.
  model?: string;
}

export interface SpawnResult {
  conversationId: string;
  sessionId: string;
  daemonShort: string;
}

// Payload broadcast to the renderer when a file should be opened in the app's
// file view. `filePath` is absolute. When `conversationId` is set, the file
// belongs to that conversation's directory, so the renderer opens it inside that
// session's file pane (which keeps the Chat/File toggle) instead of the
// standalone directory Preview page.
export interface OpenFileNavPayload {
  directoryId: string;
  conversationId?: string;
  filePath: string;
  line?: number;
}

// ---- Peers Flow MCP server (peer awareness + delegation) -------------------

export interface McpToolSummary {
  // Fully-qualified tool name as the peer would call it, e.g.
  // "mcp__peersflow__delegate".
  name: string;
  title: string;
  description: string;
  usage: string;
}

export interface McpPeerSummary {
  id: string;
  displayName: string;
  path: string;
  exists: boolean;
  // True when the directory has its own `.mcp.json` (its own connections).
  hasProjectMcp: boolean;
  // Names of the skills/commands this peer exposes.
  skills: string[];
}

// Everything the "MCP server" preview modal needs: connection details, the
// tools the server exposes, and a snapshot of the current peer registry.
/**
 * Liveness of the delegation bridge — the unix-domain socket the MCP server
 * calls back on to spawn *tracked, watchable* peer sessions. When it is down,
 * `delegate` silently degrades to a headless `claude -p` (no sub-peer row, not
 * watchable), so the UI surfaces this so a dead bridge is never invisible.
 */
export interface BridgeHealth {
  socketPath: string;
  // The main-process server reports itself as accepting connections.
  listening: boolean;
  // The socket file is present on disk. A bound-but-unlinked socket is
  // unreachable by any NEW client (ENOENT on connect) even while `listening` is
  // true — that exact split is the failure that silently disables delegation.
  socketFileExists: boolean;
  // Both of the above: the bridge is actually reachable by the MCP server.
  healthy: boolean;
}

export interface McpServerInfo {
  serverName: string;
  // Whether the compiled server script is present on disk (wired into spawns).
  connected: boolean;
  scriptPath: string;
  configPath: string;
  // The exact `--mcp-config` JSON every spawned session loads.
  configJson: string;
  tools: McpToolSummary[];
  peers: McpPeerSummary[];
  // Live delegation-bridge liveness (set by the `mcp:info` IPC handler).
  bridge?: BridgeHealth;
}

// ---- Plan usage meters -----------------------------------------------------
// One usage limit as shown on Claude's Usage screen, normalised from the
// `/api/oauth/usage` endpoint's `limits[]`. `group` splits the rolling session
// window from the weekly windows; `severity` drives the bar colour.
export interface UsageMeter {
  // Stable identity for React keys: 'session' | 'weekly_all' | 'weekly:<model>'.
  key: string;
  // Human label: 'Current session' | 'All models' | a model name like 'Fable'.
  label: string;
  group: 'session' | 'weekly';
  // Percent of the window consumed, 0–100 (rounded).
  percent: number;
  severity: 'normal' | 'warning' | 'danger';
  // ISO timestamp when this window resets, or null if the API omitted it.
  resetsAt: string | null;
  // Whether this is currently the binding limit (per the API).
  isActive: boolean;
}

export interface UsageSnapshot {
  meters: UsageMeter[];
  // ISO timestamp of when this data was fetched (for the "updated" line).
  fetchedAt: string;
  // Plan tag, e.g. 'Max (20x)' — best-effort from the stored subscription info.
  plan?: string;
}

export type UsageResult =
  | { ok: true; snapshot: UsageSnapshot }
  // `reason` lets the UI pick the right empty state without string-matching:
  //  - no-auth : no Claude Code credentials on this machine
  //  - expired : the token was rejected (401/403)
  //  - network : the request itself failed (offline, DNS, timeout)
  //  - unknown : reachable but unexpected status/body
  | { ok: false; reason: 'no-auth' | 'expired' | 'network' | 'unknown'; error: string };

// ---- Account pool ----------------------------------------------------------
// One Anthropic account in the switchable pool. Each has its own isolated
// credential home (`configDir`), which Claude Code keys its keychain slot off —
// so `configDir` is permanent: moving it orphans that account's credentials.
export interface Account {
  id: string;
  // The address this account signs in with — any domain, Google Workspace
  // included. Also its label in the UI and the value verified against
  // `claude auth status` after login.
  email: string;
  // Vault path passed as CLAUDE_CONFIG_DIR. Permanent — see above.
  configDir: string;
  // Identity as reported by the CLI after a successful login. `accountUuid` is
  // what makes the duplicate guard reliable (two labels, one real account).
  accountUuid?: string;
  orgId?: string;
  // 'max' | 'pro' | … straight from `claude auth status --json`.
  subscriptionType?: string;
  addedAt: string;
  // Set (to a human-readable reason) while this account's stored sign-in is
  // known dead — its refresh token was rejected by the token server, so nothing
  // short of a fresh login brings it back. Runtime-only: filled into snapshots
  // by the main process, never persisted.
  needsLogin?: string;
}

export interface AccountsSnapshot {
  accounts: Account[];
  // Which account's credentials currently sit in the slot Claude Code reads.
  // null when the pool has never been switched into (the pre-existing login is
  // still in place and is not part of the pool).
  activeId: string | null;
  // Set only when the active account's sign-in is broken in a way the app cannot
  // repair by itself. Divergence between the two copies of a token is fixed
  // silently on a timer; this is reserved for "there is nothing left to restore",
  // which is the one case that really does need the user.
  authIssue?: string | null;
}

// Started an add: the caller opens a terminal on `shellId` (the login command is
// already queued to run in it) and then polls `probeAccount(pendingId)`.
export type AddAccountResult =
  // `cwd` is where the login terminal opens — the renderer has no way to
  // resolve a home directory itself, and the shell attach rejects a fake path.
  | { ok: true; pendingId: string; shellId: string; email: string; cwd: string }
  | { ok: false; error: string };

// Polled while the login terminal is open. 'pending' means the browser flow has
// not completed yet; the two rejections tear the half-made vault back down.
export type ProbeAccountResult =
  | { status: 'pending' }
  | { status: 'ok'; account: Account }
  | { status: 'mismatch'; error: string }
  | { status: 'duplicate'; error: string };

export type SwitchAccountResult =
  | { ok: true; account: Account }
  | { ok: false; error: string };

// Automatic rotation: switch off the active account once its binding limit
// crosses `threshold`, so an unattended run rolls onto a fresh account instead
// of hitting the wall. Evaluated in the main process, so it fires with the
// window closed.
export interface RotationPolicy {
  enabled: boolean;
  // Percent of the binding limit at which to move (default 95).
  threshold: number;
  // When a chat actually hits the wall anyway — the threshold is a prediction
  // and predictions miss — switch on the spot and tell that chat to carry on,
  // instead of leaving it parked until someone reads the screen.
  resumeOnLimit: boolean;
}

export interface RotationStatus {
  // Human-readable account of the last thing rotation did or refused to do.
  lastEvent: string | null;
  lastEventAt: string | null;
  // Set when repeated failures stopped rotation; cleared by re-enabling it.
  disabledReason: string | null;
}

export interface AgentsFlowApi {
  listDirectories: () => Promise<TrackedDirectory[]>;
  addDirectory: () => Promise<TrackedDirectory | null>;
  removeDirectory: (id: string) => Promise<void>;

  // Lists the slash commands/skills available under `<dirPath>/.claude`
  // (project scope) merged with `~/.claude` (user scope). Pass null for the
  // user scope only. Project entries shadow user entries with the same name.
  listSlashCommands: (dirPath: string | null) => Promise<SlashCommand[]>;

  // Connection info + tool catalogue + live peer registry for the MCP server
  // that powers peer awareness and delegation.
  getMcpServerInfo: () => Promise<McpServerInfo>;

  // Lightweight liveness of the delegation bridge socket — polled for the
  // at-a-glance health dot without rebuilding the whole MCP descriptor.
  getBridgeHealth: () => Promise<BridgeHealth>;

  // Live plan-usage meters (Current session / All models / per-model weekly),
  // read from the same authenticated endpoint that backs Claude Code's /usage
  // screen. Pass force=true to bypass the brief server-side cache (manual
  // refresh). Never throws — failures come back as { ok: false, reason }.
  getUsage: (force?: boolean) => Promise<UsageResult>;

  // ---- Account pool ----
  // The switchable pool of Anthropic accounts. Switching swaps which account's
  // credentials sit in the keychain slot Claude Code reads — no browser, no
  // login: sessions already running pick it up on their next keychain read.
  listAccounts: () => Promise<AccountsSnapshot>;
  // Starts an add for an email address. Rejects malformed addresses and ones
  // already in the pool without touching anything.
  addAccount: (email: string) => Promise<AddAccountResult>;
  // Polled while the login terminal is open; finalises the account once the
  // browser flow lands, or tears the vault down if it authorised the wrong one.
  probeAccount: (pendingId: string) => Promise<ProbeAccountResult>;
  // Abandons an in-progress add (modal closed) and removes the partial vault.
  cancelAddAccount: (pendingId: string) => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
  switchAccount: (id: string) => Promise<SwitchAccountResult>;
  // Re-check (and if possible restore) the active account's sign-in right now.
  // Happens automatically on a timer; this is the button on the failure banner.
  repairAccounts: () => Promise<AccountsSnapshot>;
  // Usage meters for one pooled account, read with that account's own token —
  // works whether or not it is the active one.
  getAccountUsage: (id: string, force?: boolean) => Promise<UsageResult>;
  onAccountsUpdated: (cb: (snapshot: AccountsSnapshot) => void) => () => void;

  // Automatic rotation at a usage threshold — what makes an unattended
  // overnight run possible without anyone clicking a switch.
  getRotationPolicy: () => Promise<{ policy: RotationPolicy; status: RotationStatus }>;
  setRotationPolicy: (policy: RotationPolicy) => Promise<{ policy: RotationPolicy; status: RotationStatus }>;
  onRotationStatus: (cb: (status: RotationStatus) => void) => () => void;

  listConversations: () => Promise<Conversation[]>;
  spawnAgent: (req: SpawnRequest) => Promise<SpawnResult>;
  // Branches a copy of an existing conversation's session (`--fork-session`):
  // full history, new session id, independent from the original — the escape
  // hatch when the original is stuck (e.g. held by a crash-looping bg daemon).
  forkConversation: (conversationId: string) => Promise<{ conversationId: string }>;
  updateConversationTitle: (id: string, title: string) => Promise<void>;
  setConversationPinned: (id: string, pinned: boolean) => Promise<void>;
  stopAgent: (id: string) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;
  removeDirectoryWithHistory: (id: string) => Promise<{ removedConversations: number }>;

  attachTerminal: (conversationId: string, cols: number, rows: number) => Promise<{ channelId: string; replay?: string }>;
  attachShellTerminal: (shellId: string, cwd: string, cols: number, rows: number) => Promise<{ channelId: string; replay: string }>;
  killShell: (shellId: string) => Promise<void>;
  writeTerminal: (channelId: string, data: string) => Promise<void>;
  resizeTerminal: (channelId: string, cols: number, rows: number) => Promise<void>;
  detachTerminal: (channelId: string) => Promise<void>;
  onTerminalData: (cb: (channelId: string, data: string) => void) => () => void;
  onTerminalExit: (cb: (channelId: string) => void) => () => void;

  onConversationsUpdated: (cb: (conversations: Conversation[]) => void) => () => void;
  /**
   * Incremental counterpart to `onConversationsUpdated`: carries ONLY the
   * conversations whose fields changed, which is what a daemon state change
   * actually amounts to. The full list is reserved for structural changes
   * (added / removed). Optional so an older preload degrades to full pushes.
   */
  onConversationsPatched?: (cb: (changed: Conversation[]) => void) => () => void;

  // Fired when something (e.g. the `open_file` MCP tool) asks the app to bring a
  // file up in its file view. The renderer responds by navigating to that
  // directory's Preview page and opening the file.
  onOpenFile: (cb: (payload: OpenFileNavPayload) => void) => () => void;

  listDividers: () => Promise<PinnedDivider[]>;
  addDivider: (afterRef: PinnedItemRef | null) => Promise<PinnedDivider>;
  renameDivider: (id: string, title: string) => Promise<void>;
  removeDivider: (id: string) => Promise<void>;
  listPinnedOrder: () => Promise<PinnedItemRef[]>;
  reorderPinned: (orderedRefs: PinnedItemRef[]) => Promise<void>;
  onDividersUpdated: (cb: (dividers: PinnedDivider[]) => void) => () => void;
  onPinnedOrderUpdated: (cb: (order: PinnedItemRef[]) => void) => () => void;

  // Peer-scoped todo rows in the pinned list. `addTodo` inserts after
  // `afterRef` when given (mirrors addDivider), else at the end of the first
  // section (mirrors a fresh spawn). `setTodoDone` moves it out of/back into
  // the pinned list, like un/re-pinning a conversation.
  listTodos: () => Promise<PinnedTodo[]>;
  addTodo: (directoryId: string, afterRef: PinnedItemRef | null) => Promise<PinnedTodo>;
  updateTodoText: (id: string, text: string) => Promise<void>;
  setTodoDone: (id: string, done: boolean) => Promise<void>;
  removeTodo: (id: string) => Promise<void>;
  onTodosUpdated: (cb: (todos: PinnedTodo[]) => void) => () => void;

  gitStatus: (dirPath: string) => Promise<GitStatusResult>;
  listFiles: (dirPath: string) => Promise<FileEntry[]>;

  // Lists every git worktree for the repo that `dirPath` belongs to (the
  // primary working tree plus any linked ones under `.claude/worktrees/`),
  // each annotated with its uncommitted change count and whether its commits
  // have landed in `refBranch`. `refBranch` defaults to the primary working
  // tree's branch; an unknown one falls back to that default.
  // Returns [] when `dirPath` is not a git repo.
  listWorktrees: (dirPath: string, refBranch?: string) => Promise<WorktreeInfo[]>;
  // Branches for the reference picker, most-recent-commit first, split into
  // local and remote-tracking. Remotes are not deduplicated against locals —
  // `v3.1.0` and `origin/v3.1.0` are different questions.
  listBranches: (dirPath: string) => Promise<BranchList>;
  // Removes a linked worktree (`git worktree remove`). `repoDir` anchors the
  // command inside the repo; `worktreePath` is the worktree to drop. Refuses to
  // remove the primary working tree. Pass `force: true` to remove a worktree
  // that still has uncommitted/untracked changes.
  removeWorktree: (
    repoDir: string,
    worktreePath: string,
    force?: boolean,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;

  // The per-peer private "notes" folder, stored under Peers Flow's app-data
  // (NOT inside the project, so note files never appear in git or the project
  // tree). Creates it on first access and returns its absolute path.
  notesRoot: (dirPath: string) => Promise<{ root: string }>;
  // The single GLOBAL notes folder — shared across every peer, not tied to any
  // tracked directory. Stored under Peers Flow's app-data. Creates it on first
  // access and returns its absolute path.
  globalNotesRoot: () => Promise<{ root: string }>;
  // Plain recursive listing of a notes folder (no git semantics).
  listNotes: (root: string) => Promise<FileEntry[]>;

  // Full-text search across the non-ignored files in `dirPath` (the same set
  // the Files tree shows). Returns matching lines grouped by file.
  searchFiles: (dirPath: string, query: string, opts?: SearchOptions) => Promise<SearchResult>;

  // Subscribe to filesystem changes for `dirPath`. The callback is invoked
  // (after a small debounce) when files in the workspace change. Call the
  // returned function to unsubscribe — the underlying watcher is reference-
  // counted, so the OS-level subscription is torn down only when no
  // listeners remain for that path.
  watchFiles: (dirPath: string) => Promise<void>;
  unwatchFiles: (dirPath: string) => Promise<void>;
  onFilesUpdated: (cb: (dirPath: string) => void) => () => void;
  saveImageFromPaste: (dataBase64: string, mimeType: string) => Promise<{ savedPath: string }>;
  // Saves image bytes into `targetDir` (the MD editor uses this to keep pasted
  // images next to the opened file) and returns the absolute saved path.
  saveImageToDir: (targetDir: string, dataBase64: string, mimeType: string) => Promise<{ savedPath: string }>;

  readTextFile: (filePath: string) => Promise<ReadFileResult>;
  writeTextFile: (filePath: string, content: string) => Promise<{ ok: true }>;
  readBinaryFile: (filePath: string) => Promise<ReadBinaryResult>;

  // Creates a new empty file. Fails if a file already exists at that path;
  // missing parent directories are created.
  createFile: (filePath: string) => Promise<{ ok: true }>;
  renamePath: (oldPath: string, newPath: string) => Promise<{ ok: true }>;
  removePath: (targetPath: string) => Promise<{ ok: true }>;

  copyImageToClipboard: (filePath: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  // Copies raw image bytes (base64, any format nativeImage can decode) to the
  // OS clipboard. Optional so a renderer served by a newer dev server degrades
  // gracefully against a main process that predates the handler — callers fall
  // back to the web clipboard API.
  copyImageDataToClipboard?: (dataBase64: string) => Promise<{ ok: true } | { ok: false; error: string }>;

  // Reveals the file/dir in the OS file browser (Finder on macOS, Explorer
  // on Windows, default file manager on Linux).
  revealInFinder: (targetPath: string) => Promise<{ ok: true } | { ok: false; error: string }>;

  // Resolves a token from terminal output (absolute, `~`-prefixed, or relative
  // to `baseDir`) to an absolute path and reports whether it exists. Powers the
  // terminal's clickable-path links: only tokens that resolve to a real file or
  // directory become clickable. Returns null when the token is unresolvable
  // (e.g. relative with no baseDir).
  probePath: (baseDir: string | null, token: string) => Promise<{ exists: boolean; absPath: string } | null>;

  // Hands the file path to Electron's native drag-and-drop session so the
  // user can drop the file on any external app (Finder, Chrome, etc.).
  startFileDrag: (filePath: string) => Promise<void>;
}

export interface ReadBinaryResult {
  dataUrl: string;
  mime: string;
  size: number;
  truncated: boolean;
  error?: string;
}

export interface ReadFileResult {
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  error?: string;
}

export type GitEntryStatus = 'untracked' | 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';

export interface GitEntry {
  path: string;
  status: GitEntryStatus;
  staged: boolean;
  unstaged: boolean;
  oldPath?: string;
}

export interface GitStatusResult {
  isRepo: boolean;
  branch?: string;
  entries: GitEntry[];
}

export interface FileEntry {
  path: string;
  isIgnored: boolean;
}

// Branches offered by the worktree panel's reference picker.
export interface BranchList {
  local: string[];   // e.g. 'v3.1.0'
  remote: string[];  // e.g. 'origin/v3.1.0'
}

// One entry in the Changes-view worktree list. The primary working tree and
// every linked worktree both show up as a WorktreeInfo.
export interface WorktreeInfo {
  path: string;          // absolute worktree directory
  branch: string;        // short branch name, or 'HEAD' when detached
  head: string;          // short HEAD sha
  isMain: boolean;       // the repo's primary working tree
  isCurrent: boolean;    // path === the directory the sidebar was opened for
  changedCount: number;  // uncommitted (working-tree) file count
  dirty: boolean;        // changedCount > 0
  // --- publish state, measured against `refBranch` ------------------------
  // The branch every row was compared against, '' when none could be resolved
  // (a detached primary working tree with no pinned reference).
  refBranch: string;
  ahead: number;         // raw commits here that the ref does not have
  behind: number;        // commits on the ref that are not here
  // `ahead` minus the commits that already reached the ref by cherry-pick or
  // rebase (matched on patch-id) — i.e. the work genuinely still outstanding.
  // Squash-merged branches are not detected and read as unpublished.
  unpublished: number;
  published: boolean;    // everything on this branch is in the ref
}

export interface SearchOptions {
  caseSensitive?: boolean;
  isRegex?: boolean;
}

// One matching line within a file. `ranges` are [start, end) offsets into
// `text` marking where the query matched, so the UI can highlight them.
export interface SearchMatchLine {
  line: number; // 1-based
  text: string;
  ranges: [number, number][];
}

export interface SearchFileResult {
  path: string; // relative to the searched directory
  matches: SearchMatchLine[];
}

export interface SearchResult {
  files: SearchFileResult[];
  totalMatches: number;
  filesScanned: number;
  // True when a cap (max files / matches) was hit and results are incomplete.
  truncated: boolean;
  // Set when the query itself was invalid (e.g. a malformed regex).
  error?: string;
}

declare global {
  interface Window {
    agentsflow: AgentsFlowApi;
  }
}
