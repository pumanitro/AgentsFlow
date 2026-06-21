import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuid } from 'uuid';
import serve from 'electron-serve';

const APP_NAME = 'Peers Flow';
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
  hasLiveDaemon,
} from './claude-cli';
import { refreshNow, startPoller, stopPoller, syncWatchers, unwatchConversation, watchConversation } from './poller';
import { bridgeSocketPath, buildBootstrapSystemPrompt, getMcpServerInfo, writeMcpConfigForConversation } from './mcp-bridge';
import { buildDelegatePrompt } from './registry';
import { startDelegationBridge, type DelegateRequest } from './delegation-bridge';
import * as pty from './pty-manager';
import * as fileWatcher from './file-watcher';
import { gitStatus, listFiles } from './git';
import { searchInFiles } from './search';
import { deleteAttachmentFiles, pastedImagesRoot, prunePastedImages, sweepOrphanAttachments, todayDateSlug } from './attachments';
import { Conversation, FileEntry, PinnedDivider, PinnedItemRef, SlashCommand, SpawnRequest, TrackedDirectory } from '../shared/types';

const isDev = process.env.NODE_ENV === 'development';
const loadURL = isDev ? null : serve({ directory: path.join(__dirname, '..', '..', '..', 'renderer', 'out') });

let mainWindow: BrowserWindow | null = null;
let stopBridge: (() => void) | null = null;

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
      // Chromium's built-in PDF viewer is gated behind the plugins flag in
      // Electron — without it, iframes pointing at application/pdf blob
      // URLs just download instead of rendering inline.
      plugins: true,
    },
  });

  // Route every link/`window.open` call to the system's default browser
  // instead of letting Electron spawn a bare child BrowserWindow. xterm's
  // WebLinksAddon calls window.open(url, '_blank') under the hood, which
  // otherwise produced an extra minimal popup window alongside the user's
  // real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) {
      shell.openExternal(url).catch((err) => {
        console.warn('[agentsflow] shell.openExternal failed', url, err);
      });
    }
    return { action: 'deny' };
  });
  // Belt-and-braces: refuse in-app navigations to anything that isn't the
  // dev server or the packaged app:// scheme — those should also go to the
  // system browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (/^(https?:|mailto:)/i.test(url) && !url.startsWith('http://localhost:3030')) {
      event.preventDefault();
      shell.openExternal(url).catch((err) => {
        console.warn('[agentsflow] shell.openExternal failed', url, err);
      });
    }
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

  // The delegation bridge must be live before any session can call `delegate`.
  // handleDelegate is hoisted (function declaration), so it's safe to reference here.
  try {
    stopBridge = startDelegationBridge(bridgeSocketPath(), handleDelegate);
  } catch (err) {
    console.error('[agentsflow] failed to start delegation bridge', err);
  }

  try {
    const result = sweepOrphanAttachments(store.getDirectories(), store.getConversations());
    if (result.deleted > 0) console.log('[agentsflow] swept orphan attachments', result);
  } catch (err) {
    console.error('[agentsflow] sweep failed', err);
  }

  try {
    const result = prunePastedImages(pastedImagesRoot(app.getPath('userData')));
    if (result.deletedFolders > 0) console.log('[agentsflow] pruned stale pasted-image folders', result);
  } catch (err) {
    console.error('[agentsflow] prune failed', err);
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

app.on('before-quit', () => {
  try { stopBridge?.(); } catch { /* ignore */ }
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
  const persisted = next.find((d) => d.id === newDir.id) ?? newDir;

  // Re-link any pre-existing conversations recorded for this path back onto
  // the freshly-minted directoryId — this is what makes "remove + re-add"
  // restore the history list instead of orphaning it. We deliberately do NOT
  // scan ~/.claude/projects for additional transcripts here: history should
  // only contain conversations the user actually spawned via AgentsFlow.
  const relinked = store.relinkConversationsByPath(persisted.path, persisted.id, persisted.displayName);
  if (relinked > 0) {
    console.log('[agentsflow] re-linked', relinked, 'conversations to', persisted.path);
    broadcastConversations();
  }
  return persisted;
});

ipcMain.handle('dirs:remove', (_e, id: string) => {
  const dirs = store.getDirectories().filter((d) => d.id !== id);
  store.setDirectories(recomputeAllDisplayNames(dirs));
});

ipcMain.handle('mcp:info', () => getMcpServerInfo(store.getDirectories()));

ipcMain.handle('convs:list', () => store.getConversations());

/**
 * Spawns a tracked background session in `dir` and returns its ids. Shared by
 * the user-initiated `convs:spawn` IPC and the delegation bridge.
 *
 * - `peerAware` attaches the Peers Flow MCP config (so the session can list and
 *   delegate to peers) and injects the registry snapshot into its system prompt.
 *   Delegated peers run with this OFF, which is also what caps delegation at one
 *   hop — a delegated peer has no `delegate` tool.
 * - `delegatedByConversationId`, when set, nests this session under its parent
 *   in the UI and feeds the parent's "a peer is working" banner.
 */
async function spawnConversation(opts: {
  dir: TrackedDirectory;
  prompt: string;
  // Display title for the conversation. Defaults to the (possibly boilerplate)
  // prompt — delegations pass the human-readable goal instead.
  title?: string;
  attachments?: string[];
  pinned: boolean;
  peerAware: boolean;
  delegatedByConversationId?: string;
}): Promise<{ conversationId: string; sessionId: string; daemonShort: string }> {
  const { dir, prompt } = opts;
  const conversationId = uuid();
  const title = (opts.title ?? prompt).trim().slice(0, 80);

  const optimistic: Conversation = {
    id: conversationId,
    sessionId: '',
    daemonShort: '',
    sessionName: '',
    directoryId: dir.id,
    directoryPath: dir.path,
    displayName: dir.displayName,
    title,
    description: 'starting…',
    pinned: opts.pinned,
    attachments: opts.attachments ?? [],
    state: 'starting',
    status: 'starting',
    intent: prompt,
    createdAt: new Date().toISOString(),
    lastPrompt: prompt,
    delegatedByConversationId: opts.delegatedByConversationId,
  };
  store.addConversation(optimistic);
  broadcastConversations();
  broadcastPinnedOrder();

  let mcpConfigPath: string | undefined;
  let appendSystemPrompt: string | undefined;
  if (opts.peerAware) {
    try {
      mcpConfigPath = writeMcpConfigForConversation(conversationId, dir.path);
      appendSystemPrompt = buildBootstrapSystemPrompt(store.getDirectories());
    } catch (err) {
      console.error('[agentsflow] MCP bootstrap failed — spawning without peer awareness', err);
    }
  }

  const startedBefore = Date.now();
  const claimedSessionIds = new Set(store.getConversations().map((c) => c.sessionId).filter(Boolean));
  const dispatch = await dispatchBackground({ cwd: dir.path, prompt, mcpConfigPath, appendSystemPrompt });
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
  console.log('[agentsflow] spawn resolved', { sessionId, daemonShort, daemonShortFromOut, delegated: !!opts.delegatedByConversationId });
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
}

ipcMain.handle('convs:spawn', async (_e, req: SpawnRequest): Promise<{ conversationId: string; sessionId: string; daemonShort: string }> => {
  const dir = store.getDirectories().find((d) => d.id === req.directoryId);
  if (!dir) throw new Error('directory not found');
  const prompt = req.prompt.trim();
  if (!prompt) throw new Error('prompt required');
  return spawnConversation({ dir, prompt, attachments: req.attachments, pinned: true, peerAware: true });
});

// ----- Delegation bridge: the MCP server asks main to spawn a tracked peer ----

const DELEGATION_TERMINAL_STATES = new Set(['done', 'completed', 'failed', 'error']);

/**
 * Polls a delegated conversation until the poller drives it to a terminal state,
 * then harvests the peer's final result from its job state. The `delegate` MCP
 * tool blocks on this so the root agent gets a result it can rely on — while the
 * user can attach and watch the very same session live.
 */
async function waitForDelegationCompletion(
  conversationId: string,
  timeoutMs: number,
): Promise<{ status: 'success' | 'failure'; result: string; sessionId: string; error?: string }> {
  const start = Date.now();
  const minRunMs = 2500; // don't declare "done" on a momentary startup blip
  let lastResult = '';
  let lastSessionId = '';
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1200));
    try { await refreshNow(); } catch { /* keep polling on transient CLI failure */ }
    const conv = store.getConversations().find((c) => c.id === conversationId);
    if (!conv) return { status: 'failure', result: lastResult, sessionId: lastSessionId, error: 'delegated conversation was removed' };
    if (conv.sessionId) lastSessionId = conv.sessionId;
    const job = readJobState(conv.daemonShort);
    const r = (job?.output?.result || '').trim();
    if (r) lastResult = r;
    const st = (conv.state || '').toLowerCase();
    if (Date.now() - start > minRunMs && DELEGATION_TERMINAL_STATES.has(st)) {
      const failed = st === 'failed' || st === 'error';
      const result = lastResult || (conv.description || '').trim();
      return {
        status: failed ? 'failure' : 'success',
        result,
        sessionId: lastSessionId,
        error: failed ? (result || 'peer reported an error') : undefined,
      };
    }
  }
  return { status: 'failure', result: lastResult, sessionId: lastSessionId, error: `peer timed out after ${timeoutMs}ms` };
}

async function handleDelegate(req: DelegateRequest): Promise<Record<string, unknown>> {
  const dirs = store.getDirectories();
  const token = (req.directory || '').trim();
  const lower = token.toLowerCase();
  const dir =
    dirs.find((d) => d.id === token) ||
    dirs.find((d) => d.path === token) ||
    dirs.find((d) => d.displayName.toLowerCase() === lower) ||
    dirs.find((d) => path.basename(d.path).toLowerCase() === lower) ||
    null;
  if (!dir) {
    return { status: 'failure', error: `Unknown peer "${token}". Call list_peers to see valid peers.`, known: dirs.map((d) => d.displayName) };
  }
  if (!fs.existsSync(dir.path)) {
    return { status: 'failure', directory: dir.displayName, error: `Path does not exist: ${dir.path}` };
  }

  const started = Date.now();
  const prompt = buildDelegatePrompt(req.goal, req.deliverable || '');
  const spawn = await spawnConversation({
    dir,
    prompt,
    // The goal is the human-readable summary — use it as the row title instead
    // of the delegate-prompt boilerplate.
    title: req.goal,
    pinned: false,
    peerAware: false,
    delegatedByConversationId: req.rootConversationId || undefined,
  });

  const outcome = await waitForDelegationCompletion(spawn.conversationId, req.timeoutMs);
  return {
    status: outcome.status,
    directory: dir.displayName,
    directoryPath: dir.path,
    goal: req.goal,
    summary: (outcome.result || '').split(/\r?\n/).slice(0, 8).join('\n') || '(no textual result)',
    deliverable: outcome.result,
    conversationId: spawn.conversationId,
    sessionId: outcome.sessionId || spawn.sessionId,
    durationMs: Date.now() - started,
    error: outcome.error ?? null,
  };
}

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

ipcMain.handle('term:attach', async (_e, conversationId: string, cols: number, rows: number) => {
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

  // If a live daemon exists for this session, attach to it. Otherwise this is
  // a "cold" session (e.g. one restored from a saved transcript that no longer
  // has a running daemon) — fall back to `claude --resume <sid>` in the
  // session's original cwd, which loads the transcript and continues it.
  const live = await hasLiveDaemon(attachId);
  let replay = '';
  if (live) {
    console.log('[agentsflow] spawning pty for claude attach', { attachId, sessionId: conv.sessionId, channelId });
    replay = pty.attach({ channelId, sessionId: attachId, cols, rows, win, mode: 'attach' });
  } else {
    console.log('[agentsflow] no live daemon — using --resume', { sessionId: conv.sessionId, cwd: conv.directoryPath, channelId });
    replay = pty.attach({ channelId, sessionId: conv.sessionId, cols, rows, win, mode: 'resume', cwd: conv.directoryPath });
  }
  return { channelId, replay };
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

// --- Slash command / skill discovery -------------------------------------
// Parses a one-line description from a command/skill markdown file: prefers a
// YAML frontmatter `description:` field, otherwise falls back to the first
// non-empty, non-heading line.
function describeMarkdown(filePath: string): string {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.split(/\r?\n/);
  // YAML frontmatter block delimited by ---
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '---') break;
      const m = /^description\s*:\s*(.+)$/i.exec(t);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
    // No description in frontmatter — use first body line after it.
    const end = lines.indexOf('---', 1);
    for (let i = end + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t && !t.startsWith('#')) return t;
    }
    return '';
  }
  for (const line of lines) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t;
  }
  return '';
}

// Reads all slash commands and skills under a single `.claude` directory.
// `commands/*.md` (recursively, ":"-namespaced) become commands; each
// `skills/<name>/SKILL.md` becomes a skill.
function readClaudeScope(claudeDir: string, scope: 'project' | 'user'): SlashCommand[] {
  const out: SlashCommand[] = [];

  const commandsDir = path.join(claudeDir, 'commands');
  const walkCommands = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walkCommands(full, `${prefix}${ent.name}:`);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        const name = `${prefix}${ent.name.replace(/\.md$/, '')}`;
        out.push({
          name,
          invocation: `/${name}`,
          description: describeMarkdown(full),
          scope,
          kind: 'command',
          source: full,
        });
      }
    }
  };
  walkCommands(commandsDir, '');

  const skillsDir = path.join(claudeDir, 'skills');
  let skillEntries: fs.Dirent[] = [];
  try {
    skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    /* no skills dir */
  }
  for (const ent of skillEntries) {
    if (!ent.isDirectory()) continue;
    const skillFile = path.join(skillsDir, ent.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    out.push({
      name: ent.name,
      invocation: `/${ent.name}`,
      description: describeMarkdown(skillFile),
      scope,
      kind: 'skill',
      source: skillFile,
    });
  }

  return out;
}

ipcMain.handle('skills:list', async (_e, dirPath: string | null): Promise<SlashCommand[]> => {
  const byName = new Map<string, SlashCommand>();
  // User scope first so project entries overwrite (shadow) same-named ones.
  const userClaude = path.join(app.getPath('home'), '.claude');
  for (const cmd of readClaudeScope(userClaude, 'user')) byName.set(cmd.name, cmd);
  if (dirPath) {
    const projectClaude = path.join(dirPath, '.claude');
    for (const cmd of readClaudeScope(projectClaude, 'project')) byName.set(cmd.name, cmd);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
});

ipcMain.handle('git:status', async (_e, dirPath: string) => gitStatus(dirPath));
ipcMain.handle('files:list', async (_e, dirPath: string) => listFiles(dirPath));
ipcMain.handle('files:search', async (_e, dirPath: string, query: string, opts) => {
  try {
    return await searchInFiles(dirPath, query, opts);
  } catch (err) {
    return { files: [], totalMatches: 0, filesScanned: 0, truncated: false, error: (err as Error)?.message ?? String(err) };
  }
});

// ---- Notes: a per-peer private scratch folder kept OUTSIDE the project ------
// Each tracked directory ("peer") gets its own notes folder under Peers Flow's
// app-data, so note files never appear in the project tree or git. Keyed on the
// peer's tracked-directory id (stable across display-name renames); falls back
// to a hash of the path for any dir not in the store. Once the absolute root is
// known, every mutation reuses the existing files:* handlers unchanged.
function notesRootFor(dirPath: string): string {
  const match = store.getDirectories().find((d) => d.path === dirPath);
  const key = match
    ? match.id
    : require('crypto').createHash('sha1').update(dirPath).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'notes', key);
}

ipcMain.handle('notes:root', async (_e, dirPath: string): Promise<{ root: string }> => {
  const root = notesRootFor(dirPath);
  fs.mkdirSync(root, { recursive: true });
  return { root };
});

ipcMain.handle('notes:list', async (_e, root: string): Promise<FileEntry[]> => {
  // Plain recursive walk — the notes folder isn't a git repo and notes have no
  // changed/ignored concept, so we deliberately skip the git-aware listFiles().
  const out: FileEntry[] = [];
  const walk = (sub: string) => {
    const here = sub ? path.join(root, sub) : root;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name === '.DS_Store') continue;
      const rel = sub ? path.join(sub, ent.name) : ent.name;
      if (ent.isDirectory()) walk(rel);
      else out.push({ path: rel, isIgnored: false });
    }
  };
  walk('');
  return out;
});

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
  // Write to a temp sibling and rename into place — writeFileSync truncates
  // before writing, so a crash mid-write would leave the file empty.
  const tmp = `${filePath}.${process.pid}.agentsflow-tmp`;
  fsMod.writeFileSync(tmp, content, 'utf8');
  try {
    fsMod.renameSync(tmp, filePath);
  } catch (err) {
    try { fsMod.unlinkSync(tmp); } catch {}
    throw err;
  }
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
    pdf: 'application/pdf',
  };
  try {
    const stat = fsMod.statSync(filePath);
    const ext0 = pathMod.extname(filePath).slice(1).toLowerCase();
    // Bump the cap for PDFs — scans and multi-page documents routinely
    // exceed the 8 MB image budget but Chromium handles them fine.
    const MAX = ext0 === 'pdf' ? 64 * 1024 * 1024 : 8 * 1024 * 1024;
    if (stat.size > MAX) return { dataUrl: '', mime: '', size: stat.size, truncated: true };
    const ext = pathMod.extname(filePath).slice(1).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const buf = fsMod.readFileSync(filePath);
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, size: stat.size, truncated: false };
  } catch (err) {
    return { dataUrl: '', mime: '', size: 0, truncated: false, error: (err as Error).message };
  }
});

ipcMain.handle('files:create', async (_e, filePath: string) => {
  const fsMod = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  if (!pathMod.isAbsolute(filePath)) {
    throw new Error('create: path must be absolute');
  }
  fsMod.mkdirSync(pathMod.dirname(filePath), { recursive: true });
  // 'wx' fails if the file already exists — creating must never clobber.
  fsMod.writeFileSync(filePath, '', { encoding: 'utf8', flag: 'wx' });
  return { ok: true as const };
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

ipcMain.handle('files:revealInFinder', async (_e, targetPath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
  const fsMod = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  if (!pathMod.isAbsolute(targetPath)) return { ok: false, error: 'path must be absolute' };
  if (!fsMod.existsSync(targetPath)) return { ok: false, error: `path does not exist: ${targetPath}` };
  // Selects the file/dir in the OS file browser (Finder on macOS, Explorer
  // on Windows, the default file manager on Linux).
  shell.showItemInFolder(targetPath);
  return { ok: true };
});

ipcMain.handle('files:startDrag', async (e, filePath: string): Promise<void> => {
  if (!path.isAbsolute(filePath)) return;
  if (!fs.existsSync(filePath)) return;
  // Prefer the OS-rendered file icon (Finder-style). Fall back to a 1x1
  // PNG because Electron rejects an empty NativeImage.
  let icon = await app.getFileIcon(filePath, { size: 'small' }).catch(() => null);
  if (!icon || icon.isEmpty()) {
    icon = nativeImage.createFromBuffer(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Vx5y3wAAAAASUVORK5CYII=', 'base64'),
    );
  }
  e.sender.startDrag({ file: filePath, icon });
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

ipcMain.handle('images:saveFromPaste', async (_e, dataBase64: string, mimeType: string): Promise<{ savedPath: string }> => {
  const fsMod = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const root = pastedImagesRoot(app.getPath('userData'));
  const targetDir = pathMod.join(root, todayDateSlug());
  fsMod.mkdirSync(targetDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const fullPath = pathMod.join(targetDir, filename);
  const buf = Buffer.from(dataBase64, 'base64');
  fsMod.writeFileSync(fullPath, buf);
  try { prunePastedImages(root); } catch {}
  return { savedPath: fullPath };
});

ipcMain.handle('images:saveToDir', async (_e, targetDir: string, dataBase64: string, mimeType: string): Promise<{ savedPath: string }> => {
  const fsMod = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  if (!pathMod.isAbsolute(targetDir)) {
    throw new Error('saveToDir: targetDir must be absolute');
  }
  const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  fsMod.mkdirSync(targetDir, { recursive: true });
  const filename = `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const fullPath = pathMod.join(targetDir, filename);
  // 'wx' — never clobber an existing file, however unlikely the name collision.
  fsMod.writeFileSync(fullPath, Buffer.from(dataBase64, 'base64'), { flag: 'wx' });
  return { savedPath: fullPath };
});
