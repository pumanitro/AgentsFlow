/**
 * The Peers Flow "peer registry" — the shared source of truth describing every
 * tracked directory (which in Peers Flow doubles as a *peer*: a sibling agent
 * rooted in its own directory) so that spawned Claude sessions can be aware of
 * their peers and delegate work to them.
 *
 * "Peer" is deliberately distinct from Claude's own subagents (the Agent/Task
 * tool): subagents are vertical workers a session spawns inside itself; peers
 * are lateral collaborators you delegate to across directories.
 *
 * This module is deliberately dependency-free (only Node built-ins + type-only
 * imports). It is imported BOTH by the Electron main process AND by the
 * standalone MCP server that `claude` spawns as a plain `node` child — the
 * latter cannot touch anything that pulls in `electron`. Keep it that way.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TrackedDirectory } from '../shared/types';

// The MCP server's namespace. Drives the `--mcp-config` key and therefore the
// tool prefix every peer-aware session sees: `mcp__peersflow__<tool>`. Single
// source of truth so the server, the bridge, and the injected prompt agree.
export const SERVER_ID = 'peersflow';
export function qualifiedToolName(tool: string): string {
  return `mcp__${SERVER_ID}__${tool}`;
}

export interface PeerSkill {
  name: string;
  description: string;
  kind: 'command' | 'skill';
}

export interface PeerInfo {
  id: string;
  displayName: string;
  path: string;
  exists: boolean;
  hasClaudeMd: boolean;
  // A project-level `.mcp.json` means this peer wires up its own MCP
  // connections (Slack, Gmail, …) — the capabilities a delegated sub-session
  // would inherit by running rooted there.
  hasProjectMcp: boolean;
  // The slash commands / skills this peer exposes under its own `.claude`.
  skills: PeerSkill[];
}

export interface Registry {
  generatedAt: string;
  peers: PeerInfo[];
}

// Definitions for the tools the Peers Flow MCP server exposes. Shared so the
// server's `tools/list` and the in-app "MCP server" help modal never drift.
export const TOOL_DEFS = [
  {
    name: 'list_peers',
    title: 'List peers',
    description:
      'Return the current Peers Flow registry: every tracked directory ("peer"), its absolute path, the skills/commands it exposes, and whether it has its own MCP connections. Call this to discover who you can delegate to — the list changes as the user adds or removes directories during a session.',
    usage: 'No arguments. Returns a markdown registry of all peers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'delegate',
    title: 'Delegate work to a peer',
    description:
      "Ask another peer (a tracked directory) to deliver something for you. Spawns a fresh Claude session rooted in that peer's directory (so it inherits that peer's skills and MCP connections, e.g. its Slack), runs your goal to completion, and returns a structured result you can rely on. The peer shares NONE of your conversation context, so make `goal` fully self-contained and state the exact `deliverable` you need back.",
    usage: 'delegate({ directory, goal, deliverable?, timeout_ms? })',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Which peer to delegate to: its name (e.g. "arrow"), its absolute path, or its id — as shown by list_peers.',
        },
        goal: {
          type: 'string',
          description: 'A self-contained brief of what you need done and why. The peer has none of your conversation context — spell out everything it needs.',
        },
        deliverable: {
          type: 'string',
          description: 'The exact shape/format of the result you need back (e.g. "a JSON array of channel names", "the permalink of the posted Slack message").',
        },
        timeout_ms: {
          type: 'number',
          description: 'Max time to wait for the peer, in milliseconds. Default 300000 (5 minutes).',
        },
      },
      required: ['directory', 'goal'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_file',
    title: 'Open a file in Peers Flow',
    description:
      'Open a file in the Peers Flow desktop app so the user can see it: the app switches to its file view ("Preview" mode) and displays the file. Use this whenever the user asks you to open / show / pull up / display a file in Peers Flow. By default the file is opened in the peer this session is rooted in; pass `directory` to open it in a different peer. The path may be absolute or relative to that peer\'s directory. PDFs are handed to the system\'s default PDF application when one is available (and only previewed in-app as a fallback).',
    usage: 'open_file({ file, directory?, line? })',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the file to open — absolute, or relative to the target peer\'s directory (e.g. "src/index.ts" or "README.md").',
        },
        directory: {
          type: 'string',
          description: 'Which peer to open the file in: its name (e.g. "trial_case"), its absolute path, or its id — as shown by list_peers. Defaults to the peer this session is rooted in.',
        },
        line: {
          type: 'number',
          description: 'Optional 1-based line number to scroll to and highlight when the file opens.',
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]['name'];

// ---- one-line description extraction (mirrors main.ts' describeMarkdown) ----
function describeMarkdown(filePath: string): string {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '---') break;
      const m = /^description\s*:\s*(.+)$/i.exec(t);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
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

const MAX_SKILLS_PER_PEER = 24;

/** Reads the project-scoped slash commands + skills a peer exposes. */
export function readProjectSkills(dirPath: string): PeerSkill[] {
  const out: PeerSkill[] = [];
  const claudeDir = path.join(dirPath, '.claude');

  const commandsDir = path.join(claudeDir, 'commands');
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, `${prefix}${ent.name}:`);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        out.push({
          name: `${prefix}${ent.name.replace(/\.md$/, '')}`,
          description: describeMarkdown(full),
          kind: 'command',
        });
      }
    }
  };
  walk(commandsDir, '');

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
    out.push({ name: ent.name, description: describeMarkdown(skillFile), kind: 'skill' });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out.slice(0, MAX_SKILLS_PER_PEER);
}

export function buildPeerInfo(dir: TrackedDirectory): PeerInfo {
  let exists = false;
  try {
    exists = fs.statSync(dir.path).isDirectory();
  } catch {
    exists = false;
  }
  const hasClaudeMd = exists && fs.existsSync(path.join(dir.path, 'CLAUDE.md'));
  const hasProjectMcp = exists && fs.existsSync(path.join(dir.path, '.mcp.json'));
  return {
    id: dir.id,
    displayName: dir.displayName,
    path: dir.path,
    exists,
    hasClaudeMd,
    hasProjectMcp,
    skills: exists ? readProjectSkills(dir.path) : [],
  };
}

export function buildRegistry(dirs: TrackedDirectory[]): Registry {
  return {
    generatedAt: new Date().toISOString(),
    peers: dirs.map(buildPeerInfo),
  };
}

/** Reads tracked directories straight off Peers Flow's persisted store.json. */
export function readDirectoriesFromStore(storePath: string): TrackedDirectory[] {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw) as { directories?: TrackedDirectory[] };
    return Array.isArray(parsed.directories) ? parsed.directories : [];
  } catch {
    return [];
  }
}

function skillLine(p: PeerInfo): string {
  if (p.skills.length === 0) return '';
  const names = p.skills.map((s) => s.name).join(', ');
  return ` · exposes: ${names}`;
}

/**
 * The block injected into every spawned session's system prompt so it boots up
 * aware of its peers and knows it can delegate. Kept compact on purpose.
 */
export function renderBootstrapPrompt(reg: Registry): string {
  const lines: string[] = [];
  lines.push('# Peers Flow — your peers & delegation');
  lines.push('');
  lines.push(
    'This Claude session runs inside **Peers Flow**, which tracks several project directories. In Peers Flow each tracked directory is a **peer**: a sibling agent rooted in its own directory, with its own skills and MCP connections (Slack, Gmail, …). A peer is NOT one of your subagents — it is a lateral collaborator you can delegate to and rely on.',
  );
  lines.push('');
  lines.push(`## Your peers (live as of ${reg.generatedAt})`);
  if (reg.peers.length === 0) {
    lines.push('_No directories are currently tracked._');
  } else {
    for (const p of reg.peers) {
      const mcp = p.hasProjectMcp ? ' · has its own MCP connections' : '';
      const missing = p.exists ? '' : ' · ⚠️ path missing';
      lines.push(`- **${p.displayName}** — \`${p.path}\`${skillLine(p)}${mcp}${missing}`);
    }
  }
  lines.push('');
  lines.push('## How to collaborate');
  lines.push(
    `- Call \`${qualifiedToolName('list_peers')}\` any time to refresh this list — the user adds/removes directories during a session.`,
  );
  lines.push(
    `- Call \`${qualifiedToolName('delegate')}\` when a task needs another peer's capability (e.g. its Slack connection) or work done inside it. It spawns a fresh Claude rooted in that peer's directory, runs your goal to completion, and returns a structured result.`,
  );
  lines.push(
    '- The peer shares **none** of your context: make the `goal` self-contained and state the exact `deliverable` you need back.',
  );
  lines.push("- Prefer delegating over reaching into another peer's files directly.");
  lines.push(
    `- Call \`${qualifiedToolName('open_file')}\` when the user asks you to open / show / pull up / display a file — Peers Flow IS the IDE you are running inside, and this is how you open a file in it. It brings the file up in the app's file view. Defaults to the peer you're rooted in; pass \`directory\` to target another peer, and \`line\` to land on a specific line.`,
  );
  lines.push(
    `- Never shell out to \`open -a "Peers Flow" <path>\` for this. That only raises the app window; it does not open the file. \`${qualifiedToolName('open_file')}\` is the only thing that does.`,
  );
  lines.push(
    '- Right BEFORE each `delegate` call, post one short line to the chat stating (a) which peer you are asking and (b) the concrete goal you are handing it — paraphrase the actual `goal` you pass, including the key specifics (what to fetch/do and any names, channels, or constraints). The host shows the call only as "Calling peersflow…", so this line is what gives the user the context of what is being delegated and why.',
  );
  return lines.join('\n');
}

/** Human-readable registry returned by the `list_peers` tool. */
export function renderRegistryMarkdown(reg: Registry): string {
  const lines: string[] = [];
  lines.push(`# Peers Flow — peer registry`);
  lines.push(`_Generated ${reg.generatedAt} · ${reg.peers.length} peer(s)_`);
  lines.push('');
  if (reg.peers.length === 0) {
    lines.push('No directories are currently tracked in Peers Flow.');
    return lines.join('\n');
  }
  for (const p of reg.peers) {
    lines.push(`## ${p.displayName}`);
    lines.push(`- path: \`${p.path}\`${p.exists ? '' : ' (⚠️ missing)'}`);
    lines.push(`- delegate with: \`directory: "${p.displayName}"\``);
    if (p.hasProjectMcp) lines.push('- has its own MCP connections (`.mcp.json`)');
    if (p.hasClaudeMd) lines.push('- has project instructions (`CLAUDE.md`)');
    if (p.skills.length > 0) {
      lines.push('- exposes:');
      for (const s of p.skills) {
        const desc = s.description ? ` — ${s.description}` : '';
        lines.push(`    - \`${s.name}\` (${s.kind})${desc}`);
      }
    }
    lines.push('');
  }
  lines.push(`Delegate to any of these with \`${qualifiedToolName('delegate')}({ directory, goal, deliverable })\`.`);
  return lines.join('\n');
}

/**
 * The self-contained brief handed to a delegated peer. Used both by the main
 * process (spawning a tracked delegation) and the MCP server's headless
 * fallback, so the two never drift.
 */
export function buildDelegatePrompt(goal: string, deliverable: string): string {
  const parts = [
    'You are being delegated a task by another Peers Flow agent (a "peer"). You share none of its context, so treat this brief as complete and self-contained.',
    '',
    '## Goal',
    goal,
  ];
  if (deliverable.trim()) {
    parts.push('', '## Deliverable', `Return exactly this: ${deliverable}`);
  }
  parts.push(
    '',
    'When done, your final message MUST be the deliverable itself (the concrete result/evidence), not a description of what you did.',
  );
  return parts.join('\n');
}

/** Best-effort UTF-8 PATH augmentation reused by the spawned-claude helpers. */
export function localBinPath(): string {
  return path.join(os.homedir(), '.local/bin');
}
