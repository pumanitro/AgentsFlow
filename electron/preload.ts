import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { AgentsFlowApi, Conversation, OpenFileNavPayload, PinnedDivider, PinnedItemRef, PinnedTodo, SpawnRequest } from '../shared/types';

const api: AgentsFlowApi = {
  listDirectories: () => ipcRenderer.invoke('dirs:list'),
  addDirectory: () => ipcRenderer.invoke('dirs:add'),
  removeDirectory: (id) => ipcRenderer.invoke('dirs:remove', id),

  listSlashCommands: (dirPath) => ipcRenderer.invoke('skills:list', dirPath),

  getMcpServerInfo: () => ipcRenderer.invoke('mcp:info'),
  getBridgeHealth: () => ipcRenderer.invoke('bridge:health'),

  listConversations: () => ipcRenderer.invoke('convs:list'),
  spawnAgent: (req: SpawnRequest) => ipcRenderer.invoke('convs:spawn', req),
  forkConversation: (conversationId) => ipcRenderer.invoke('convs:fork', conversationId),
  updateConversationTitle: (id, title) =>
    ipcRenderer.invoke('convs:updateTitle', id, title),
  setConversationPinned: (id, pinned) => ipcRenderer.invoke('convs:setPinned', id, pinned),
  stopAgent: (id) => ipcRenderer.invoke('convs:stop', id),
  removeAgent: (id) => ipcRenderer.invoke('convs:remove', id),
  removeDirectoryWithHistory: (id) => ipcRenderer.invoke('dirs:removeWithHistory', id),

  attachTerminal: (conversationId, cols, rows) =>
    ipcRenderer.invoke('term:attach', conversationId, cols, rows),
  attachShellTerminal: (shellId, cwd, cols, rows) =>
    ipcRenderer.invoke('term:attachShell', shellId, cwd, cols, rows),
  killShell: (shellId) => ipcRenderer.invoke('term:killShell', shellId),
  writeTerminal: (channelId, data) => ipcRenderer.invoke('term:write', channelId, data),
  resizeTerminal: (channelId, cols, rows) => ipcRenderer.invoke('term:resize', channelId, cols, rows),
  detachTerminal: (channelId) => ipcRenderer.invoke('term:detach', channelId),

  onTerminalData: (cb) => {
    const listener = (_e: IpcRendererEvent, channelId: string, data: string) => cb(channelId, data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (cb) => {
    const listener = (_e: IpcRendererEvent, channelId: string) => cb(channelId);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
  onConversationsUpdated: (cb) => {
    const listener = (_e: IpcRendererEvent, conversations: Conversation[]) => cb(conversations);
    ipcRenderer.on('conversations:updated', listener);
    return () => ipcRenderer.removeListener('conversations:updated', listener);
  },
  onOpenFile: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: OpenFileNavPayload) => cb(payload);
    ipcRenderer.on('navigate:openFile', listener);
    return () => ipcRenderer.removeListener('navigate:openFile', listener);
  },

  listDividers: () => ipcRenderer.invoke('dividers:list'),
  addDivider: (afterRef) => ipcRenderer.invoke('dividers:add', afterRef),
  renameDivider: (id, title) => ipcRenderer.invoke('dividers:rename', id, title),
  removeDivider: (id) => ipcRenderer.invoke('dividers:remove', id),
  listPinnedOrder: () => ipcRenderer.invoke('pinned:list'),
  reorderPinned: (orderedRefs) => ipcRenderer.invoke('pinned:reorder', orderedRefs),
  onDividersUpdated: (cb) => {
    const listener = (_e: IpcRendererEvent, dividers: PinnedDivider[]) => cb(dividers);
    ipcRenderer.on('dividers:updated', listener);
    return () => ipcRenderer.removeListener('dividers:updated', listener);
  },
  onPinnedOrderUpdated: (cb) => {
    const listener = (_e: IpcRendererEvent, order: PinnedItemRef[]) => cb(order);
    ipcRenderer.on('pinnedOrder:updated', listener);
    return () => ipcRenderer.removeListener('pinnedOrder:updated', listener);
  },

  listTodos: () => ipcRenderer.invoke('todos:list'),
  addTodo: (directoryId, afterRef) => ipcRenderer.invoke('todos:add', directoryId, afterRef),
  updateTodoText: (id, text) => ipcRenderer.invoke('todos:updateText', id, text),
  setTodoDone: (id, done) => ipcRenderer.invoke('todos:setDone', id, done),
  removeTodo: (id) => ipcRenderer.invoke('todos:remove', id),
  onTodosUpdated: (cb) => {
    const listener = (_e: IpcRendererEvent, todos: PinnedTodo[]) => cb(todos);
    ipcRenderer.on('todos:updated', listener);
    return () => ipcRenderer.removeListener('todos:updated', listener);
  },

  gitStatus: (dirPath) => ipcRenderer.invoke('git:status', dirPath),
  listWorktrees: (dirPath, refBranch) => ipcRenderer.invoke('git:worktrees', dirPath, refBranch),
  listBranches: (dirPath) => ipcRenderer.invoke('git:branches', dirPath),
  removeWorktree: (repoDir, worktreePath, force) =>
    ipcRenderer.invoke('git:removeWorktree', repoDir, worktreePath, force),
  listFiles: (dirPath) => ipcRenderer.invoke('files:list', dirPath),

  notesRoot: (dirPath) => ipcRenderer.invoke('notes:root', dirPath),
  globalNotesRoot: () => ipcRenderer.invoke('notes:globalRoot'),
  listNotes: (root) => ipcRenderer.invoke('notes:list', root),
  searchFiles: (dirPath, query, opts) => ipcRenderer.invoke('files:search', dirPath, query, opts),

  watchFiles: (dirPath) => ipcRenderer.invoke('files:watch', dirPath),
  unwatchFiles: (dirPath) => ipcRenderer.invoke('files:unwatch', dirPath),
  onFilesUpdated: (cb) => {
    const listener = (_e: IpcRendererEvent, dirPath: string) => cb(dirPath);
    ipcRenderer.on('files:updated', listener);
    return () => ipcRenderer.removeListener('files:updated', listener);
  },
  saveImageFromPaste: (dataBase64, mimeType) =>
    ipcRenderer.invoke('images:saveFromPaste', dataBase64, mimeType),
  saveImageToDir: (targetDir, dataBase64, mimeType) =>
    ipcRenderer.invoke('images:saveToDir', targetDir, dataBase64, mimeType),
  readTextFile: (filePath) => ipcRenderer.invoke('files:readText', filePath),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('files:writeText', filePath, content),
  readBinaryFile: (filePath) => ipcRenderer.invoke('files:readBinary', filePath),
  createFile: (filePath) => ipcRenderer.invoke('files:create', filePath),
  renamePath: (oldPath, newPath) => ipcRenderer.invoke('files:rename', oldPath, newPath),
  removePath: (targetPath) => ipcRenderer.invoke('files:remove', targetPath),

  copyImageToClipboard: (filePath) => ipcRenderer.invoke('clipboard:copyImage', filePath),
  revealInFinder: (targetPath) => ipcRenderer.invoke('files:revealInFinder', targetPath),
  probePath: (baseDir, token) => ipcRenderer.invoke('files:probePath', baseDir, token),
  startFileDrag: (filePath) => ipcRenderer.invoke('files:startDrag', filePath),
};

contextBridge.exposeInMainWorld('agentsflow', api);
