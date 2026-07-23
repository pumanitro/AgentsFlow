import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { invalidateGitCache } from './git';

// Lazy require — keep the module loadable even if the native binding is missing
// in dev (e.g. before electron-rebuild has been run for a new Electron version).
let parcelMod: typeof import('@parcel/watcher') | null = null;
function getParcel(): typeof import('@parcel/watcher') {
  if (!parcelMod) parcelMod = require('@parcel/watcher');
  return parcelMod!;
}

// Top-level paths to exclude from watching. Matches VS Code's
// `files.watcherExclude` defaults plus common build-output dirs found in
// AgentsFlow projects.
//
// Parcel's ignore option accepts either globs (picomatch) or paths
// (resolved against the watch root). Bare paths are used here intentionally:
// they're more reliable across backends and platforms than globs, and the
// excluded dirs we care about live at the workspace root in practice.
// Nested occurrences (e.g. `packages/foo/node_modules` in a monorepo) will
// still emit events — the renderer's equality-check + 150 ms debounce
// absorbs that cost without causing visible re-renders.
const DEFAULT_IGNORE: string[] = [
  'node_modules',
  '.git/objects',
  '.git/subtree-cache',
  '.hg/store',
  'dist',
  '.next',
  'build',
  'out',
  '.turbo',
  '.cache',
  'target',
  '.agentsflow',
];

interface Entry {
  dirPath: string;
  refCount: number;
  subscription: import('@parcel/watcher').AsyncSubscription;
  debounceTimer: NodeJS.Timeout | null;
  windows: Set<BrowserWindow>;
}

const watchers = new Map<string, Entry>();
// Subscriptions in flight — prevents a second concurrent watch() call from
// double-subscribing while the first await is still pending.
const pending = new Map<string, Promise<void>>();

// Debounce window for coalescing watcher events into a single push. parcel
// already coalesces native event bursts (npm install, git checkout); this
// extra layer protects against rapid sequential bursts and gives subscribers
// a stable single re-render per logical change.
const DEBOUNCE_MS = 150;

function notify(entry: Entry): void {
  for (const win of entry.windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('files:updated', entry.dirPath);
    }
  }
}

function scheduleNotify(entry: Entry): void {
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null;
    notify(entry);
  }, DEBOUNCE_MS);
}

function shouldInvalidateGitCache(dirPath: string, eventPath: string): boolean {
  const rel = path.relative(dirPath, eventPath);
  // Anything under .git that signals a ref/index change.
  return (
    rel === '.git/HEAD' ||
    rel === '.git/index' ||
    rel.startsWith('.git/refs') ||
    rel.startsWith('.git/packed-refs')
  );
}

export async function watch(dirPath: string, win: BrowserWindow): Promise<void> {
  // Canonicalize the path so ignore-path matching survives symlinks. macOS
  // reports FSEvents using the real path (e.g. /private/var/... for /tmp),
  // and a non-canonical watch root would cause ignore checks to silently
  // miss every event.
  let canonical: string;
  try {
    canonical = fs.realpathSync(dirPath);
  } catch (err) {
    console.error('[agentsflow][file-watcher] realpath failed', dirPath, err);
    return;
  }
  dirPath = canonical;

  const existing = watchers.get(dirPath);
  if (existing) {
    existing.refCount++;
    existing.windows.add(win);
    return;
  }
  // Another caller is mid-subscribe for the same path — wait for it, then
  // bump the refcount on the resulting entry.
  const inFlight = pending.get(dirPath);
  if (inFlight) {
    await inFlight;
    const after = watchers.get(dirPath);
    if (after) { after.refCount++; after.windows.add(win); }
    return;
  }

  const subscribePromise = (async () => {
    const subscription = await getParcel().subscribe(
      dirPath,
      (err, events) => {
        const entry = watchers.get(dirPath);
        if (err) {
          // The dominant error here is FSEvents' "Events were dropped by the
          // FSEvents client. File system must be re-scanned." — the kernel queue
          // overflowed under a burst, so parcel can no longer say *what* changed,
          // only that it lost track. The subscription itself stays valid, so the
          // recovery is exactly what the message asks for: treat it as "anything
          // under this root may have changed" — drop the memoised git state and
          // push one refresh — instead of returning and leaving the UI pinned to
          // data that no future event will ever correct.
          //
          // (2026-07-23: a busy repo emitted hundreds of these; each one logged
          // and returned, so the pane silently stopped updating for the rest of
          // the run while the synchronous log writes piled onto the main thread.)
          console.error('[agentsflow][file-watcher] event stream dropped — re-scanning', dirPath, err);
          invalidateGitCache(dirPath);
          if (entry) scheduleNotify(entry);
          return;
        }
        if (!entry) return;

        for (const ev of events) {
          if (shouldInvalidateGitCache(dirPath, ev.path)) {
            invalidateGitCache(dirPath);
            break;
          }
        }

        scheduleNotify(entry);
      },
      { ignore: DEFAULT_IGNORE },
    );

    const entry: Entry = {
      dirPath,
      refCount: 1,
      subscription,
      debounceTimer: null,
      windows: new Set([win]),
    };
    watchers.set(dirPath, entry);
    console.log('[agentsflow][file-watcher] watching', dirPath);
  })();

  pending.set(dirPath, subscribePromise);
  try {
    await subscribePromise;
  } catch (err) {
    console.error('[agentsflow][file-watcher] failed to subscribe', dirPath, err);
    throw err;
  } finally {
    pending.delete(dirPath);
  }
}

export async function unwatch(dirPath: string, win: BrowserWindow): Promise<void> {
  // Match the canonicalisation done in watch() so unwatch keys line up.
  try { dirPath = fs.realpathSync(dirPath); } catch { /* fall through with original */ }
  const entry = watchers.get(dirPath);
  if (!entry) return;
  entry.windows.delete(win);
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount > 0) return;

  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  try {
    await entry.subscription.unsubscribe();
  } catch (err) {
    console.error('[agentsflow][file-watcher] unsubscribe failed', dirPath, err);
  }
  watchers.delete(dirPath);
  console.log('[agentsflow][file-watcher] stopped watching', dirPath);
}

export async function unwatchAll(): Promise<void> {
  const all = Array.from(watchers.values());
  watchers.clear();
  await Promise.all(
    all.map(async (entry) => {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      try { await entry.subscription.unsubscribe(); } catch { /* ignore */ }
    }),
  );
}
