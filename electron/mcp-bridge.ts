/**
 * Main-process glue between Peers Flow and the standalone MCP server:
 *  - writes the per-conversation `--mcp-config` JSON each peer-aware session loads,
 *  - builds the registry snapshot injected into each session's system prompt,
 *  - assembles the descriptor the in-app "MCP server" modal renders.
 *
 * The config is per-conversation because it bakes in the *root* conversation's
 * identity (so a delegation can be nested under the session that asked for it)
 * and the path of the delegation bridge socket the server calls back on. The
 * registry the peer sees is fresh two ways — the system-prompt snapshot is
 * rebuilt at every spawn, and the `list_peers` tool reads store.json live
 * (or, for a session on a remote peer's machine, asks the bridge).
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { buildRegistry, renderBootstrapPrompt, SERVER_ID, TOOL_DEFS, type SelfInfo } from './registry';
import { getRemoteHosts } from './remote/remote-hosts';
import type { McpServerInfo, TrackedDirectory } from '../shared/types';

const SERVER_NAME = SERVER_ID;

/** Compiled standalone server. __dirname at runtime is dist/electron/electron. */
export function mcpServerScriptPath(): string {
  return path.join(__dirname, 'mcp', 'agentsflow-mcp-server.js');
}
export function storeJsonPath(): string {
  return path.join(app.getPath('userData'), 'store.json');
}
export function delegationsDir(): string {
  return path.join(app.getPath('userData'), 'delegations');
}
/** Unix-domain socket the MCP server calls back on to spawn tracked delegations. */
export function bridgeSocketPath(): string {
  return path.join(app.getPath('userData'), 'peersflow-bridge.sock');
}
/** Per-conversation mcp-config location. */
export function mcpConfigPathFor(conversationId: string): string {
  return path.join(app.getPath('userData'), 'mcp-configs', `${conversationId}.json`);
}

function buildConfigObject(env: Record<string, string>): Record<string, unknown> {
  return {
    mcpServers: {
      [SERVER_NAME]: {
        // Run the script through Electron-as-Node so we never depend on a
        // system `node` being on PATH (matters for packaged builds).
        command: process.execPath,
        args: [mcpServerScriptPath()],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          PEERSFLOW_STORE_PATH: storeJsonPath(),
          PEERSFLOW_DELEGATIONS_DIR: delegationsDir(),
          PEERSFLOW_BRIDGE_SOCK: bridgeSocketPath(),
          CLAUDE_BIN: process.env.CLAUDE_BIN || 'claude',
          ...env,
        },
      },
    },
  };
}

/**
 * Writes the mcp-config for a specific (root) conversation and returns its path.
 * The baked-in `PEERSFLOW_ROOT_CONVERSATION_ID` is what lets a delegation be
 * attributed back to the session that requested it.
 */
export function writeMcpConfigForConversation(conversationId: string, rootDir: string): string {
  const p = mcpConfigPathFor(conversationId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cfg = buildConfigObject({
    PEERSFLOW_ROOT_CONVERSATION_ID: conversationId,
    PEERSFLOW_ROOT_DIR: rootDir,
  });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return p;
}

/** The registry block appended to every spawned session's system prompt. */
export function buildBootstrapSystemPrompt(dirs: TrackedDirectory[], self?: SelfInfo): string {
  return renderBootstrapPrompt(buildRegistry(dirs), self);
}

/**
 * The remote twin of writeMcpConfigForConversation: writes the config onto the
 * remote peer's machine (its MCP server reaches us through the forwarded
 * bridge socket) and returns the REMOTE path to pass as `--mcp-config`.
 *
 * Differences from the local config, each deliberate:
 *  - `command` is the host's own `node`: Electron-as-Node does not exist there.
 *  - The script is the copy RemoteHosts shipped into the host's bundle dir.
 *  - NO `PEERSFLOW_STORE_PATH`: the laptop's store.json is not on that
 *    machine, and its absence is what makes the server ask the bridge for
 *    `list_peers` instead of reporting an empty registry.
 *  - `PEERSFLOW_BRIDGE_SOCK` is the reverse-forwarded socket on the host, which
 *    ssh connects back to this process's bridge.
 *  - `PEERSFLOW_REMOTE=1` so the headless `whoami` fallback can say so.
 * Every path comes from the host's `hello` (its $HOME), never from this
 * machine's, so a missing piece means "not connected yet" and we refuse
 * rather than write a config that points at laptop paths.
 */
export async function writeRemoteMcpConfig(hostKey: string, conversationId: string, rootDir: string): Promise<string> {
  const r = getRemoteHosts();
  const spec = r?.specFor(hostKey);
  const bundle = r?.bundlePath(hostKey);
  const sock = r?.remoteBridgeSock(hostKey);
  const dir = r?.mcpConfigDir(hostKey);
  const home = r?.home(hostKey);
  if (!r || !spec || !bundle || !sock || !dir || !home) throw new Error(`remote host ${hostKey} is not ready`);
  const cfg = {
    mcpServers: {
      [SERVER_NAME]: {
        command: spec.nodeBin,
        args: [`${bundle}/electron/mcp/agentsflow-mcp-server.js`],
        env: {
          PEERSFLOW_BRIDGE_SOCK: sock,
          PEERSFLOW_DELEGATIONS_DIR: `${home}/.peersflow/delegations`,
          PEERSFLOW_ROOT_CONVERSATION_ID: conversationId,
          PEERSFLOW_ROOT_DIR: rootDir,
          PEERSFLOW_REMOTE: '1',
          CLAUDE_BIN: spec.claudeBin,
        },
      },
    },
  };
  const remotePath = `${dir}/${conversationId}.json`;
  await r.writeFile(hostKey, remotePath, JSON.stringify(cfg, null, 2), 0o600);
  return remotePath;
}

/** Descriptor for the in-app MCP help/preview modal. */
export function getMcpServerInfo(dirs: TrackedDirectory[]): McpServerInfo {
  const reg = buildRegistry(dirs);
  const scriptPath = mcpServerScriptPath();
  // A representative config (the real ones are per-conversation under mcp-configs/).
  const sample = buildConfigObject({ PEERSFLOW_ROOT_CONVERSATION_ID: '<conversation-id>', PEERSFLOW_ROOT_DIR: '<root-dir>' });
  return {
    serverName: SERVER_NAME,
    connected: fs.existsSync(scriptPath),
    scriptPath,
    configPath: path.join(app.getPath('userData'), 'mcp-configs', '<conversation-id>.json'),
    configJson: JSON.stringify(sample, null, 2),
    tools: TOOL_DEFS.map((t) => ({
      name: `mcp__${SERVER_NAME}__${t.name}`,
      title: t.title,
      description: t.description,
      usage: t.usage,
    })),
    peers: reg.peers.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      path: p.path,
      exists: p.exists,
      hasProjectMcp: p.hasProjectMcp,
      skills: p.skills.map((s) => s.name),
    })),
  };
}
