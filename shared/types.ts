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
}

export interface PinnedDivider {
  id: string;
  title: string;
  createdAt: string;
}

export type PinnedItemRef =
  | { kind: 'conversation'; id: string }
  | { kind: 'divider'; id: string };

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

export interface AgentsFlowApi {
  listDirectories: () => Promise<TrackedDirectory[]>;
  addDirectory: () => Promise<TrackedDirectory | null>;
  removeDirectory: (id: string) => Promise<void>;

  listConversations: () => Promise<Conversation[]>;
  spawnAgent: (req: SpawnRequest) => Promise<SpawnResult>;
  updateConversationTitle: (id: string, title: string) => Promise<void>;
  setConversationPinned: (id: string, pinned: boolean) => Promise<void>;
  stopAgent: (id: string) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;
  removeDirectoryWithHistory: (id: string) => Promise<{ removedConversations: number }>;

  attachTerminal: (conversationId: string, cols: number, rows: number) => Promise<{ channelId: string }>;
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

  // Subscribe to filesystem changes for `dirPath`. The callback is invoked
  // (after a small debounce) when files in the workspace change. Call the
  // returned function to unsubscribe — the underlying watcher is reference-
  // counted, so the OS-level subscription is torn down only when no
  // listeners remain for that path.
  watchFiles: (dirPath: string) => Promise<void>;
  unwatchFiles: (dirPath: string) => Promise<void>;
  onFilesUpdated: (cb: (dirPath: string) => void) => () => void;
  saveImageFromPaste: (dataBase64: string, mimeType: string) => Promise<{ savedPath: string }>;

  readTextFile: (filePath: string) => Promise<ReadFileResult>;
  writeTextFile: (filePath: string, content: string) => Promise<{ ok: true }>;
  readBinaryFile: (filePath: string) => Promise<ReadBinaryResult>;

  renamePath: (oldPath: string, newPath: string) => Promise<{ ok: true }>;
  removePath: (targetPath: string) => Promise<{ ok: true }>;

  copyImageToClipboard: (filePath: string) => Promise<{ ok: true } | { ok: false; error: string }>;

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

declare global {
  interface Window {
    agentsflow: AgentsFlowApi;
  }
}
