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
}

export interface PinnedDivider {
  id: string;
  title: string;
  createdAt: string;
}

export type PinnedItemRef =
  | { kind: 'conversation'; id: string }
  | { kind: 'divider'; id: string };

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
}

export interface SpawnResult {
  conversationId: string;
  sessionId: string;
  daemonShort: string;
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

  listConversations: () => Promise<Conversation[]>;
  spawnAgent: (req: SpawnRequest) => Promise<SpawnResult>;
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

  listDividers: () => Promise<PinnedDivider[]>;
  addDivider: (afterRef: PinnedItemRef | null) => Promise<PinnedDivider>;
  renameDivider: (id: string, title: string) => Promise<void>;
  removeDivider: (id: string) => Promise<void>;
  listPinnedOrder: () => Promise<PinnedItemRef[]>;
  reorderPinned: (orderedRefs: PinnedItemRef[]) => Promise<void>;
  onDividersUpdated: (cb: (dividers: PinnedDivider[]) => void) => () => void;
  onPinnedOrderUpdated: (cb: (order: PinnedItemRef[]) => void) => () => void;

  gitStatus: (dirPath: string) => Promise<GitStatusResult>;
  listFiles: (dirPath: string) => Promise<FileEntry[]>;

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

  // Reveals the file/dir in the OS file browser (Finder on macOS, Explorer
  // on Windows, default file manager on Linux).
  revealInFinder: (targetPath: string) => Promise<{ ok: true } | { ok: false; error: string }>;

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
