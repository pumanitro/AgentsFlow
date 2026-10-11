// Pure pieces of main.ts's remote-peer wiring. main.ts imports electron, so
// nothing in it can run under `node --test`; everything here that decides
// something — what a valid add-remote request is, how the probe output reads,
// how a remote peer is named, what `whoami` answers — lives in this module so
// it can be tested without an app, a window, or an ssh connection.
import * as path from 'path';
import { DEFAULT_EXTRA_PATH } from '../shared/remote';
import type { AddRemoteRequest, Conversation, RemotePeerSpec, RemoteProbeResult, TrackedDirectory } from '../shared/types';
import { computeDisplayName } from './naming';
import type { SelfInfo } from './registry';
import { shellQuote, type RunResult } from './remote/remote-exec';

// ---------------------------------------------------------------------------
// Add-remote request validation
// ---------------------------------------------------------------------------

export type ValidatedAddRemote =
  | { ok: true; spec: RemotePeerSpec; path: string; displayName?: string }
  | { ok: false; error: string };

/**
 * The renderer form is the only caller, but IPC input is still untrusted: the
 * spec ends up on an ssh command line and in the store, so every field is
 * checked and normalised here once. `permissionMode` is forced — remote peers
 * run unattended in bypass mode by the user's decision; a request cannot
 * choose otherwise. An empty `extraPath` means "the defaults", not "nothing",
 * because a bare sshd PATH finds neither node nor claude.
 */
export function validateAddRemoteRequest(req: unknown): ValidatedAddRemote {
  if (!req || typeof req !== 'object') return { ok: false, error: 'request required' };
  const r = req as Partial<AddRemoteRequest> & Record<string, unknown>;
  const user = typeof r.user === 'string' ? r.user.trim() : '';
  const host = typeof r.host === 'string' ? r.host.trim() : '';
  const dirPath = typeof r.path === 'string' ? r.path.trim() : '';
  if (!user) return { ok: false, error: 'ssh user is required' };
  if (!host) return { ok: false, error: 'host is required' };
  // A leading '-' would be read by ssh as an option, not a destination.
  if (user.startsWith('-') || host.startsWith('-')) return { ok: false, error: 'user and host must not start with "-"' };
  if (/\s|@/.test(user) || /\s|@/.test(host)) return { ok: false, error: 'user and host must not contain spaces or "@"' };
  // POSIX path on the remote machine; '~' is not expanded inside `cd '<dir>'`.
  if (!dirPath || !dirPath.startsWith('/')) return { ok: false, error: 'directory must be an absolute path on the remote machine' };
  if (r.sshArgs !== undefined && (!Array.isArray(r.sshArgs) || !r.sshArgs.every((a) => typeof a === 'string'))) {
    return { ok: false, error: 'sshArgs must be a list of strings' };
  }
  if (r.extraPath !== undefined && (!Array.isArray(r.extraPath) || !r.extraPath.every((a) => typeof a === 'string'))) {
    return { ok: false, error: 'extraPath must be a list of strings' };
  }
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  const extraPath = ((r.extraPath as string[] | undefined) ?? []).map((p) => p.trim()).filter(Boolean);
  const envFile = typeof r.envFile === 'string' && r.envFile.trim() ? r.envFile.trim() : undefined;
  const spec: RemotePeerSpec = {
    host,
    user,
    sshArgs: ((r.sshArgs as string[] | undefined) ?? []).filter((a) => a !== ''),
    claudeBin: str(r.claudeBin, 'claude'),
    nodeBin: str(r.nodeBin, 'node'),
    ...(envFile ? { envFile } : {}),
    extraPath: extraPath.length ? extraPath : [...DEFAULT_EXTRA_PATH],
    permissionMode: 'bypassPermissions',
  };
  // Normalise trailing slashes so dedupe on (hostKey, path) is exact.
  const normalized = dirPath.length > 1 ? dirPath.replace(/\/+$/, '') : dirPath;
  const displayName = typeof r.displayName === 'string' && r.displayName.trim() ? r.displayName.trim() : undefined;
  return { ok: true, spec, path: normalized, ...(displayName ? { displayName } : {}) };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * The `sh -c` script the probe runs. Each value is printed behind a `PF_*=`
 * marker rather than relying on line positions: the bootstrap sources the
 * user's env file first, and anything that file echoes would otherwise shift
 * every answer by a line. A missing binary prints an empty value, not nothing.
 */
export function buildProbeScript(spec: Pick<RemotePeerSpec, 'nodeBin' | 'claudeBin'>, dirPath: string): string {
  return [
    'echo "PF_HOSTNAME=$(hostname)"',
    'echo "PF_HOME=$HOME"',
    `echo "PF_NODE=$(${shellQuote(spec.nodeBin)} --version 2>/dev/null | head -1)"`,
    `echo "PF_CLAUDE=$(${shellQuote(spec.claudeBin)} --version 2>/dev/null | head -1)"`,
    `if test -d ${shellQuote(dirPath)}; then echo DIR_OK; else echo DIR_MISSING; fi`,
  ].join('; ');
}

/** Read the probe's stdout into the shape the add-remote form renders. */
export function parseProbeOutput(res: RunResult): RemoteProbeResult {
  if (res.timedOut) return { ok: false, error: 'timed out' };
  if (res.code !== 0) {
    const first = res.stderr.split('\n').map((l) => l.trim()).find(Boolean);
    return { ok: false, error: first || `ssh exited with code ${res.code}` };
  }
  const values = new Map<string, string>();
  let dirExists: boolean | undefined;
  for (const raw of res.stdout.split('\n')) {
    const line = raw.trim();
    if (line === 'DIR_OK') dirExists = true;
    else if (line === 'DIR_MISSING') dirExists = false;
    const m = /^PF_([A-Z]+)=(.*)$/.exec(line);
    if (m) values.set(m[1], m[2].trim());
  }
  if (!values.has('HOSTNAME') || dirExists === undefined) {
    return { ok: false, error: 'unexpected probe output from the remote machine' };
  }
  const opt = (k: string) => values.get(k) || undefined;
  return {
    ok: true,
    hostname: opt('HOSTNAME'),
    home: opt('HOME'),
    nodeVersion: opt('NODE'),
    claudeVersion: opt('CLAUDE'),
    dirExists,
  };
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** First DNS label: `theos-mac-studio.tail4a0f3d.ts.net` → `theos-mac-studio`. */
export function shortHostName(host: string): string {
  return host.split('.')[0] || host;
}

/**
 * A remote peer's display name. Starts from the user's choice or the usual
 * path-derived name; if that is already taken by another tracked dir (a local
 * checkout of the same repo is the common case) it gets ` @<host>` so the two
 * stay distinguishable everywhere a peer is named, including `delegate`.
 */
export function remoteDisplayName(base: string, host: string, others: TrackedDirectory[]): string {
  const taken = new Set(others.map((d) => d.displayName.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  const suffixed = `${base} @${shortHostName(host)}`;
  if (!taken.has(suffixed.toLowerCase())) return suffixed;
  for (let i = 2; ; i++) {
    const n = `${suffixed} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/**
 * `recomputeAllDisplayNames`, minus the remote peers. That function derives
 * every name from paths alone, which would throw away a remote peer's chosen
 * name and its ` @host` suffix on every add/remove. Local names are computed
 * against local paths only, so adding a remote peer never renames a local one.
 */
export function recomputeDisplayNamesKeepingRemote(dirs: TrackedDirectory[]): TrackedDirectory[] {
  const local = dirs.filter((d) => !d.remote);
  return dirs.map((d) => (d.remote ? d : { ...d, displayName: computeDisplayName(d.path, local) }));
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * A prompt names its attachments by absolute local path; a remote session must
 * read the copies on its own machine. Exact string replacement, longest path
 * first so `/a/b.png` never clobbers part of `/a/b.png.txt`.
 */
export function rewriteAttachmentPaths(prompt: string, map: Map<string, string>): string {
  const keys = [...map.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  let out = prompt;
  for (const k of keys) out = out.split(k).join(map.get(k)!);
  return out;
}

/** Which attachments to copy: absolute local paths only, deduped. */
export function localAttachmentPaths(attachments: string[] | undefined): string[] {
  return [...new Set((attachments ?? []).filter((p) => typeof p === 'string' && path.isAbsolute(p)))];
}

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

/**
 * Which tracked dir a `skills:list` call means. The id wins (a remote peer can
 * share its path with a local checkout); by path, a LOCAL dir is preferred,
 * because before remote peers that was the only meaning a path had.
 */
export function resolveSkillsDir(dirs: TrackedDirectory[], dirPath: string | null, directoryId?: string): TrackedDirectory | undefined {
  if (directoryId) {
    const byId = dirs.find((d) => d.id === directoryId);
    if (byId) return byId;
  }
  if (!dirPath) return undefined;
  return dirs.find((d) => !d.remote && d.path === dirPath) ?? dirs.find((d) => d.remote && d.path === dirPath);
}

// ---------------------------------------------------------------------------
// Bootstrap "where you are running"
// ---------------------------------------------------------------------------

/**
 * The SelfInfo a remote session's bootstrap prompt is rendered with. Same
 * hostname precedence as whoami, so the prompt and the tool never disagree.
 */
export function remoteSelfInfo(hostKey: string, dir: TrackedDirectory | undefined, cwd: string, displayName: string): SelfInfo {
  return { hostKey, hostname: dir?.remoteCache?.hostname ?? dir?.remote?.host ?? hostKey, dir: cwd, displayName };
}

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------

/**
 * The `whoami` bridge answer. `hostname` is the machine the session actually
 * runs on: the remote's own hostname once its host has connected, else the ssh
 * host, else the hostKey — never the laptop's for a remote session.
 */
export function whoamiEnvelope(conv: Conversation, dir: TrackedDirectory | undefined, localHostname: string): Record<string, unknown> {
  return {
    status: 'success',
    conversationId: conv.id,
    sessionId: conv.sessionId,
    daemonShort: conv.daemonShort,
    directory: conv.displayName,
    directoryPath: conv.directoryPath,
    host: conv.host ?? null,
    hostname: conv.host ? (dir?.remoteCache?.hostname ?? dir?.remote?.host ?? conv.host) : localHostname,
    remote: Boolean(conv.host),
    title: conv.title,
  };
}

// ---------------------------------------------------------------------------
// Delegation fallback: settle on the transcript when the daemon never does
// ---------------------------------------------------------------------------

/**
 * The last non-empty assistant text in a Claude transcript (JSONL). Content is
 * either a plain string or a list of parts, of which only `text` parts count —
 * a turn that is all tool calls says nothing to report back. Unparseable lines
 * (a half-written tail) are skipped.
 */
export function lastAssistantText(jsonl: string): { text: string; at: string } | null {
  let found: { text: string; at: string } | null = null;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let rec: { type?: unknown; timestamp?: unknown; message?: { content?: unknown } };
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || rec.type !== 'assistant') continue;
    const content = rec.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((p): p is { type: 'text'; text: string } => !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
        .map((p) => p.text)
        .join('\n');
    }
    text = text.trim();
    if (text) found = { text, at: typeof rec.timestamp === 'string' ? rec.timestamp : '' };
  }
  return found;
}

/**
 * A `--bg` daemon can answer its brief and then sit at `state: 'working'`
 * forever without writing a terminal state. What it does show is quiet: the
 * row is idle, the job's tempo is idle (or absent) and nothing is in flight.
 * The caller requires this on several consecutive polls before trusting it.
 */
export function delegationLooksFinished(
  row: { status?: string },
  job: { tempo?: string; inFlight?: { tasks?: number } } | null,
): boolean {
  if ((row.status || '').toLowerCase() !== 'idle') return false;
  const tempo = (job?.tempo || '').toLowerCase();
  if (tempo && tempo !== 'idle') return false;
  return (job?.inFlight?.tasks ?? 0) === 0;
}
