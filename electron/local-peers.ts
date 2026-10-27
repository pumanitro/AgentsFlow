/**
 * Local peers: tracking and untracking a directory on THIS machine. One code
 * path for the app's "Add directory" / "Remove" buttons and for the
 * `add_local_peer` / `remove_peer` MCP tools, so a peer added by an agent and
 * one added from the folder picker can never differ.
 *
 * Dependency-free on purpose (no `electron`): main hands in the store calls and
 * does the broadcasting; the tests drive it against temp directories.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { TrackedDirectory } from '../shared/types';
import { computeDisplayName } from './naming';
import { recomputeDisplayNamesKeepingRemote } from './main-remote';

export interface LocalPeersDeps {
  getDirectories: () => TrackedDirectory[];
  setDirectories: (dirs: TrackedDirectory[]) => void;
  /** Re-attach conversations recorded for this path to the new id ("remove + re-add restores the history"). */
  relinkConversationsByPath: (absPath: string, directoryId: string, displayName: string) => number;
  newId: () => string;
  now: () => Date;
}

const MAX_NAME = 60;

/** The checks a local peer's path must pass. Returns the normalised absolute path. */
export function checkLocalDirectory(raw: unknown): { ok: true; path: string } | { ok: false; error: string } {
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (!p) return { ok: false, error: '`path` is required (the absolute path of a local directory).' };
  if (!path.isAbsolute(p)) return { ok: false, error: `Path must be absolute: ${p}` };
  const abs = path.resolve(p);   // drops a trailing slash and `..`, so the duplicate check compares like with like
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return { ok: false, error: `Directory does not exist: ${abs}` }; }
  if (!st.isDirectory()) return { ok: false, error: `Not a directory: ${abs}` };
  try { fs.accessSync(abs, fs.constants.R_OK); } catch { return { ok: false, error: `Directory is not readable: ${abs}` }; }
  return { ok: true, path: abs };
}

/** The tracked local peer at this path, if any. Remote peers may carry the same path on another machine. */
export function findLocalDirectory(absPath: string, dirs: TrackedDirectory[]): TrackedDirectory | undefined {
  return dirs.find((d) => !d.remote && d.path === absPath);
}

/**
 * Track `absPath` (already checked) as a local peer, or return the one that
 * already tracks it. Names come from the directory, disambiguated against the
 * other local peers, unless `customName` pins one.
 */
export function addLocalDirectory(
  absPath: string,
  deps: LocalPeersDeps,
  customName?: string,
): { dir: TrackedDirectory; added: boolean; relinked: number } {
  const existing = deps.getDirectories();
  const same = findLocalDirectory(absPath, existing);
  if (same) return { dir: same, added: false, relinked: 0 };
  const newDir: TrackedDirectory = {
    id: deps.newId(),
    path: absPath,
    displayName: customName || computeDisplayName(absPath, existing),
    addedAt: deps.now().toISOString(),
    ...(customName ? { customName } : {}),
  };
  // Remote peers keep their own names (see recomputeDisplayNamesKeepingRemote).
  const next = recomputeDisplayNamesKeepingRemote([...existing, newDir]);
  deps.setDirectories(next);
  const persisted = next.find((d) => d.id === newDir.id) ?? newDir;
  // We deliberately do NOT scan ~/.claude/projects for more transcripts here:
  // history only holds conversations the user actually spawned via Peers Flow.
  const relinked = deps.relinkConversationsByPath(persisted.path, persisted.id, persisted.displayName);
  return { dir: persisted, added: true, relinked };
}

/** Untrack one peer (never touches its files). Returns the removed peer, or null when the id is unknown. */
export function removeTrackedDirectory(id: string, deps: Pick<LocalPeersDeps, 'getDirectories' | 'setDirectories'>): TrackedDirectory | null {
  const all = deps.getDirectories();
  const gone = all.find((d) => d.id === id) ?? null;
  if (!gone) return null;
  deps.setDirectories(recomputeDisplayNamesKeepingRemote(all.filter((d) => d.id !== id)));
  return gone;
}

/** A peer by id, absolute path (local first) or name, as list_peers shows it. */
export function resolveTrackedDirectory(token: string, dirs: TrackedDirectory[]): TrackedDirectory | null {
  const t = token.trim();
  const lower = t.toLowerCase();
  const asPath = path.isAbsolute(t) ? path.resolve(t) : null;
  return (
    dirs.find((d) => d.id === t) ||
    (asPath ? findLocalDirectory(asPath, dirs) || dirs.find((d) => d.path === asPath) : undefined) ||
    dirs.find((d) => d.displayName.toLowerCase() === lower) ||
    null
  );
}

function peerOf(d: TrackedDirectory): Record<string, unknown> {
  return { id: d.id, displayName: d.displayName, path: d.path };
}

export interface AddLocalPeerArgs { path?: unknown; displayName?: unknown; testOnly?: unknown }

/** `add_local_peer`: check, then (unless test-only) track. Never throws. */
export function addLocalPeerEnvelope(
  args: AddLocalPeerArgs,
  deps: LocalPeersDeps,
): { envelope: Record<string, unknown>; changed: TrackedDirectory | null; relinked: number } {
  const fail = (error: string, extra: Record<string, unknown> = {}) => ({ envelope: { status: 'failure', error, ...extra }, changed: null, relinked: 0 });
  const v = checkLocalDirectory(args.path);
  if (!v.ok) return fail(v.error);
  const dirs = deps.getDirectories();
  const already = findLocalDirectory(v.path, dirs);
  if (already) {
    return {
      envelope: {
        status: 'success',
        alreadyTracked: true,
        peer: peerOf(already),
        delegateWith: `directory: "${already.displayName}"`,
        note: 'This directory is already a Peers Flow peer; nothing was added.',
      },
      changed: null,
      relinked: 0,
    };
  }

  let customName: string | undefined;
  if (args.displayName !== undefined) {
    customName = typeof args.displayName === 'string' ? args.displayName.trim() : '';
    if (!customName) return fail('`display_name` must be a non-empty string when given.');
    if (customName.length > MAX_NAME) return fail(`\`display_name\` is longer than ${MAX_NAME} characters.`);
    const lower = customName.toLowerCase();
    const clash = dirs.find((d) => d.displayName.toLowerCase() === lower);
    if (clash) return fail(`Another peer is already named "${clash.displayName}" (${clash.path}). Pick a different display_name.`);
  }

  if (args.testOnly === true) {
    return {
      envelope: {
        status: 'success',
        testOnly: true,
        path: v.path,
        displayName: customName || computeDisplayName(v.path, dirs.filter((d) => !d.remote)),
        note: 'The directory can be added; nothing was saved.',
      },
      changed: null,
      relinked: 0,
    };
  }

  const { dir, relinked } = addLocalDirectory(v.path, deps, customName);
  return {
    envelope: {
      status: 'success',
      peer: peerOf(dir),
      delegateWith: `directory: "${dir.displayName}"`,
      ...(relinked > 0 ? { relinkedConversations: relinked } : {}),
      note: 'The peer is saved; it appears in the Peers Flow sidebar and in list_peers, and can be delegated to now.',
    },
    changed: dir,
    relinked,
  };
}

export interface RemovePeerArgs { name?: unknown; path?: unknown; id?: unknown }

/** `remove_peer`: untrack one peer named by id, path or name. Files on disk are never touched. Never throws. */
export function removePeerEnvelope(
  args: RemovePeerArgs,
  deps: Pick<LocalPeersDeps, 'getDirectories' | 'setDirectories'>,
): { envelope: Record<string, unknown>; removed: TrackedDirectory | null } {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const token = str(args.id) ?? str(args.path) ?? str(args.name);
  if (!token) return { envelope: { status: 'failure', error: 'Pass the peer to remove: `name`, `path` or `id`, as shown by list_peers.' }, removed: null };
  const dirs = deps.getDirectories();
  const dir = resolveTrackedDirectory(token, dirs);
  if (!dir) {
    return { envelope: { status: 'failure', error: `Unknown peer "${token}". Call list_peers to see valid peers.`, known: dirs.map((d) => d.displayName) }, removed: null };
  }
  removeTrackedDirectory(dir.id, deps);
  return {
    envelope: {
      status: 'success',
      removed: peerOf(dir),
      note: 'The peer is no longer tracked. Its files were not touched, and its conversations come back if the directory is added again.',
    },
    removed: dir,
  };
}
