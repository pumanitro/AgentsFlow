/**
 * connect_session — pure planning for the MCP tool that opens a Claude session
 * which already exists on a remote peer's machine as a Peers Flow chat row.
 *
 * Pure on purpose (only node:path + types) so every rule is unit-tested without
 * electron. Main wires the deps (peer resolution, host keys, ids, clock).
 */
import * as path from 'node:path';
import type { Conversation, ConversationConnect, TrackedDirectory } from '../shared/types';

export const CONNECT_CONVERSATION_ID_TOKEN = '{conversationId}';
export const READ_ONLY_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];
// Exit code a launcher (lock wrapper) uses to say "this session is busy over there".
export const LAUNCHER_BUSY_EXIT = 75;

export interface ConnectSessionArgs {
  peer: string; sessionId: string; title: string;
  cwd?: string; fork?: boolean; readOnly?: boolean; focus?: boolean; launcher?: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function normalizeAbs(p: string): string {
  let n = path.posix.normalize(p);
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

// Equal to or under `root` (posix). Both must be absolute; a '..' surviving
// normalization (it can't for absolute paths, but be strict) is refused.
export function isInsideRemotePath(root: string, candidate: string): boolean {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false;
  if (!root.startsWith('/') || !candidate.startsWith('/')) return false;
  const r = normalizeAbs(root);
  const c = normalizeAbs(candidate);
  if (r.split('/').includes('..') || c.split('/').includes('..')) return false;
  if (c === r) return true;
  return c.startsWith(r === '/' ? '/' : r + '/');
}

function validLauncher(v: unknown): v is string[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= 32 && v.every(
    (a) => typeof a === 'string' && a.length > 0 && a.length <= 1024 && !/[\0\n\r]/.test(a),
  );
}

export function sanitizeConnect(raw: unknown): ConversationConnect | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!isSessionId(r.sourceSessionId)) return undefined;
  if (typeof r.cwd !== 'string' || !r.cwd.startsWith('/')) return undefined;
  const out: ConversationConnect = {
    sourceSessionId: r.sourceSessionId,
    cwd: r.cwd,
    connectedAt: typeof r.connectedAt === 'string' ? r.connectedAt : '',
  };
  if (r.fork === true) out.fork = true;
  if (r.readOnly === true) out.readOnly = true;
  if (validLauncher(r.launcher)) out.launcher = [...r.launcher];
  return out;
}

export function expandLauncher(launcher: string[] | undefined, conversationId: string): string[] | undefined {
  if (!launcher || launcher.length === 0) return undefined;
  return launcher.map((a) => a.split(CONNECT_CONVERSATION_ID_TOKEN).join(conversationId));
}

export function findConnectRow(
  convs: Conversation[], host: string, sourceSessionId: string, fork: boolean, readOnly: boolean,
): Conversation | undefined {
  return convs.find((c) =>
    c.pinned && c.host === host && c.connect !== undefined &&
    c.connect.sourceSessionId === sourceSessionId &&
    !!c.connect.fork === fork && !!c.connect.readOnly === readOnly);
}

export type ConnectPlan =
  | { kind: 'failure'; stage: 'args' | 'peer' | 'cwd'; error: string }
  | { kind: 'reuse'; conversation: Conversation; patch: Partial<Conversation> | null }
  | { kind: 'create'; row: Conversation; needsApproval: boolean; peer: TrackedDirectory };

export interface PlanConnectDeps {
  directories: TrackedDirectory[]; conversations: Conversation[];
  resolvePeer: (token: string, dirs: TrackedDirectory[]) => TrackedDirectory | null;
  hostKeyFor: (dir: TrackedDirectory) => string | undefined;
  newId: () => string; now: () => string;
}

function sameArr(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function planConnect(args: ConnectSessionArgs, deps: PlanConnectDeps): ConnectPlan {
  const fail = (stage: 'args' | 'peer' | 'cwd', error: string): ConnectPlan => ({ kind: 'failure', stage, error });
  if (!isSessionId(args.sessionId)) return fail('args', 'sessionId must be a session uuid');
  const rawTitle = typeof args.title === 'string' ? args.title.trim() : '';
  if (!rawTitle) return fail('args', 'title must be a non-empty string');
  const title = rawTitle.slice(0, 80);
  const fork = !!args.fork;
  const readOnly = !!args.readOnly;
  if (readOnly && !fork) return fail('args', 'readOnly needs fork: true');
  let launcher: string[] | undefined;
  if (args.launcher !== undefined) {
    if (!validLauncher(args.launcher)) {
      return fail('args', 'launcher must be an array of 1-32 non-empty strings (each ≤1024 chars, no NUL or newline)');
    }
    launcher = [...args.launcher];
  }

  const token = typeof args.peer === 'string' ? args.peer.trim() : '';
  const dir = deps.resolvePeer(token, deps.directories);
  if (!dir) {
    const known = deps.directories.map((d) => d.displayName).join(', ') || '(none)';
    return fail('peer', `unknown peer "${token}". Known peers: ${known}`);
  }
  const host = dir.remote ? deps.hostKeyFor(dir) : undefined;
  if (!dir.remote || !host) return fail('peer', 'connect_session works on remote peers only');

  const cwd = normalizeAbs((typeof args.cwd === 'string' ? args.cwd.trim() : '') || dir.path);
  if (!isInsideRemotePath(dir.path, cwd)) {
    return fail('cwd', `cwd ${cwd} is not inside the peer's path ${dir.path}`);
  }

  const existing = findConnectRow(deps.conversations, host, args.sessionId, fork, readOnly);
  if (existing && existing.connect) {
    const differs = existing.title !== title || existing.connect.cwd !== cwd || !sameArr(existing.connect.launcher, launcher);
    let patch: Partial<Conversation> | null = null;
    if (differs) {
      const connect: ConversationConnect = { ...existing.connect, cwd };
      if (launcher) connect.launcher = launcher; else delete connect.launcher;
      patch = { title, connect };
    }
    return { kind: 'reuse', conversation: existing, patch };
  }

  const now = deps.now();
  const connect: ConversationConnect = { sourceSessionId: args.sessionId, cwd, connectedAt: now };
  if (fork) connect.fork = true;
  if (readOnly) connect.readOnly = true;
  if (launcher) connect.launcher = launcher;
  const row: Conversation = {
    id: deps.newId(),
    provider: 'claude',
    sessionId: fork ? deps.newId() : args.sessionId,
    daemonShort: '',
    sessionName: '',
    directoryId: dir.id,
    directoryPath: dir.path,
    displayName: dir.displayName,
    title,
    description: fork && readOnly
      ? 'read-only copy — open the chat to view'
      : 'connected session — open the chat to continue',
    pinned: true,
    attachments: [],
    state: 'idle',
    status: 'idle',
    intent: '',
    createdAt: now,
    lastPrompt: '',
    host,
    chatKind: 'chat',
    connect,
  };
  return { kind: 'create', row, needsApproval: !(fork && readOnly), peer: dir };
}

export interface ConnectAttachOpts {
  remoteCwd: string; forkFrom?: string; launcher?: string[];
  permissionMode?: 'manual'; tools?: string[]; strictMcpConfig?: true; peerAwareness: boolean;
}

export function connectAttachOpts(
  conv: Pick<Conversation, 'sessionId'> & { connect: ConversationConnect }, forkMaterialized: boolean,
): ConnectAttachOpts {
  const c = conv.connect;
  const out: ConnectAttachOpts = { remoteCwd: c.cwd, peerAwareness: !c.readOnly };
  if (c.fork && !forkMaterialized) out.forkFrom = c.sourceSessionId;
  if (c.launcher) out.launcher = c.launcher;
  if (c.readOnly) {
    out.permissionMode = 'manual';
    out.tools = [...READ_ONLY_TOOLS];
    out.strictMcpConfig = true;
  }
  return out;
}

export function transcriptProbeArgv(sessionId: string): string[] {
  if (!isSessionId(sessionId)) throw new Error(`not a session id: ${String(sessionId)}`);
  return ['sh', '-c', `ls "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${sessionId}.jsonl >/dev/null 2>&1`];
}

export function launcherExitReason(exitCode: number, launcher: string[] | undefined, outputTail: string): string | undefined {
  if (!launcher?.length || exitCode !== LAUNCHER_BUSY_EXIT) return undefined;
  const last = outputTail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
  return 'The session is busy on the remote machine.\n' + last;
}
