/**
 * Peers Flow MCP server (stdio).
 *
 * `claude` spawns this as a plain Node child (via the generated mcp config),
 * NOT inside Electron — so it must only use Node built-ins and the
 * dependency-free `registry`/`locale` modules. It speaks newline-delimited
 * JSON-RPC 2.0 (the MCP stdio transport) and exposes two tools:
 *
 *   • list_peers — the live Peers Flow registry (read fresh from store.json)
 *   • delegate   — ask Peers Flow (over the bridge socket) to spawn a tracked,
 *                  watchable peer session; falls back to a headless `claude -p`
 *                  when run outside the app (no bridge socket).
 *
 * IMPORTANT: stdout is the JSON-RPC channel. Never write anything but protocol
 * frames to it — all logging goes to stderr.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { withUtf8Locale } from '../locale';
import {
  SERVER_ID,
  TOOL_DEFS,
  buildDelegatePrompt,
  buildRegistry,
  localBinPath,
  readDirectoriesFromStore,
  renderRegistryMarkdown,
} from '../registry';
import type { TrackedDirectory } from '../../shared/types';

const STORE_PATH = process.env.PEERSFLOW_STORE_PATH || '';
const DELEGATIONS_DIR =
  process.env.PEERSFLOW_DELEGATIONS_DIR || path.join(os.tmpdir(), 'peersflow-delegations');
const BRIDGE_SOCK = process.env.PEERSFLOW_BRIDGE_SOCK || '';
const ROOT_CONVERSATION_ID = process.env.PEERSFLOW_ROOT_CONVERSATION_ID || '';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
// Depth in the delegation chain. The session that owns this server is depth 0;
// any session IT delegates to runs at depth 1 and is NOT given this MCP server
// (see the spawn below), so the chain is hard-capped at one hop — no cycles.
const DEPTH = Number.parseInt(process.env.PEERSFLOW_DELEGATION_DEPTH || '0', 10) || 0;
const MAX_DEPTH = 1;
const PROTOCOL_VERSION = '2025-06-18';

function log(...args: unknown[]): void {
  // stderr only — stdout is reserved for JSON-RPC.
  console.error('[peersflow-mcp]', ...args);
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing (newline-delimited frames over stdio)
// ---------------------------------------------------------------------------
type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function sendResult(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}
function sendError(id: JsonRpcId, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}
function textContent(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
function toolListPeers(): Record<string, unknown> {
  const dirs = readDirectoriesFromStore(STORE_PATH);
  const reg = buildRegistry(dirs);
  return textContent(renderRegistryMarkdown(reg));
}

function resolveDirectory(token: string, dirs: TrackedDirectory[]): TrackedDirectory | null {
  const t = token.trim();
  const lower = t.toLowerCase();
  return (
    dirs.find((d) => d.id === t) ||
    dirs.find((d) => d.path === t) ||
    dirs.find((d) => d.displayName.toLowerCase() === lower) ||
    dirs.find((d) => path.basename(d.path).toLowerCase() === lower) ||
    null
  );
}

interface DelegateArgs {
  directory?: unknown;
  goal?: unknown;
  deliverable?: unknown;
  timeout_ms?: unknown;
}

/**
 * Ask the Peers Flow app (over the bridge socket) to spawn a *tracked,
 * watchable* peer session and run the goal to completion. Resolves to the
 * result envelope, or `null` if the bridge is unavailable / errors — in which
 * case the caller falls back to a headless `claude -p`.
 */
function runBridgeDelegate(
  directory: string,
  goal: string,
  deliverable: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const sock = net.connect(BRIDGE_SOCK);
    let buf = '';
    let settled = false;
    const finish = (val: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      try { sock.end(); } catch { /* ignore */ }
      resolve(val);
    };
    const req = {
      type: 'delegate',
      id: `${Date.now()}-${process.pid}`,
      rootConversationId: ROOT_CONVERSATION_ID,
      directory,
      goal,
      deliverable,
      timeoutMs,
    };
    // Allow the full delegation timeout plus headroom for spawn + result harvest.
    const guard = setTimeout(() => finish(null), timeoutMs + 60_000);
    sock.setEncoding('utf8');
    sock.on('connect', () => { sock.write(`${JSON.stringify(req)}\n`); });
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(guard);
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as { envelope?: Record<string, unknown> };
        finish(msg.envelope ?? null);
      } catch {
        finish(null);
      }
    });
    sock.on('error', (e) => { clearTimeout(guard); log('bridge connect error', (e as Error).message); finish(null); });
    sock.on('close', () => { clearTimeout(guard); finish(null); });
  });
}

function spawnDelegate(
  dir: TrackedDirectory,
  prompt: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    env.PATH = `${process.env.PATH}:${localBinPath()}`;
    env.NO_COLOR = '1';
    delete env.FORCE_COLOR;
    delete env.CLICOLOR_FORCE;
    withUtf8Locale(env);
    // Mark the chain depth for the child. We deliberately do NOT pass our own
    // --mcp-config to it, so the delegated agent cannot itself delegate — but
    // the env var documents the hop and future-proofs a deeper guard.
    env.PEERSFLOW_DELEGATION_DEPTH = String(DEPTH + 1);

    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions'];
    const child = spawn(CLAUDE_BIN, args, { cwd: dir.path, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout!.on('data', (d: Buffer) => outChunks.push(d));
    child.stderr!.on('data', (d: Buffer) => errChunks.push(d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const finish = (code: number) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut,
      });
    };
    child.on('close', (code) => finish(code ?? -1));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: String(e), timedOut });
    });
  });
}

function firstLines(s: string, n = 8): string {
  return s.split(/\r?\n/).slice(0, n).join('\n');
}

function writeArtifact(envelope: Record<string, unknown>, dirName: string): string | null {
  try {
    fs.mkdirSync(DELEGATIONS_DIR, { recursive: true });
    const safe = dirName.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40);
    const file = path.join(DELEGATIONS_DIR, `${Date.now()}-${safe}.json`);
    fs.writeFileSync(file, JSON.stringify(envelope, null, 2), 'utf8');
    return file;
  } catch (e) {
    log('failed to write delegation artifact', e);
    return null;
  }
}

async function toolDelegate(rawArgs: DelegateArgs): Promise<Record<string, unknown>> {
  const directoryToken = typeof rawArgs.directory === 'string' ? rawArgs.directory : '';
  const goal = typeof rawArgs.goal === 'string' ? rawArgs.goal : '';
  const deliverable = typeof rawArgs.deliverable === 'string' ? rawArgs.deliverable : '';
  const timeoutMs =
    typeof rawArgs.timeout_ms === 'number' && rawArgs.timeout_ms > 0
      ? Math.min(rawArgs.timeout_ms, 30 * 60 * 1000)
      : 5 * 60 * 1000;

  if (!directoryToken || !goal) {
    return textContent(
      JSON.stringify(
        { status: 'failure', error: 'Both `directory` and `goal` are required.' },
        null,
        2,
      ),
      true,
    );
  }

  // Preferred path: hand off to the Peers Flow app, which spawns the peer as a
  // tracked, attachable session the user can watch live. Only the app sets
  // PEERSFLOW_BRIDGE_SOCK, so headless/test runs skip straight to the fallback.
  if (BRIDGE_SOCK) {
    log(`delegating "${directoryToken}" via bridge — timeout ${timeoutMs}ms`);
    const envelope = await runBridgeDelegate(directoryToken, goal, deliverable, timeoutMs);
    if (envelope) {
      const artifactPath = writeArtifact(envelope, String(envelope.directory || directoryToken));
      return textContent(JSON.stringify({ ...envelope, artifactPath }, null, 2), envelope.status === 'failure');
    }
    log('bridge unavailable/failed — falling back to headless claude -p');
  }

  return runInlineDelegate(directoryToken, goal, deliverable, timeoutMs);
}

/**
 * Headless fallback used when there's no app bridge (e.g. the MCP server is
 * driven directly by `claude -p` in tests). Runs the peer as a transient
 * `claude -p` and returns the same envelope shape — but it is NOT watchable.
 */
async function runInlineDelegate(
  directoryToken: string,
  goal: string,
  deliverable: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  if (DEPTH >= MAX_DEPTH) {
    return textContent(
      JSON.stringify(
        {
          status: 'failure',
          error:
            'Delegation depth limit reached. A delegated sub-agent cannot itself delegate (depth is capped at 1 hop to prevent cycles).',
        },
        null,
        2,
      ),
      true,
    );
  }

  const dirs = readDirectoriesFromStore(STORE_PATH);
  const dir = resolveDirectory(directoryToken, dirs);
  if (!dir) {
    return textContent(
      JSON.stringify(
        {
          status: 'failure',
          error: `Unknown directory "${directoryToken}". Call list_peers to see valid peers.`,
          known: dirs.map((d) => d.displayName),
        },
        null,
        2,
      ),
      true,
    );
  }
  if (!fs.existsSync(dir.path)) {
    return textContent(
      JSON.stringify(
        { status: 'failure', directory: dir.displayName, error: `Path does not exist: ${dir.path}` },
        null,
        2,
      ),
      true,
    );
  }

  log(`delegating to "${dir.displayName}" (${dir.path}) — timeout ${timeoutMs}ms`);
  const startedAt = Date.now();
  const prompt = buildDelegatePrompt(goal, deliverable);
  const res = await spawnDelegate(dir, prompt, timeoutMs);
  const durationMs = Date.now() - startedAt;

  if (res.timedOut) {
    const envelope = {
      status: 'failure' as const,
      directory: dir.displayName,
      directoryPath: dir.path,
      goal,
      error: `Sub-agent timed out after ${timeoutMs}ms.`,
      durationMs,
    };
    const artifactPath = writeArtifact(envelope, dir.displayName);
    return textContent(JSON.stringify({ ...envelope, artifactPath }, null, 2), true);
  }

  // `claude -p --output-format json` prints a single JSON result object.
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (!parsed) {
    const envelope = {
      status: res.code === 0 ? ('partial' as const) : ('failure' as const),
      directory: dir.displayName,
      directoryPath: dir.path,
      goal,
      summary: 'Sub-agent produced output that could not be parsed as JSON.',
      deliverable: res.stdout.trim() || null,
      error: res.code === 0 ? null : firstLines(res.stderr) || `Exit code ${res.code}`,
      durationMs,
    };
    const artifactPath = writeArtifact(envelope, dir.displayName);
    return textContent(JSON.stringify({ ...envelope, artifactPath }, null, 2), envelope.status === 'failure');
  }

  const result = typeof parsed.result === 'string' ? parsed.result : '';
  const isError = parsed.is_error === true || parsed.subtype === 'error';
  const envelope = {
    status: isError ? ('failure' as const) : ('success' as const),
    directory: dir.displayName,
    directoryPath: dir.path,
    goal,
    summary: firstLines(result) || '(no textual result)',
    deliverable: result,
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
    durationMs,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined,
    numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : undefined,
    error: isError ? result || 'Sub-agent reported an error.' : null,
  };
  const artifactPath = writeArtifact(envelope, dir.displayName);
  return textContent(JSON.stringify({ ...envelope, artifactPath }, null, 2), isError);
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------
async function handleToolsCall(id: JsonRpcId, params: Record<string, unknown>): Promise<void> {
  const name = typeof params.name === 'string' ? params.name : '';
  const args = (params.arguments as Record<string, unknown>) || {};
  try {
    if (name === 'list_peers') {
      sendResult(id, toolListPeers());
      return;
    }
    if (name === 'delegate') {
      sendResult(id, await toolDelegate(args as DelegateArgs));
      return;
    }
    sendError(id, -32602, `Unknown tool: ${name}`);
  } catch (e) {
    // Surface tool failures as a tool result (isError) rather than a transport
    // error, so the calling model sees them and can react.
    sendResult(id, textContent(`Tool "${name}" threw: ${(e as Error).message}`, true));
  }
}

async function handle(req: JsonRpcRequest): Promise<void> {
  const { id, method, params = {} } = req;
  const isNotification = id === undefined;

  switch (method) {
    case 'initialize':
      sendResult(id ?? null, {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_ID, version: '1.0.0' },
      });
      return;
    case 'tools/list':
      sendResult(id ?? null, {
        tools: TOOL_DEFS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      return;
    case 'tools/call':
      await handleToolsCall(id ?? null, params);
      return;
    case 'ping':
      sendResult(id ?? null, {});
      return;
    default:
      if (isNotification) return; // notifications/initialized, cancellations, etc.
      sendError(id ?? null, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// stdin loop
// ---------------------------------------------------------------------------
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      log('failed to parse incoming line', line.slice(0, 200));
      continue;
    }
    void handle(req);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log(`started · store=${STORE_PATH || '(none)'} · depth=${DEPTH}`);
