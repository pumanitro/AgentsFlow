import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuid } from 'uuid';
import serve from 'electron-serve';

const APP_NAME = 'Agents Flow';
app.setName(APP_NAME);

// Resolve icon for both dev (running from source) and packaged builds.
// __dirname in dev is dist/electron/electron, in packaged builds it lives under app.asar.
function resolveIconPath(): string | null {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'assets', 'icon.png'),
    path.join(process.resourcesPath || '', 'assets', 'icon.png'),
    path.join(app.getAppPath(), 'assets', 'icon.png'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}
const ICON_PATH = resolveIconPath();

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
import * as fileWatcher from './file-watcher';
import { gitStatus, listFiles } from './git';
import { deleteAttachmentFiles, sweepOrphanAttachments } from './attachments';
import { Conversation, PinnedDivider, PinnedItemRef, SpawnRequest, TrackedDirectory } from '../shared/types';

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
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    ...(ICON_PATH ? { icon: ICON_PATH } : {}),
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
  if (process.platform === 'darwin' && app.dock && ICON_PATH) {
    try {
      const img = nativeImage.createFromPath(ICON_PATH);
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch (err) {
      console.warn('[agentsflow] failed to set dock icon', err);
    }
  }
  createWindow();
  startPoller(() => mainWindow);

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
  fileWatcher.unwatchAll().catch(() => undefined);
  if (process.platform !== 'darwin') app.quit();
});

// ----- IPC -----

function broadcastConversations(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('conversations:updated', store.getConversations());
  }
}
function broadcastDividers(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dividers:updated', store.getDividers());
  }
}
function broadcastPinnedOrder(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pinnedOrder:updated', store.getPinnedOrder());
  }
}

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
  broadcastConversations();
  broadcastPinnedOrder();

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
    store.updateConversation(conversationId, {
      state: job.state ?? 'idle',
      description: (job.detail ?? optimistic.description) || 'starting…',
    });
  }

  await refreshNow();
  broadcastConversations();
  return { conversationId, sessionId, daemonShort };
});

ipcMain.handle('convs:updateTitle', (_e, id: string, title: string) => {
  store.updateConversation(id, { title });
  broadcastConversations();
});

ipcMain.handle('convs:setPinned', (_e, id: string, pinned: boolean) => {
  store.updateConversation(id, { pinned });
  broadcastConversations();
  broadcastPinnedOrder();
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
  broadcastConversations();
  broadcastPinnedOrder();
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
  broadcastConversations();
  broadcastPinnedOrder();
  return { removedConversations: targets.length };
});

ipcMain.handle('dividers:list', () => store.getDividers());

ipcMain.handle('dividers:add', (_e, afterRef: PinnedItemRef | null): PinnedDivider => {
  const divider: PinnedDivider = {
    id: uuid(),
    title: '',
    createdAt: new Date().toISOString(),
  };
  store.addDivider(divider, afterRef ?? null);
  broadcastDividers();
  broadcastPinnedOrder();
  return divider;
});

ipcMain.handle('dividers:rename', (_e, id: string, title: string) => {
  store.updateDivider(id, { title });
  broadcastDividers();
});

ipcMain.handle('dividers:remove', (_e, id: string) => {
  store.removeDivider(id);
  broadcastDividers();
  broadcastPinnedOrder();
});

ipcMain.handle('pinned:list', () => store.getPinnedOrder());

ipcMain.handle('pinned:reorder', (_e, orderedRefs: PinnedItemRef[]) => {
  store.setPinnedOrder(Array.isArray(orderedRefs) ? orderedRefs : []);
  broadcastPinnedOrder();
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

ipcMain.handle('term:attachShell', (_e, shellId: string, cwd: string, cols: number, rows: number) => {
  console.log('[agentsflow] term:attachShell received', { shellId, cwd, cols, rows });
  if (!shellId || typeof shellId !== 'string') throw new Error('shellId required');
  if (!cwd || typeof cwd !== 'string') throw new Error('cwd required');
  if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const win = mainWindow ?? BrowserWindow.fromWebContents(_e.sender);
  if (!win) throw new Error('no window');
  const channelId = uuid();
  const replay = pty.attachShell({ shellId, channelId, cwd, cols, rows, win });
  return { channelId, replay };
});

ipcMain.handle('term:killShell', (_e, shellId: string) => {
  if (!shellId || typeof shellId !== 'string') return;
  pty.killShell(shellId);
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

ipcMain.handle('files:watch', async (e, dirPath: string) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? mainWindow;
  if (!win) return;
  await fileWatcher.watch(dirPath, win);
});

ipcMain.handle('files:unwatch', async (e, dirPath: string) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? mainWindow;
  if (!win) return;
  await fileWatcher.unwatch(dirPath, win);
});

ipcMain.handle('files:readText', async (_e, filePath: string) => {
  const fsMod = require('fs') as typeof import('fs');
  try {
    const stat = fsMod.statSync(filePath);
    const MAX = 2 * 1024 * 1024; // 2 MB cap for the editor
    if (stat.size > MAX) {
      return { content: '', size: stat.size, truncated: true, binary: false };
    }
    const buf = fsMod.readFileSync(filePath);
    // Heuristic: any NUL byte in the first 8 KB → binary
    const sniff = buf.subarray(0, Math.min(buf.length, 8192));
    const isBinary = sniff.includes(0);
    if (isBinary) {
      return { content: '', size: stat.size, truncated: false, binary: true };
    }
    return { content: buf.toString('utf8'), size: stat.size, truncated: false, binary: false };
  } catch (err) {
    return { content: '', size: 0, truncated: false, binary: false, error: (err as Error).message };
  }
});

ipcMain.handle('files:writeText', async (_e, filePath: string, content: string) => {
  const fsMod = require('fs') as typeof import('fs');
  fsMod.writeFileSync(filePath, content, 'utf8');
  return { ok: true as const };
});

ipcMain.handle('files:readBinary', async (_e, filePath: string) => {
  const fsMod = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  const MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
  };
  try {
    const stat = fsMod.statSync(filePath);
    const MAX = 8 * 1024 * 1024;
    if (stat.size > MAX) return { dataUrl: '', mime: '', size: stat.size, truncated: true };
    const ext = pathMod.extname(filePath).slice(1).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const buf = fsMod.readFileSync(filePath);
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, size: stat.size, truncated: false };
  } catch (err) {
    return { dataUrl: '', mime: '', size: 0, truncated: false, error: (err as Error).message };
  }
});

ipcMain.handle('files:rename', async (_e, oldPath: string, newPath: string) => {
  const fsMod = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  if (!pathMod.isAbsolute(oldPath) || !pathMod.isAbsolute(newPath)) {
    throw new Error('rename: paths must be absolute');
  }
  if (fsMod.existsSync(newPath)) {
    throw new Error(`rename: target already exists at ${newPath}`);
  }
  fsMod.mkdirSync(pathMod.dirname(newPath), { recursive: true });
  fsMod.renameSync(oldPath, newPath);
  return { ok: true as const };
});

ipcMain.handle('files:remove', async (_e, targetPath: string) => {
  const fsMod = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  if (!pathMod.isAbsolute(targetPath)) {
    throw new Error('remove: path must be absolute');
  }
  // Guardrails: refuse to nuke roots / very short paths.
  if (targetPath === '/' || targetPath.split(pathMod.sep).filter(Boolean).length < 2) {
    throw new Error(`remove: refusing to delete suspicious path ${targetPath}`);
  }
  fsMod.rmSync(targetPath, { recursive: true, force: false });
  return { ok: true as const };
});

ipcMain.handle('clipboard:copyImage', async (_e, filePath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
  const pathMod = require('path') as typeof import('path');
  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tif', 'tiff']);
  if (!pathMod.isAbsolute(filePath)) return { ok: false, error: 'path must be absolute' };
  const ext = pathMod.extname(filePath).slice(1).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return { ok: false, error: `not an image (.${ext})` };
  try {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return { ok: false, error: 'failed to decode image' };
    clipboard.writeImage(img);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
});

ipcMain.handle('images:saveFromPaste', async (_e, dirPath: string | null, dataBase64: string, mimeType: string): Promise<{ savedPath: string }> => {
  const fsMod = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const targetDir = dirPath
    ? pathMod.join(dirPath, '.agentsflow', 'images')
    : pathMod.join(app.getPath('userData'), 'pasted-images');
  fsMod.mkdirSync(targetDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const fullPath = pathMod.join(targetDir, filename);
  const buf = Buffer.from(dataBase64, 'base64');
  fsMod.writeFileSync(fullPath, buf);
  return { savedPath: fullPath };
});
