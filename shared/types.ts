export interface TrackedDirectory {
  id: string;
  path: string;
  displayName: string;
  addedAt: string;
}

export interface Conversation {
  id: string;
  sessionId: string;
  daemonShort: string;
  sessionName: string;
  directoryId: string;
  directoryPath: string;
  displayName: string;
  title: string;
  titleLocked: boolean;
  description: string;
  pinned: boolean;
  attachments?: string[];
  state: string;
  status: string;
  intent: string;
  createdAt: string;
  lastPrompt: string;
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

export interface AgentsFlowApi {
  listDirectories: () => Promise<TrackedDirectory[]>;
  addDirectory: () => Promise<TrackedDirectory | null>;
  removeDirectory: (id: string) => Promise<void>;

  listConversations: () => Promise<Conversation[]>;
  spawnAgent: (req: SpawnRequest) => Promise<SpawnResult>;
  updateConversationTitle: (id: string, title: string, locked: boolean) => Promise<void>;
  setConversationPinned: (id: string, pinned: boolean) => Promise<void>;
  stopAgent: (id: string) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;
  removeDirectoryWithHistory: (id: string) => Promise<{ removedConversations: number }>;

  attachTerminal: (conversationId: string, cols: number, rows: number) => Promise<{ channelId: string }>;
  writeTerminal: (channelId: string, data: string) => Promise<void>;
  resizeTerminal: (channelId: string, cols: number, rows: number) => Promise<void>;
  detachTerminal: (channelId: string) => Promise<void>;
  onTerminalData: (cb: (channelId: string, data: string) => void) => () => void;
  onTerminalExit: (cb: (channelId: string) => void) => () => void;

  onConversationsUpdated: (cb: (conversations: Conversation[]) => void) => () => void;

  gitStatus: (dirPath: string) => Promise<GitStatusResult>;
  listFiles: (dirPath: string) => Promise<FileEntry[]>;
  saveImageFromPaste: (dirPath: string, dataBase64: string, mimeType: string) => Promise<{ savedPath: string }>;
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
