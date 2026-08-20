import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, powerMonitor, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { v4 as uuid } from 'uuid';
import serve from 'electron-serve';
import { installCrashLogging, notePowerResume, notePowerSuspend, registerHealthProbe } from './logger';
import * as perf from './perf';

const APP_NAME = 'Peers Flow';
app.setName(APP_NAME);

// Earliest possible: mirror console.* to a log file and install last-resort
// uncaughtException/unhandledRejection/process-gone handlers, so any future
// incident leaves a trace on disk instead of only an OS-level .ips report.
installCrashLogging();

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
import { getUsage, getUsageForService, resetUsageCache } from './usage';
import * as accounts from './accounts';
import * as rotation from './rotation';
import * as limitWatch from './limit-watch';
import { forkTitle } from '../shared/fork-title';
import { transcriptExists as transcriptExistsUnder } from './transcript-path';
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
import { refreshNow, setPollerForeground, startPoller, stopPoller, syncWatchers, unwatchConversation, watchConversation, watcherStats } from './poller';
import { bridgeSocketPath, buildBootstrapSystemPrompt, getMcpServerInfo, writeMcpConfigForConversation } from './mcp-bridge';
import { buildDelegatePrompt } from './registry';
import { startPeersBridge, type DelegateRequest, type OpenFileRequest, type PeersBridge } from './delegation-bridge';
import * as pty from './pty-manager';
import * as fileWatcher from './file-watcher';
import { gitStatus, listBranches, listFiles, listWorktrees, removeWorktree } from './git';
import { searchInFiles } from './search';
import { deleteAttachmentFiles, pastedImagesRoot, prunePastedImages, sweepOrphanAttachments, todayDateSlug } from './attachments';
import { noteDirForPath, sweepNoteDir, sweepNoteImages } from './note-images';
import { Account, AccountsSnapshot, AddAccountResult, BridgeHealth, Conversation, FileEntry, PinnedDivider, PinnedItemRef, PinnedTodo, ProbeAccountResult, RotationPolicy, SlashCommand, SpawnRequest, SwitchAccountResult, TrackedDirectory, UsageResult } from '../shared/types';

const isDev = process.env.NODE_ENV === 'development';
const loadURL = isDev ? null : serve({ directory: path.join(__dirname, '..', '..', '..', 'renderer', 'out') });

let mainWindow: BrowserWindow | null = null;
let peersBridge: PeersBridge | null = null;

// Single-instance guard. Two overlapping mains race on the delegation-bridge
// socket: the one that quits first runs its teardown `unlinkSync` and deletes
// the SURVIVOR's socket file, leaving a bound-but-unreachable listener — every
// `delegate` then silently degrades to a headless (unwatchable) run for the
// rest of the session. Preventing a second instance removes that race at the
// root. The second launch quits immediately; we just focus the live window.
//
// Both sides of this handshake log. Silently, it produced a log that read like
// a crash: a `main process start` followed by `before-quit` in the same second,
// with nothing saying why — which is exactly what a fresh `npm run dev` against
// an already-running instance looks like. In dev that also tears down the whole
// new stack (`concurrently -k` kills `next` when `electron` exits), so it
// presents to the user as "the app won't start"/"the app crashed".
if (!app.requestSingleInstanceLock()) {
  console.log(
    '[agentsflow][lifecycle] another instance already holds the single-instance lock — exiting this one. ' +
      'The running instance was focused instead; quit it first if you meant to restart.',
  );
  app.quit();
}
app.on('second-instance', () => {
  // Logged on the *holder* side: a launch attempt against a live instance is a
  // strong breadcrumb that the user was trying to restart, which is context you
  // want when reading back whatever happened to this process next.
  console.log('[agentsflow][lifecycle] second-instance launch attempt — focusing the existing window');
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

/**
 * A snapshot of the delegation bridge's reachability for the renderer's health
 * dot / MCP modal. Falls back to an all-false snapshot if the bridge never came
 * up (so the UI shows "down" rather than nothing).
 */
function bridgeHealthSnapshot(): BridgeHealth {
  return (
    peersBridge?.health() ?? {
      socketPath: bridgeSocketPath(),
      listening: false,
      socketFileExists: false,
      healthy: false,
    }
  );
}

// Feed the heartbeat the subsystem counts worth trending over a long session:
// the PTY/pty-budget numbers whose exhaustion has historically aborted the app,
// and whether the delegation bridge is still reachable.
registerHealthProbe(() => ({
  ...pty.ptyStats(),
  ...watcherStats(),
  convs: store.getConversations().length,
  bridgeOk: bridgeHealthSnapshot().healthy,
}));

// ----- Per-operation performance instrumentation -----
// Wrap ipcMain.handle ONCE so every IPC handler (all of them live in this file)
// is timed and attributed to the peer it touched — no per-call-site changes, and
// future handlers are covered automatically. Slow ops (> perf.SLOW_MS) log
// immediately; a periodic summary + the stall dump surface the bottleneck when
// the UI lags. Peer resolution is lazy (only slow ops pay for it), so hot
// channels like term:write stay cheap. Must run before the first handler below.
function resolvePeerForArgs(args: unknown[]): string | undefined {
  const dirs = store.getDirectories();
  for (const a of args) {
    if (typeof a !== 'string' || !a) continue;
    const byId = dirs.find((d) => d.id === a);
    if (byId) return byId.displayName;
    const conv = store.getConversations().find((c) => c.id === a);
    if (conv) return conv.displayName;
    if (a.includes('/')) {
      const byPath = dirs.find((d) => a === d.path || a.startsWith(`${d.path}/`));
      if (byPath) return byPath.displayName;
    }
  }
  return undefined;
}

type IpcHandleFn = typeof ipcMain.handle;
const rawIpcHandle: IpcHandleFn = ipcMain.handle.bind(ipcMain);
const timedIpcHandle: IpcHandleFn = (channel, listener) =>
  rawIpcHandle(channel, (event, ...args) =>
    perf.timed(channel, () => listener(event, ...args), () => resolvePeerForArgs(args)),
  );
ipcMain.handle = timedIpcHandle;

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
  // Renderer-side stalls are observable from the main process even when the
  // renderer itself is wedged — pure diagnosis signal for a freeze report.
  win.webContents.on('unresponsive', () => console.error('[agentsflow][stall] renderer unresponsive'));
  win.webContents.on('responsive', () => console.log('[agentsflow][stall] renderer responsive again'));

  // Drive the poller's cadence from window visibility: fast 5s polling only
  // matters while the user is actually looking at the dots. Blur/hide/minimize
  // → back off to the slow cadence (kills the steady `claude agents --json`
  // churn while backgrounded); focus/show/restore → refresh immediately and go
  // fast again. macOS can't report cross-Space occlusion, so focus is the best
  // available proxy for "the user is elsewhere".
  const toBackground = () => setPollerForeground(false);
  const toForeground = () => setPollerForeground(true);
  win.on('focus', toForeground);
  win.on('show', toForeground);
  win.on('restore', toForeground);
  win.on('blur', toBackground);
  win.on('hide', toBackground);
  win.on('minimize', toBackground);

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
  perf.startPerfSummary();
  // Keep every pooled account's refresh token alive so "sign in once" holds
  // even for an account that has not been switched to in months.
  accounts.startKeepWarm(() => store.getAccounts(), () => store.getActiveAccountId());
  // Keep the active account's two copies of its tokens in agreement, and repair
  // the signed-in slot if it is the stale one. Started before anything can
  // spawn a session: a launch after the app has been closed for hours is exactly
  // when the main slot is most likely to be found stranded.
  accounts.startCredentialSync(credentialSyncDeps);
  // Watch the active account's meters and switch before it hits the wall. Opt-in
  // (disabled by default); the loop no-ops until the user enables it.
  rotation.startRotation(rotationDeps);
  // And catch the walls the threshold misses: a chat that reports a rate limit
  // gets a fresh account and a "continue" rather than sitting dead till morning.
  limitWatch.startLimitWatch(limitWatchDeps);

  // OS sleep/wake: tell the stall detector so the multi-minute gap it sees on
  // resume is logged as a power event, not a "UI frozen" false alarm, and back
  // the poller off while suspended. (powerMonitor is only available after
  // `ready`, which is why this lives here rather than in installCrashLogging.)
  powerMonitor.on('suspend', () => { notePowerSuspend(); setPollerForeground(false); });
  powerMonitor.on('lock-screen', () => { notePowerSuspend(); setPollerForeground(false); });
  const onWake = () => {
    notePowerResume();
    // A machine that slept through the access token's lifetime wakes up in the
    // same state as a cold launch, so check the login before work resumes.
    void accounts.syncActiveCredentials(credentialSyncDeps);
    // Only resume fast polling if the window is actually in front on wake.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
      setPollerForeground(true);
    }
  };
  powerMonitor.on('resume', onWake);
  powerMonitor.on('unlock-screen', onWake);

  // The bridge must be live before any session can call `delegate` / `open_file`.
  // The handlers are hoisted (function declarations), so it's safe to reference them here.
  try {
    peersBridge = startPeersBridge(bridgeSocketPath(), {
      onDelegate: handleDelegate,
      onOpenFile: handleOpenFile,
    });
  } catch (err) {
    console.error('[agentsflow] failed to start peers bridge', err);
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

  // Orphaned note images: pasted screenshots whose last markdown reference is
  // gone (note deleted, or the live editor GC missed them). Once at startup,
  // then periodically — cheap (notes dirs are tiny) and age-guarded.
  const sweepNotes = () => {
    try {
      const result = sweepNoteImages(path.join(app.getPath('userData'), 'notes'));
      if (result.deleted > 0) console.log('[agentsflow] swept orphaned note images', result);
    } catch (err) {
      console.error('[agentsflow] note-image sweep failed', err);
    }
  };
  sweepNotes();
  setInterval(sweepNotes, 6 * 60 * 60 * 1000);

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
  try { peersBridge?.stop(); } catch { /* ignore */ }
  // Flush any debounced store changes synchronously so a quit never loses the
  // last few mutations (the async debounce window would otherwise drop them).
  try { store.flushSync(); } catch { /* ignore */ }
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
function broadcastTodos(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('todos:updated', store.getTodos());
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

ipcMain.handle('mcp:info', () => ({
  ...getMcpServerInfo(store.getDirectories()),
  bridge: bridgeHealthSnapshot(),
}));

// Lightweight liveness poll for the header health dot — avoids rebuilding the
// full MCP descriptor (which rescans peers/skills) on every tick.
ipcMain.handle('bridge:health', () => bridgeHealthSnapshot());

// Live plan-usage meters for the sidebar Usage panel. Read-only against the
// authenticated `/usage` endpoint; cached briefly inside getUsage().
ipcMain.handle('usage:get', (_e, force?: boolean) => getUsage(Boolean(force)));

// ----- Account pool -----
// Switching moves an account's credentials into the single keychain slot Claude
// Code reads, so sessions that are already running pick it up on their next
// keychain read (the CLI caches those for 30s). No browser, no login.

// Only ever set for the unrepairable case — see AccountsSnapshot.authIssue.
let authIssue: string | null = null;

function accountsSnapshot(): AccountsSnapshot {
  return { accounts: store.getAccounts(), activeId: store.getActiveAccountId(), authIssue };
}

function broadcastAccounts(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('accounts:updated', accountsSnapshot());
  }
}

// ----- Credential reconciliation -----
// The active account's tokens live in two keychain slots at once and only one of
// them can be current, because refreshing rotates the token. Left alone they
// drift apart and the CLI ends up holding the spent copy, which it reacts to by
// wiping its credentials and demanding `/login`. This loop keeps them in step —
// the fix for having to switch away and back to get working again.

// This runs every minute, and an unresolvable state would otherwise report
// itself 1440 times a day into the same log file that has frozen the app before.
let lastReconcileOutcome: string | null = null;

function applyReconcile(account: Account, result: accounts.ReconcileResult): void {
  const previousIssue = authIssue;
  const changed = result.outcome !== lastReconcileOutcome;
  lastReconcileOutcome = result.outcome;

  if (changed && result.outcome !== 'in-sync') {
    console.log('[agentsflow][accounts] reconcile', { email: account.email, outcome: result.outcome });
  }

  switch (result.outcome) {
    case 'in-sync':
    case 'adopted-main':
      // Routine. Nothing to tell anyone: this is the loop doing its job.
      authIssue = null;
      break;

    case 'repaired-main':
      // The panel is very likely showing a signed-out Usage meter cached from
      // while the slot was broken, so drop it rather than make the user wait it out.
      resetUsageCache();
      authIssue = null;
      break;

    case 'foreign':
      // The keychain, not our JSON, is the truth about who is signed in. If the
      // login belongs to another pooled account, follow it instead of arguing.
      if (result.ownerAccountId && result.ownerAccountId !== store.getActiveAccountId()) {
        console.log('[agentsflow][accounts] the signed-in slot belongs to a different pooled account — following it');
        store.setActiveAccountId(result.ownerAccountId);
        resetUsageCache();
        authIssue = null;
        broadcastAccounts();
        return;
      }
      authIssue = null;
      break;

    case 'signed-out':
    case 'failed':
      authIssue = result.error;
      break;
  }

  // Broadcast on change only — this runs every minute.
  if (authIssue !== previousIssue || result.outcome === 'repaired-main') {
    broadcastAccounts();
  }
}

const credentialSyncDeps: accounts.SyncDeps = {
  getAccounts: () => store.getAccounts(),
  getActiveId: () => store.getActiveAccountId(),
  onResult: applyReconcile,
};

ipcMain.handle('accounts:list', () => accountsSnapshot());

ipcMain.handle('accounts:add', (_e, email: string): AddAccountResult => {
  const trimmed = (email ?? '').trim();
  if (!accounts.isEmailAddress(trimmed)) {
    return { ok: false, error: 'Enter an email address (…@gmail.com, or your work domain).' };
  }
  const existing = store.getAccounts();
  if (existing.some((a) => a.email.toLowerCase() === trimmed.toLowerCase())) {
    return { ok: false, error: `${trimmed} is already in the pool.` };
  }
  try {
    const entry = accounts.beginAdd(trimmed);
    // Queue the one-time login so it starts the moment the terminal attaches.
    pty.queueShellCommand(entry.shellId, accounts.loginCommandFor(entry.configDir, entry.email));
    return { ok: true, pendingId: entry.pendingId, shellId: entry.shellId, email: entry.email, cwd: os.homedir() };
  } catch (err) {
    return { ok: false, error: `Could not prepare the account: ${(err as Error)?.message ?? err}` };
  }
});

ipcMain.handle('accounts:probe', async (_e, pendingId: string): Promise<ProbeAccountResult> => {
  const result = await accounts.probeAdd(pendingId, store.getAccounts());
  if (result.status === 'ok') {
    store.addAccount(result.account);
    // Adding never changes who is signed in. But if this account IS the login
    // that predates the pool, record that — otherwise the panel would claim
    // nobody is active until the user switched to the account they are already on.
    if (
      !store.getActiveAccountId() &&
      result.account.accountUuid &&
      result.account.accountUuid === accounts.currentLoginAccountUuid()
    ) {
      store.setActiveAccountId(result.account.id);
    }
    broadcastAccounts();
  }
  return result;
});

ipcMain.handle('accounts:cancelAdd', async (_e, pendingId: string) => {
  const entry = accounts.getPending(pendingId);
  if (!entry) return;
  pty.cancelShellCommand(entry.shellId);
  accounts.clearPending(pendingId);
  await accounts.destroyVault(entry.configDir);
});

ipcMain.handle('accounts:remove', async (_e, id: string) => {
  const account = store.getAccounts().find((a) => a.id === id);
  if (!account) return;
  store.removeAccount(id);
  await accounts.destroyVault(account.configDir);
  broadcastAccounts();
});

ipcMain.handle('accounts:switch', async (_e, id: string): Promise<SwitchAccountResult> => {
  try {
    const account = await accounts.switchTo(id, {
      accounts: store.getAccounts(),
      activeId: store.getActiveAccountId(),
      onSwitched: (a) => store.setActiveAccountId(a.id),
    });
    resetUsageCache();
    broadcastAccounts();
    return { ok: true, account };
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    console.error('[agentsflow][accounts] switch failed', { id, error });
    return { ok: false, error };
  }
});

// Force a reconcile now. The loop already does this every minute, so this is
// only ever "I am looking at the banner and want it checked again this second".
ipcMain.handle('accounts:repair', async (): Promise<AccountsSnapshot> => {
  await accounts.syncActiveCredentials(credentialSyncDeps);
  return accountsSnapshot();
});

ipcMain.handle('accounts:usage', (_e, id: string, force?: boolean) => {
  const account = store.getAccounts().find((a) => a.id === id);
  if (!account) {
    return { ok: false, reason: 'no-auth', error: 'Account not found.' } as const;
  }
  return accountUsage(account, Boolean(force));
});

// ----- Automatic rotation -----
// Runs the same switchTo() the button calls, on a threshold. Lives here rather
// than in the renderer so an overnight run keeps rotating with the window shut.

async function accountUsage(account: Account, force: boolean): Promise<UsageResult> {
  const service = accounts.serviceNameFor(account.configDir);
  // A standby account's access token dies hours after the daily keep-warm
  // sweep, so freshen it just before reading. Never the active account, whose
  // refresh token the running CLI is holding — and an unknown active id proves
  // nothing about which account that is, so it means "leave every one alone".
  const activeId = store.getActiveAccountId();
  if (account.id === activeId) return getUsageForService(service, force);
  // No recorded active account is a state that does not self-heal, so it must
  // not simply disable freshening — that would restore the overnight blindness
  // permanently. Fall back to the login's own identity, and act only on a
  // positive "this is not it".
  if (!activeId && !accounts.provablyNotTheLogin(account)) return getUsageForService(service, force);

  await accounts.freshenAccountToken(account, { force });
  const result = await getUsageForService(service, force);
  // A network blip is not a token problem, and an account with no credentials
  // at all cannot be refreshed into having some. Only spend a re-mint on a
  // reply that could actually be an expired token.
  if (result.ok || result.reason === 'network' || result.reason === 'no-auth') return result;

  // The stored expiry said the token was fine and the endpoint disagreed. The
  // endpoint is the authority (it answers an expired token with 429, which is
  // indistinguishable from real rate-limiting), so re-mint once on its word:
  // without this, an account whose expiry bookkeeping is wrong stays invisible
  // to rotation indefinitely — the very failure this whole path exists to end.
  const reminted = await accounts.freshenAccountToken(account, { force: true, distrustStoredExpiry: true });
  return reminted ? getUsageForService(service, true) : result;
}

const rotationDeps: rotation.RotationDeps = {
  getPolicy: () => store.getRotationPolicy(),
  getAccounts: () => store.getAccounts(),
  getActiveId: () => store.getActiveAccountId(),
  getAccountUsage: (account, force) => accountUsage(account, force),
  getActiveUsage: (force) => getUsage(force),
  switchTo: async (accountId) => {
    const account = await accounts.switchTo(accountId, {
      accounts: store.getAccounts(),
      activeId: store.getActiveAccountId(),
      onSwitched: (a) => store.setActiveAccountId(a.id),
    });
    resetUsageCache();
    broadcastAccounts();
    return account;
  },
  onStatus: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('rotation:status', status);
    }
  },
};

// ----- The wall that got hit anyway -----
// Same switch, triggered by a chat's own rate-limit error instead of by a
// meter. Lives beside rotation because it shares the switch, the policy and the
// status line — see limit-watch.ts for why a forecast alone isn't enough.
const limitWatchDeps: limitWatch.LimitWatchDeps = {
  getPolicy: () => store.getRotationPolicy(),
  getConversations: () => store.getConversations(),
  rotate: () => rotation.runOnce(rotationDeps, { urgent: true }),
  nudge: (conv, text) => {
    // Snapshotted BEFORE anything is typed: the receipt for this nudge is a
    // user turn that wasn't in the transcript a moment ago.
    //
    // Zero means the transcript could not be read (or holds no user turn yet),
    // and then "a user turn exists" proves nothing — it would match the
    // session's own opening prompt. Every chat this path rescues has a
    // transcript deep enough to have one, since that is where its rate-limit
    // error was found, so a zero here is an anomaly and gets no false receipt.
    const before = limitWatch.lastUserTurnAt(conv);
    return pty.sendToSession({
      sessionId: conv.sessionId,
      // Mirrors term:attach's rule: the daemon short id when there is one, else
      // the session id's own 8-char prefix.
      attachId: conv.daemonShort || conv.sessionId.slice(0, 8),
      text,
      verify: before > 0 ? () => limitWatch.lastUserTurnAt(conv) > before : undefined,
    });
  },
  onEvent: (message) => rotation.recordEvent(rotationDeps, message),
};

ipcMain.handle('rotation:get', () => ({
  policy: store.getRotationPolicy(),
  status: rotation.getStatus(),
}));

ipcMain.handle('rotation:set', (_e, policy: RotationPolicy) => {
  const saved = store.setRotationPolicy(policy);
  // Turning it back on is also how a user clears a failure stop.
  if (saved.enabled) rotation.clearDisabled();
  console.log('[agentsflow][rotation] policy updated', saved);
  return { policy: saved, status: rotation.getStatus() };
});

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
  // Model alias passed to `claude --model`; undefined ⇒ CLI default.
  model?: string;
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
  const dispatch = await dispatchBackground({ cwd: dir.path, prompt, mcpConfigPath, appendSystemPrompt, model: opts.model });
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

  // Don't block the spawn on a full `claude agents --json` poll. The 5s poller
  // and the per-conversation file-watcher already reconcile this session, and
  // awaiting a refresh here both added ~1.5s of latency to every spawn AND
  // injected an extra heavy agent-list spawn into the middle of a spawn burst —
  // the main driver of the multi-second spawn latency observed under load. Fire
  // it detached so a not-yet-listed daemon is still picked up promptly, then
  // return on the optimistic + job-state we already applied above.
  void refreshNow().catch(() => undefined);
  broadcastConversations();
  return { conversationId, sessionId, daemonShort };
}

ipcMain.handle('convs:spawn', async (_e, req: SpawnRequest): Promise<{ conversationId: string; sessionId: string; daemonShort: string }> => {
  const dir = store.getDirectories().find((d) => d.id === req.directoryId);
  if (!dir) throw new Error('directory not found');
  const prompt = req.prompt.trim();
  if (!prompt) throw new Error('prompt required');
  return spawnConversation({ dir, prompt, attachments: req.attachments, model: req.model, pinned: true, peerAware: true });
});

// How long a freshly minted fork can absorb further ⑂ clicks on its source
// before they start minting new forks again. Sized for "nothing happened, click
// it again" on a laggy UI — a burst lands inside a few seconds — not for a
// considered second branch minutes later. A fork with an unparseable createdAt
// scores NaN here and fails the comparison, which mints: the safe direction.
const FORK_DEDUPE_WINDOW_MS = 30_000;

// Branch a copy of an existing conversation's session. The fork gets its own
// conversation entry and a pre-assigned session id; the transcript itself is
// materialized lazily on the fork's first attach, which runs
// `claude --resume <source> --fork-session --session-id <new>`. Forking is the
// escape hatch when the original can neither be attached nor resumed — e.g. a
// bg daemon stuck in a crash-respawn loop: `--fork-session` branches the
// transcript without needing the resident session at all.
ipcMain.handle('convs:fork', async (_e, conversationId: string): Promise<{ conversationId: string }> => {
  const src = store.getConversations().find((c) => c.id === conversationId);
  if (!src) throw new Error(`conversation ${conversationId} not found`);
  if (!src.sessionId) throw new Error('source session has no sessionId yet — nothing to fork');

  // Forking is one click, but each fork that gets opened costs a *persistent*
  // `claude --resume` PTY which lives until it has been both detached and silent
  // past the reaper's TTL — so a user clicking ⑂ repeatedly (exactly what a
  // sluggish UI invites) multiplies heavyweight sessions with nothing to stop it.
  // On 2026-07-23 five forks of one session inside two minutes helped push the
  // machine to 453/511 ptys. A fork that has never been opened has no content of
  // its own yet, so it is indistinguishable from the one the next click would
  // create — hand the existing one back instead of minting a duplicate.
  //
  // That is a DEBOUNCE, though, and it was first written as a permanent rule:
  // one live un-opened fork per source blocked every later click on that source,
  // forever. Deliberately branching the same session twice is legitimate — two
  // parallel attempts from the same history — and the two failure modes are not
  // symmetric. Reusing too eagerly silently teleports the user into somebody
  // else's branch and leaves them no way to fork at all; reusing too rarely
  // leaves an extra idle row they can see and delete. So bias to minting, and
  // require all three signals to agree that this click is a repeat of the last:
  // recent, still seeded-idle (never attached), and no transcript on disk.
  const cutoff = Date.now() - FORK_DEDUPE_WINDOW_MS;
  const unopened = store.getConversations().find(
    (c) =>
      c.forkFromSessionId === src.sessionId &&
      c.sessionId &&
      Date.parse(c.createdAt) >= cutoff &&
      c.state === 'idle' &&
      c.status === 'idle' &&
      !transcriptExists(c.directoryPath, c.sessionId),
  );
  if (unopened) {
    console.log('[agentsflow] reusing existing un-opened fork instead of creating another', {
      from: src.id, fromSession: src.sessionId, existing: unopened.id,
    });
    return { conversationId: unopened.id };
  }

  const fork: Conversation = {
    id: uuid(),
    sessionId: uuid(),
    daemonShort: '',
    sessionName: '',
    directoryId: src.directoryId,
    directoryPath: src.directoryPath,
    displayName: src.displayName,
    title: forkTitle(src.title || src.description),
    description: 'forked copy — open the chat to continue',
    pinned: true,
    attachments: [],
    state: 'idle',
    status: 'idle',
    intent: src.intent,
    createdAt: new Date().toISOString(),
    lastPrompt: src.lastPrompt,
    forkFromSessionId: src.sessionId,
  };
  // The fork lands directly below its source in the pinned list, so versions
  // of the same task stay visually grouped in their section.
  store.addConversation(fork, { afterConversationId: src.id });
  broadcastConversations();
  broadcastPinnedOrder();
  console.log('[agentsflow] forked conversation', { from: src.id, fromSession: src.sessionId, to: fork.id, toSession: fork.sessionId });
  return { conversationId: fork.id };
});

// ----- Delegation bridge: the MCP server asks main to spawn a tracked peer ----

// Conversation states that mean the agent has finished its run. Used both to
// resolve a delegated peer's result and to decide attach-vs-resume below.
const FINISHED_STATES = new Set(['done', 'completed', 'failed', 'error']);

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
    if (Date.now() - start > minRunMs && FINISHED_STATES.has(st)) {
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

/**
 * Resolve a peer + file from an `open_file` request, then tell the renderer to
 * navigate to that peer's file view and display the file. Returns a small
 * envelope the calling agent can report back from.
 */
async function handleOpenFile(req: OpenFileRequest): Promise<Record<string, unknown>> {
  const dirs = store.getDirectories();
  const token = (req.directory || '').trim();
  const lower = token.toLowerCase();
  let dir =
    dirs.find((d) => d.id === token) ||
    dirs.find((d) => d.path === token) ||
    dirs.find((d) => d.displayName.toLowerCase() === lower) ||
    dirs.find((d) => path.basename(d.path).toLowerCase() === lower) ||
    null;
  // No (or unknown) directory token → fall back to the directory of the
  // conversation that asked, so "open this file" just works without naming a peer.
  if (!dir && req.rootConversationId) {
    const conv = store.getConversations().find((c) => c.id === req.rootConversationId);
    if (conv) dir = dirs.find((d) => d.id === conv.directoryId) ?? null;
  }
  if (!dir) {
    return { status: 'failure', error: `Unknown peer "${token}". Call list_peers to see valid peers.`, known: dirs.map((d) => d.displayName) };
  }

  const rawFile = (req.file || '').trim();
  if (!rawFile) {
    return { status: 'failure', directory: dir.displayName, error: '`file` is required.' };
  }
  const abs = path.isAbsolute(rawFile) ? path.normalize(rawFile) : path.join(dir.path, rawFile);
  // A relative path must stay inside the peer's directory — no `../` escapes.
  if (!path.isAbsolute(rawFile) && abs !== dir.path && !abs.startsWith(dir.path + path.sep)) {
    return { status: 'failure', directory: dir.displayName, error: `Refusing to open a path outside the peer: ${rawFile}` };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { status: 'failure', directory: dir.displayName, error: `File not found: ${abs}` };
  }
  if (!stat.isFile()) {
    return { status: 'failure', directory: dir.displayName, error: `Not a file: ${abs}` };
  }

  // PDFs render better in a native viewer, so prefer handing them to the OS
  // default application. shell.openPath returns '' on success and an error
  // string when there's no associated app (or it failed to launch) — in that
  // case we fall through to our own in-app PDF preview.
  if (path.extname(abs).toLowerCase() === '.pdf') {
    const openErr = await shell.openPath(abs);
    if (!openErr) {
      return {
        status: 'success',
        directory: dir.displayName,
        directoryPath: dir.path,
        filePath: abs,
        openedWith: 'external',
        summary: `Opened ${path.basename(abs)} in the system's default PDF application.`,
      };
    }
    console.warn('[agentsflow] shell.openPath failed; falling back to in-app editor', abs, openErr);
  }

  const line = typeof req.line === 'number' && req.line > 0 ? Math.floor(req.line) : undefined;
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { status: 'failure', directory: dir.displayName, error: 'Peers Flow window is not available.' };
  }
  // If the request came from a conversation rooted in the same directory as the
  // file, open it inside that conversation's session view (so the user keeps the
  // Chat/File toggle and can flip back to the chat). Otherwise the renderer falls
  // back to the standalone directory Preview.
  const conv = req.rootConversationId
    ? store.getConversations().find((c) => c.id === req.rootConversationId)
    : undefined;
  const conversationId = conv && conv.directoryId === dir.id ? conv.id : undefined;
  mainWindow.webContents.send('navigate:openFile', { directoryId: dir.id, conversationId, filePath: abs, line });
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } catch { /* best-effort focus */ }

  return {
    status: 'success',
    directory: dir.displayName,
    directoryPath: dir.path,
    filePath: abs,
    line: line ?? null,
    openedWith: 'inApp',
    summary: conversationId
      ? `Opened ${path.basename(abs)} in the file pane of this Peers Flow chat — the user can toggle back to Chat anytime.`
      : `Opened ${path.basename(abs)} in Peers Flow (file view of "${dir.displayName}").`,
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

ipcMain.handle('todos:list', () => store.getTodos());

ipcMain.handle('todos:add', (_e, directoryId: string, afterRef: PinnedItemRef | null): PinnedTodo => {
  const todo: PinnedTodo = {
    id: uuid(),
    directoryId,
    text: '',
    createdAt: new Date().toISOString(),
    done: false,
  };
  store.addTodo(todo, afterRef ?? null);
  broadcastTodos();
  broadcastPinnedOrder();
  return todo;
});

ipcMain.handle('todos:updateText', (_e, id: string, text: string) => {
  store.updateTodo(id, { text });
  broadcastTodos();
});

ipcMain.handle('todos:setDone', (_e, id: string, done: boolean) => {
  store.updateTodo(id, { done });
  broadcastTodos();
  broadcastPinnedOrder();
});

ipcMain.handle('todos:remove', (_e, id: string) => {
  store.removeTodo(id);
  broadcastTodos();
  broadcastPinnedOrder();
});

ipcMain.handle('pinned:list', () => store.getPinnedOrder());

ipcMain.handle('pinned:reorder', (_e, orderedRefs: PinnedItemRef[]) => {
  store.setPinnedOrder(Array.isArray(orderedRefs) ? orderedRefs : []);
  broadcastPinnedOrder();
});

// Where Claude Code keeps every session transcript, one dir per project.
function projectsRoot(): string {
  return path.join(app.getPath('home'), '.claude', 'projects');
}

// Has this session materialized a transcript anywhere? Deliberately NOT a plain
// existsSync of the cwd's project dir — see transcript-path.ts for why a live
// session's transcript can be somewhere else entirely.
function transcriptExists(cwd: string, sessionId: string): boolean {
  return transcriptExistsUnder(projectsRoot(), cwd, sessionId);
}

/**
 * The peer-awareness flags a session needs when it is (re)started *in this
 * process* — `claude --resume` / `--fork-session`.
 *
 * `--mcp-config` and `--append-system-prompt` are per-INVOCATION flags. A
 * resume boots a brand-new CLI that reconstructs its system prompt and MCP set
 * from the current command line, NOT from the transcript, so a resume that
 * omits them silently drops the whole `peersflow` server: no `open_file`, no
 * `delegate`, no `list_peers`, and no peer registry in the system prompt. The
 * chat looks identical, which is why this went unnoticed — the session simply
 * stops believing Peers Flow can open a file and falls back to `open -a`.
 *
 * `claude attach` needs none of this: there the daemon is still the original
 * spawn and carries the config it was given.
 */
function resumePeerAwareness(conv: Conversation): { mcpConfigPath?: string; appendSystemPrompt?: string } {
  try {
    return {
      mcpConfigPath: writeMcpConfigForConversation(conv.id, conv.directoryPath),
      appendSystemPrompt: buildBootstrapSystemPrompt(store.getDirectories()),
    };
  } catch (err) {
    console.error('[agentsflow] MCP bootstrap failed — resuming without peer awareness', err);
    return {};
  }
}

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

  // An in-app `claude --resume` PTY already runs this session → re-subscribe
  // to it. This must be checked BEFORE daemon residency: our own resume child
  // registers itself in `claude agents` as an "interactive" session, so the
  // residency check below would misroute the re-attach into a `claude attach`
  // viewer of our own child instead of the PTY we already hold.
  if (pty.hasResumeSession(conv.sessionId)) {
    console.log('[agentsflow] re-attaching live in-app resume pty', { sessionId: conv.sessionId, channelId });
    const replay = await pty.attach({ channelId, sessionId: conv.sessionId, cols, rows, win, mode: 'resume', cwd: conv.directoryPath });
    return { channelId, replay };
  }

  // Pending fork: this conversation has a pre-assigned session id whose
  // transcript doesn't exist yet — materialize it by branching the source
  // session (`--fork-session` works even when the source is resident or
  // crash-looping, which a plain `--resume` refuses). Routed by disk state
  // rather than a one-shot flag, so a fork that failed to boot simply retries
  // on the next attach; once the transcript exists, normal routing takes over.
  // The lookup must be location-independent (see transcriptExists): a fork that
  // entered a worktree keeps its transcript elsewhere, and mistaking that for
  // "never materialized" would re-fork the source over the top of it.
  if (conv.forkFromSessionId && !transcriptExists(conv.directoryPath, conv.sessionId)) {
    console.log('[agentsflow] forking session on first attach', { forkFrom: conv.forkFromSessionId, sessionId: conv.sessionId, channelId });
    const replay = await pty.attach({
      channelId, sessionId: conv.sessionId, cols, rows, win,
      mode: 'resume', cwd: conv.directoryPath, forkFrom: conv.forkFromSessionId,
      ...resumePeerAwareness(conv),
    });
    return { channelId, replay };
  }

  // Decide between `claude attach` (connect to a resident daemon) and
  // `claude --resume` (load a cold transcript from disk and continue it). The
  // deciding factor is RESIDENCY, not the turn-state.
  //
  // A `--bg` background agent stays resident in `claude agents` after its turn
  // ends — listed with a live pid and a turn-state of `working`, `blocked`, or
  // `done`/idle. For ANY such resident agent:
  //   • `claude --resume <id>` is REFUSED ("…is currently running as a
  //     background agent (bg). Use `claude agents` … or add --fork-session…") and
  //     exits at once, so the chat closes the instant it opens — exactly the
  //     "choose path" bug: a done/idle bg agent that could never be reopened.
  //   • `claude attach <id>` connects to the live daemon and stays interactive
  //     whether it's working, blocked, or idle/done — so you can watch it or send
  //     the next turn.
  // So we attach whenever the session is still resident, regardless of turn
  // state. (An earlier guard tried to `--resume` finished-but-resident agents to
  // avoid an attach that "replays and exits"; but that replay-and-exit only
  // happens for a daemon that has actually left the process table, not for a
  // resident idle agent — which attach holds open. That guard caused this bug.)
  //
  // Only a truly cold session — one no longer listed by `claude agents` — is
  // resumed, loading its transcript and continuing it in the original cwd.
  // `hasLiveDaemon` fails open to `true` (attach) when the agents list itself
  // errors: a `--resume` of a live session forks its transcript, whereas an
  // attach that finds no daemon just replays and exits, after which the renderer
  // shows Reopen/Back rather than bouncing home.
  const live = await hasLiveDaemon(attachId);
  let replay = '';
  if (live) {
    console.log('[agentsflow] spawning pty for claude attach', { attachId, sessionId: conv.sessionId, channelId, state: conv.state });
    replay = await pty.attach({ channelId, sessionId: attachId, cols, rows, win, mode: 'attach' });
  } else {
    console.log('[agentsflow] using --resume', { sessionId: conv.sessionId, cwd: conv.directoryPath, channelId, live, state: conv.state });
    replay = await pty.attach({
      channelId, sessionId: conv.sessionId, cols, rows, win,
      mode: 'resume', cwd: conv.directoryPath,
      ...resumePeerAwareness(conv),
    });
  }
  return { channelId, replay };
});

ipcMain.handle('term:attachShell', async (_e, shellId: string, cwd: string, cols: number, rows: number) => {
  console.log('[agentsflow] term:attachShell received', { shellId, cwd, cols, rows });
  if (!shellId || typeof shellId !== 'string') throw new Error('shellId required');
  if (!cwd || typeof cwd !== 'string') throw new Error('cwd required');
  if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const win = mainWindow ?? BrowserWindow.fromWebContents(_e.sender);
  if (!win) throw new Error('no window');
  const channelId = uuid();
  const replay = await pty.attachShell({ shellId, channelId, cwd, cols, rows, win });
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
ipcMain.handle('git:worktrees', async (_e, dirPath: string, refBranch?: string) => listWorktrees(dirPath, refBranch));
ipcMain.handle('git:branches', async (_e, dirPath: string) => listBranches(dirPath));
ipcMain.handle('git:removeWorktree', async (_e, repoDir: string, worktreePath: string, force?: boolean) =>
  removeWorktree(repoDir, worktreePath, force));
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

// The single GLOBAL notes folder — not tied to any tracked peer. Shared across
// every peer and surfaced at the bottom of the home screen's Tracked Peers pane.
// Stored under the same app-data notes/ tree as per-peer notes, keyed on a
// reserved name that can't collide with a peer id or path hash. Reuses every
// notes:list / files:* mutation handler unchanged.
function globalNotesRoot(): string {
  return path.join(app.getPath('userData'), 'notes', '__global__');
}

ipcMain.handle('notes:globalRoot', async (): Promise<{ root: string }> => {
  const root = globalNotesRoot();
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
  // Deleting a note (or anything else inside a note folder) can orphan pasted
  // images only that file referenced — sweep just that folder right away.
  // Age-guarded, so a freshly pasted image in a still-open editor is safe.
  const noteDir = noteDirForPath(pathMod.join(app.getPath('userData'), 'notes'), targetPath);
  if (noteDir) {
    try { sweepNoteDir(noteDir); } catch {}
  }
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

// Resolves a bare token pulled from terminal output (an absolute path, a
// `~`-prefixed path, or a path relative to the terminal's cwd) to an absolute
// path and reports whether it exists on disk. The terminal link provider calls
// this while hovering a line so that ONLY real, resolvable paths light up as
// clickable — a non-existent match never becomes a link. Kept cheap (a single
// existsSync) because it runs per candidate token on hover.
ipcMain.handle(
  'files:probePath',
  async (_e, baseDir: string | null, token: string): Promise<{ exists: boolean; absPath: string } | null> => {
    if (typeof token !== 'string' || !token || token.length > 4096) return null;
    let candidate = token;
    if (candidate === '~' || candidate.startsWith('~/')) {
      candidate = path.join(app.getPath('home'), candidate.slice(1));
    }
    let abs: string;
    if (path.isAbsolute(candidate)) {
      abs = path.normalize(candidate);
    } else if (baseDir && path.isAbsolute(baseDir)) {
      abs = path.resolve(baseDir, candidate);
    } else {
      // A relative token with no base directory to anchor it — unresolvable.
      return null;
    }
    let exists = false;
    try {
      exists = fs.existsSync(abs);
    } catch {
      exists = false;
    }
    return { exists, absPath: abs };
  },
);

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

ipcMain.handle('clipboard:copyImageData', async (_e, dataBase64: string): Promise<{ ok: true } | { ok: false; error: string }> => {
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(dataBase64, 'base64'));
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
