import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuid } from 'uuid';
import serve from 'electron-serve';

import { store } from './store';
import { computeDisplayName, recomputeAllDisplayNames } from './naming';
import {
  dispatchBackground,
  resolveSessionByDaemonShort,
  resolveLatestSessionInCwd,
  stopAgent as cliStop,
  removeAgent as cliRemove,
  readJobState,
} from './claude-cli';
import { refreshNow, startPoller, stopPoller, syncWatchers, unwatchConversation, watchConversation } from './poller';
import * as pty from './pty-manager';
import { gitStatus, listFiles } from './git';
import { deleteAttachmentFiles, sweepOrphanAttachments } from './attachments';
import { Conversation, SpawnRequest, TrackedDirectory } from '../shared/types';

const isDev = process.env.NODE_ENV === 'development';
const loadURL = isDev ? null : serve({ directory: path.join(__dirname, '..', '..', '..', 'renderer', 'out') });

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:3030');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    loadURL!(win);
  }
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  startPoller(() => mainWindow, 30000);

  try {
    const result = sweepOrphanAttachments(store.getDirectories(), store.getConversations());
    if (result.deleted > 0) console.log('[agentsflow] swept orphan attachments', result);
  } catch (err) {
    console.error('[agentsflow] sweep failed', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopPoller();
  pty.detachAll();
  if (process.platform !== 'darwin') app.quit();
});

// ----- IPC -----

ipcMain.handle('dirs:list', () => store.getDirectories());

ipcMain.handle('dirs:add', async (): Promise<TrackedDirectory | null> => {
  const win = mainWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const absPath = result.filePaths[0];
  try { fs.accessSync(absPath, fs.constants.R_OK); } catch { return null; }

  const existing = store.getDirectories();
  if (existing.some((d) => d.path === absPath)) {
    return existing.find((d) => d.path === absPath) ?? null;
  }
  const newDir: TrackedDirectory = {
    id: uuid(),
    path: absPath,
    displayName: computeDisplayName(absPath, existing),
    addedAt: new Date().toISOString(),
  };
  const next = recomputeAllDisplayNames([...existing, newDir]);
  store.setDirectories(next);
  return next.find((d) => d.id === newDir.id) ?? newDir;
});

ipcMain.handle('dirs:remove', (_e, id: string) => {
  const dirs = store.getDirectories().filter((d) => d.id !== id);
  store.setDirectories(recomputeAllDisplayNames(dirs));
});

ipcMain.handle('convs:list', () => store.getConversations());

ipcMain.handle('convs:spawn', async (_e, req: SpawnRequest): Promise<{ conversationId: string; sessionId: string; daemonShort: string }> => {
  const dirs = store.getDirectories();
  const dir = dirs.find((d) => d.id === req.directoryId);
  if (!dir) throw new Error('directory not found');
  const prompt = req.prompt.trim();
  if (!prompt) throw new Error('prompt required');

  const conversationId = uuid();

  const optimistic: Conversation = {
    id: conversationId,
    sessionId: '',
    daemonShort: '',
    sessionName: '',
    directoryId: dir.id,
    directoryPath: dir.path,
    displayName: dir.displayName,
    title: prompt.slice(0, 60),
    titleLocked: false,
    description: 'starting…',
    pinned: true,
    attachments: req.attachments ?? [],
    state: 'starting',
    status: 'starting',
    intent: prompt,
    createdAt: new Date().toISOString(),
    lastPrompt: prompt,
  };
  store.addConversation(optimistic);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('conversations:updated', store.getConversations());
  }

  const startedBefore = Date.now();
  const claimedSessionIds = new Set(store.getConversations().map((c) => c.sessionId).filter(Boolean));
  const dispatch = await dispatchBackground({ cwd: dir.path, prompt });
  const daemonShortFromOut = dispatch.daemonShort ?? '';
  let resolved = daemonShortFromOut
    ? await resolveSessionByDaemonShort(daemonShortFromOut, 10000)
    : null;
  if (!resolved) {
    console.warn('[agentsflow] dispatch.daemonShort empty or unresolved — falling back to latest-session-in-cwd lookup');
    resolved = await resolveLatestSessionInCwd({
      cwd: dir.path,
      startedAfterMs: startedBefore,
      excludeSessionIds: claimedSessionIds,
      maxWaitMs: 10000,
    });
  }

  const sessionId = resolved?.sessionId ?? '';
  const daemonShort = daemonShortFromOut || (sessionId ? sessionId.slice(0, 8) : '');
  console.log('[agentsflow] spawn resolved', { sessionId, daemonShort, daemonShortFromOut });
  store.updateConversation(conversationId, { sessionId, daemonShort });
  syncWatchers();

  const job = readJobState(daemonShort);
  if (job) {
    const claudeName = (job.name ?? '').trim();
    store.updateConversation(conversationId, {
      state: job.state ?? 'idle',
      description: (job.detail ?? optimistic.description) || 'starting…',
      title: optimistic.titleLocked ? optimistic.title : (claudeName || optimistic.title),
    });
  }

  await refreshNow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('conversations:updated', store.getConversations());
  }
  return { conversationId, sessionId, daemonShort };
});

ipcMain.handle('convs:updateTitle', (_e, id: string, title: string, locked: boolean) => {
  store.updateConversation(id, { title, titleLocked: locked });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('conversations:updated', store.getConversations());
  }
});

ipcMain.handle('convs:setPinned', (_e, id: string, pinned: boolean) => {
  store.updateConversation(id, { pinned });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('conversations:updated', store.getConversations());
  }
});

ipcMain.handle('convs:stop', async (_e, id: string) => {
  const conv = store.getConversations().find((c) => c.id === id);
  if (!conv) return;
  await cliStop(conv.daemonShort);
});

ipcMain.handle('convs:remove', async (_e, id: string) => {
  const conv = store.getConversations().find((c) => c.id === id);
  if (!conv) return;
  await cliStop(conv.daemonShort).catch(() => undefined);
  await cliRemove(conv.daemonShort).catch(() => undefined);
  unwatchConversation(id);
  deleteAttachmentFiles(conv.attachments);
  store.removeConversation(id);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('conversations:updated', store.getConversations());
  }
});

ipcMain.handle('dirs:removeWithHistory', async (_e, id: string): Promise<{ removedConversations: number }> => {
  const dir = store.getDirectories().find((d) => d.id === id);
  if (!dir) return { removedConversations: 0 };
  const targets = store.getConversations().filter((c) => c.directoryId === id);
  for (const c of targets) {
    await cliStop(c.daemonShort).catch(() => undefined);
    await cliRemove(c.daemonShort).catch(() => undefined);
    unwatchConversation(c.id);
    deleteAttachmentFiles(c.attachments);
    store.removeConversation(c.id);
  }
  const dirs = store.getDirectories().filter((d) => d.id !== id);
  store.setDirectories(recomputeAllDisplayNames(dirs));
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('conversations:updated', store.getConversations());
  }
  return { removedConversations: targets.length };
});

ipcMain.handle('term:attach', (_e, conversationId: string, cols: number, rows: number) => {
  console.log('[agentsflow] term:attach received', { conversationId, cols, rows });
  const conv = store.getConversations().find((c) => c.id === conversationId);
  if (!conv) {
    console.error('[agentsflow] term:attach: conversation not found', { conversationId, all: store.getConversations().map((c) => c.id) });
    throw new Error(`conversation ${conversationId} not found`);
  }
  if (!conv.sessionId) {
    console.error('[agentsflow] term:attach: no sessionId yet', conv);
    throw new Error('session not ready (sessionId is empty)');
  }
  const win = mainWindow ?? BrowserWindow.fromWebContents(_e.sender);
  if (!win) throw new Error('no window');
  const channelId = uuid();
  const attachId = conv.daemonShort || conv.sessionId.slice(0, 8);
  console.log('[agentsflow] spawning pty for claude attach', { attachId, sessionId: conv.sessionId, channelId });
  pty.attach({ channelId, sessionId: attachId, cols, rows, win });
  return { channelId };
});

ipcMain.handle('term:write', (_e, channelId: string, data: string) => {
  pty.write(channelId, data);
});

ipcMain.handle('term:resize', (_e, channelId: string, cols: number, rows: number) => {
  pty.resize(channelId, cols, rows);
});

ipcMain.handle('term:detach', (_e, channelId: string) => {
  pty.detach(channelId);
});

ipcMain.handle('git:status', async (_e, dirPath: string) => gitStatus(dirPath));
ipcMain.handle('files:list', async (_e, dirPath: string) => listFiles(dirPath));

ipcMain.handle('images:saveFromPaste', async (_e, dirPath: string, dataBase64: string, mimeType: string): Promise<{ savedPath: string }> => {
  const fsMod = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const targetDir = pathMod.join(dirPath, '.agentsflow', 'images');
  fsMod.mkdirSync(targetDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const fullPath = pathMod.join(targetDir, filename);
  const buf = Buffer.from(dataBase64, 'base64');
  fsMod.writeFileSync(fullPath, buf);
  return { savedPath: fullPath };
});
