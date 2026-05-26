import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { AgentsFlowApi, Conversation, SpawnRequest } from '../shared/types';

const api: AgentsFlowApi = {
  listDirectories: () => ipcRenderer.invoke('dirs:list'),
  addDirectory: () => ipcRenderer.invoke('dirs:add'),
  removeDirectory: (id) => ipcRenderer.invoke('dirs:remove', id),

  listConversations: () => ipcRenderer.invoke('convs:list'),
  spawnAgent: (req: SpawnRequest) => ipcRenderer.invoke('convs:spawn', req),
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

  gitStatus: (dirPath) => ipcRenderer.invoke('git:status', dirPath),
  listFiles: (dirPath) => ipcRenderer.invoke('files:list', dirPath),
  saveImageFromPaste: (dirPath, dataBase64, mimeType) =>
    ipcRenderer.invoke('images:saveFromPaste', dirPath, dataBase64, mimeType),
  readTextFile: (filePath) => ipcRenderer.invoke('files:readText', filePath),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('files:writeText', filePath, content),
  readBinaryFile: (filePath) => ipcRenderer.invoke('files:readBinary', filePath),
  renamePath: (oldPath, newPath) => ipcRenderer.invoke('files:rename', oldPath, newPath),
  removePath: (targetPath) => ipcRenderer.invoke('files:remove', targetPath),

  copyImageToClipboard: (filePath) => ipcRenderer.invoke('clipboard:copyImage', filePath),
};

contextBridge.exposeInMainWorld('agentsflow', api);
