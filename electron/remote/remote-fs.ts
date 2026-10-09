// Remote filesystem adapter: the files/git IPC handlers in main.ts call these
// when a path belongs to a remote peer, so the sidebar's file tree, editor and
// git view work unchanged. Same return shapes as the local code paths; the
// actual reads go through the host's agent script (RemoteHosts), never sshfs.
//
// Paths here are paths ON THE REMOTE HOST, so everything uses path.posix: the
// laptop's own path rules (and its home dir) never apply to them.
//
// No runtime `electron` import: BrowserWindow is only used as a type, so the
// module (and its tests) load under plain node.
import * as path from 'path';
import type { BrowserWindow } from 'electron';
import type { StatResult } from '../../shared/remote';
import type { FileEntry, GitStatusResult, ReadBinaryResult, ReadFileResult, SearchOptions, SearchResult, TrackedDirectory } from '../../shared/types';
import { hostKeyOf } from '../../shared/remote';
import { getRemoteHosts, type RemoteHosts } from './remote-hosts';

const P = path.posix;

/** The remote peer a path belongs to, or null for a path on this machine. */
export function resolveRemotePath(p: string): { hostKey: string; dir: TrackedDirectory } | null {
  const hosts = getRemoteHosts();
  if (typeof p !== 'string' || !p) return null;
  const hostKey = hosts?.hostKeyForPath(p) ?? null;
  if (!hosts || !hostKey) return null;
  // The tracked dir on that host that owns p; the longest path wins so a
  // nested peer beats its parent.
  let best: TrackedDirectory | null = null;
  for (const d of hosts.deps.getDirectories()) {
    if (!d.remote || hostKeyOf(d.remote) !== hostKey) continue;
    if (p !== d.path && !p.startsWith(`${d.path}/`)) continue;
    if (!best || d.path.length > best.path.length) best = d;
  }
  return best ? { hostKey, dir: best } : null;
}

function hosts(): RemoteHosts {
  const h = getRemoteHosts();
  if (!h) throw new Error('remote hosts are not running');
  return h;
}

function errMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

// The agent script has no mkdir command; `exec` covers the two places the
// local handlers mkdir -p a parent (create, rename).
async function mkdirp(hostKey: string, dir: string): Promise<void> {
  const r = await hosts().exec(hostKey, ['mkdir', '-p', dir]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `mkdir -p ${dir} failed (exit ${r.code})`);
}

export function statPath(hostKey: string, p: string): Promise<StatResult> {
  return hosts().stat(hostKey, p);
}

export function listFiles(hostKey: string, dirPath: string): Promise<FileEntry[]> {
  return hosts().listFiles(hostKey, dirPath);
}

export function gitStatus(hostKey: string, dirPath: string): Promise<GitStatusResult> {
  return hosts().gitStatus(hostKey, dirPath);
}

export const READ_TEXT_MAX = 2 * 1024 * 1024; // 2 MB cap for the editor, same as files:readText
const SNIFF_BYTES = 8192;

export async function readText(hostKey: string, filePath: string): Promise<ReadFileResult> {
  try {
    // Stat first so an oversized file never crosses the wire just to be dropped.
    const st = await hosts().stat(hostKey, filePath);
    if (!st.exists) throw new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
    if (st.size > READ_TEXT_MAX) {
      return { content: '', size: st.size, truncated: true, binary: false };
    }
    const { content: buf, size } = await hosts().readFile(hostKey, filePath, READ_TEXT_MAX);
    // Heuristic: any NUL byte in the first 8 KB → binary
    const sniff = buf.subarray(0, Math.min(buf.length, SNIFF_BYTES));
    if (sniff.includes(0)) {
      return { content: '', size, truncated: false, binary: true };
    }
    return { content: buf.toString('utf8'), size, truncated: false, binary: false };
  } catch (err) {
    return { content: '', size: 0, truncated: false, binary: false, error: errMessage(err) };
  }
}

// Moves the temp file over the target, giving it the target's existing
// permission bits first: the agent's `write` always applies a mode (0600 by
// default), and an edited script must not lose its +x. GNU stat first (BSD stat
// rejects -c and falls through to -f %Lp); a new file keeps the temp's 0644.
const SWAP_SCRIPT =
  'm=$(stat -c %a "$2" 2>/dev/null || stat -f %Lp "$2" 2>/dev/null) && chmod "$m" "$1"; ' +
  'mv -f "$1" "$2" || { rm -f "$1"; exit 1; }';

export async function writeText(hostKey: string, filePath: string, content: string): Promise<{ ok: true }> {
  if (!P.isAbsolute(filePath)) throw new Error('write: path must be absolute');
  // Write to a temp sibling and rename into place — the agent's write truncates
  // before writing, so a dropped connection mid-write would leave the file empty.
  const tmp = `${filePath}.${process.pid}.agentsflow-tmp`;
  const h = hosts();
  await h.writeFile(hostKey, tmp, content, 0o644);
  const r = await h.exec(hostKey, ['/bin/sh', '-c', SWAP_SCRIPT, 'sh', tmp, filePath]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `write: could not move into place (exit ${r.code})`);
  return { ok: true as const };
}

// Same table as files:readBinary in main.ts.
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

export async function readBinary(hostKey: string, filePath: string): Promise<ReadBinaryResult> {
  try {
    const ext = P.extname(filePath).slice(1).toLowerCase();
    // PDFs get the bigger budget, as locally: scans routinely exceed 8 MB.
    const MAX = ext === 'pdf' ? 64 * 1024 * 1024 : 8 * 1024 * 1024;
    const st = await hosts().stat(hostKey, filePath);
    if (!st.exists) throw new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
    if (st.size > MAX) return { dataUrl: '', mime: '', size: st.size, truncated: true };
    const mime = MIME[ext] || 'application/octet-stream';
    const { content: buf, size } = await hosts().readFile(hostKey, filePath, MAX);
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, size, truncated: false };
  } catch (err) {
    return { dataUrl: '', mime: '', size: 0, truncated: false, error: errMessage(err) };
  }
}

export async function createFile(hostKey: string, filePath: string): Promise<{ ok: true }> {
  if (!P.isAbsolute(filePath)) throw new Error('create: path must be absolute');
  await mkdirp(hostKey, P.dirname(filePath));
  // The agent's mkfile uses flag 'wx': creating must never clobber.
  await hosts().createFile(hostKey, filePath);
  return { ok: true as const };
}

export async function renamePath(hostKey: string, oldPath: string, newPath: string): Promise<{ ok: true }> {
  if (!P.isAbsolute(oldPath) || !P.isAbsolute(newPath)) throw new Error('rename: paths must be absolute');
  if ((await hosts().stat(hostKey, newPath)).exists) {
    throw new Error(`rename: target already exists at ${newPath}`);
  }
  await mkdirp(hostKey, P.dirname(newPath));
  await hosts().rename(hostKey, oldPath, newPath);
  return { ok: true as const };
}

export async function removePath(hostKey: string, targetPath: string): Promise<{ ok: true }> {
  if (!P.isAbsolute(targetPath)) throw new Error('remove: path must be absolute');
  // Guardrails: refuse to nuke roots / very short paths. The agent checks too;
  // refusing here saves the round trip and keeps the local error text.
  if (targetPath === '/' || targetPath.split('/').filter(Boolean).length < 2) {
    throw new Error(`remove: refusing to delete suspicious path ${targetPath}`);
  }
  await hosts().remove(hostKey, targetPath);
  return { ok: true as const };
}

/**
 * Remote twin of files:probePath: resolves a token from terminal output (an
 * absolute path, a `~` path — the REMOTE home — or a path relative to the
 * terminal's remote cwd) and reports whether it exists on that host.
 */
export async function probePath(hostKey: string, baseDir: string | null, token: string): Promise<{ exists: boolean; absPath: string } | null> {
  if (typeof token !== 'string' || !token || token.length > 4096) return null;
  let candidate = token;
  if (candidate === '~' || candidate.startsWith('~/')) {
    const home = hosts().home(hostKey);
    // Home is learned from the agent's hello; before that a ~ path can't resolve.
    if (!home) return null;
    candidate = P.join(home, candidate.slice(1));
  }
  let abs: string;
  if (P.isAbsolute(candidate)) {
    abs = P.normalize(candidate);
  } else if (baseDir && P.isAbsolute(baseDir)) {
    abs = P.resolve(baseDir, candidate);
  } else {
    // A relative token with no base directory to anchor it — unresolvable.
    return null;
  }
  let exists = false;
  try {
    exists = (await hosts().stat(hostKey, abs)).exists;
  } catch {
    exists = false;
  }
  return { exists, absPath: abs };
}

export async function search(hostKey: string, dirPath: string, query: string, opts?: SearchOptions): Promise<SearchResult> {
  try {
    return await hosts().search(hostKey, dirPath, query, opts);
  } catch (err) {
    return { files: [], totalMatches: 0, filesScanned: 0, truncated: false, error: errMessage(err) };
  }
}

// ---- watching ------------------------------------------------------------------
// Ref-counted per (host, dir) like file-watcher.ts: the first window registers
// an `fswatch` on the host, the last one to leave sends `fsunwatch`. The change
// push itself arrives as an agent `fsevent` → RemoteHosts onFsEvent → main's
// `files:updated`, so this module only decides when the host watches.

interface WatchEntry {
  refCount: number;
  windows: Set<BrowserWindow>;
  ready: Promise<void>;
}

const watches = new Map<string, WatchEntry>();
const watchKey = (hostKey: string, dir: string): string => `${hostKey}\0${dir}`;

export async function watch(hostKey: string, dirPath: string, win: BrowserWindow): Promise<void> {
  const key = watchKey(hostKey, dirPath);
  const existing = watches.get(key);
  if (existing) {
    existing.refCount++;
    existing.windows.add(win);
    // A subscribe still in flight: wait for it so callers see the same outcome.
    await existing.ready;
    return;
  }
  const entry: WatchEntry = { refCount: 1, windows: new Set([win]), ready: Promise.resolve() };
  // Registered before the await, so a concurrent watch() bumps this entry
  // instead of sending a second fswatch.
  entry.ready = hosts().fsWatch(hostKey, dirPath);
  watches.set(key, entry);
  try {
    await entry.ready;
  } catch (err) {
    if (watches.get(key) === entry) watches.delete(key);
    console.error('[agentsflow][remote-fs] failed to watch', hostKey, dirPath, errMessage(err));
    throw err;
  }
}

export async function unwatch(hostKey: string, dirPath: string, win: BrowserWindow): Promise<void> {
  const key = watchKey(hostKey, dirPath);
  const entry = watches.get(key);
  if (!entry) return;
  entry.windows.delete(win);
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount > 0) return;
  watches.delete(key);
  try {
    await hosts().fsUnwatch(hostKey, dirPath);
  } catch (err) {
    // The host may already be gone; its watches die with the channel anyway.
    console.error('[agentsflow][remote-fs] unwatch failed', hostKey, dirPath, errMessage(err));
  }
}

/** Windows currently watching a remote dir — for fanning out an fsevent push. */
export function watchingWindows(hostKey: string, dirPath: string): BrowserWindow[] {
  return Array.from(watches.get(watchKey(hostKey, dirPath))?.windows ?? []);
}

/** Test hook: forget every watch without talking to a host. */
export function resetWatchesForTest(): void {
  watches.clear();
}
