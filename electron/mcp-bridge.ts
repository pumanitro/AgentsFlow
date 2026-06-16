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
 * rebuilt at every spawn, and the `list_peers` tool reads store.json live.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { buildRegistry, renderBootstrapPrompt, SERVER_ID, TOOL_DEFS } from './registry';
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
export function buildBootstrapSystemPrompt(dirs: TrackedDirectory[]): string {
  return renderBootstrapPrompt(buildRegistry(dirs));
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
