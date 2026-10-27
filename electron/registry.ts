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
import type { ChatKind, TrackedDirectory } from '../shared/types';

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
  hasAgentsMd: boolean;
  hasCodexConfig: boolean;
  // A project-level `.mcp.json` means this peer wires up its own MCP
  // connections (Slack, Gmail, …) — the capabilities a delegated sub-session
  // would inherit by running rooted there.
  hasProjectMcp: boolean;
  // The slash commands / skills this peer exposes under its own `.claude`.
  skills: PeerSkill[];
  // Set for a peer on another machine. Everything above then comes from the
  // persisted remoteCache, because its path means nothing on this machine.
  remote?: { hostKey: string; hostname: string };
}

// Who the receiving session itself is, so a prompt can tell it which machine
// and peer it runs on (a remote session otherwise assumes it is on the laptop).
export interface SelfInfo { hostKey: string; hostname: string; dir: string; displayName: string }

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
      "Ask another peer (a tracked directory) to deliver something for you. Spawns a fresh Claude or Codex session rooted in that peer's directory (so it inherits that peer's skills and MCP connections, e.g. its Slack), runs your goal to completion, and returns a structured result you can rely on. The peer shares NONE of your conversation context, so make `goal` fully self-contained and state the exact `deliverable` you need back.",
    usage: 'delegate({ directory, goal, deliverable?, timeout_ms? })',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Which peer to delegate to: its name (e.g. "arrow"), its absolute path, or its id — as shown by list_peers.',
        },
        provider: { type: 'string', enum: ['claude', 'codex'], description: 'Agent to run the goal. Omit to use the calling conversation’s provider.' },
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
      'USER REQUEST REQUIRED: Call this tool ONLY when the user explicitly asks to open or display the specific file in the IDE or a viewer. Default file delivery is a clickable link/URL or an absolute path in chat. Creating, editing, reading, reviewing, or finishing work on a file does NOT authorize opening it. Never call this as an automatic final step or just to present a result; return the link/path without asking to open it. This tool switches the Peers Flow desktop app to its file view ("Preview" mode) and displays the file. By default the file is opened in the peer this session is rooted in; pass `directory` to open it in a different peer. The path may be absolute or relative to that peer\'s directory. PDFs are handed to the system\'s default PDF application when one is available (and only previewed in-app as a fallback).',
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
  {
    name: 'notify',
    title: 'Notify the user',
    description:
      'Available only in chats started by a routine. Show the user a notification in Peers Flow (a bell at the top of every screen; a panel they open). A notification is only a pointer to THIS chat: it shows its title, this chat\'s name, your body, the files you attach (each with Open / Reveal), "Open chat" and "Dismiss" — it never shows questions and never collects answers. Use level "action" when the chat needs the user: questions only they can answer, a file they must check, something they must do by hand (send an email, approve, pay). FIRST write your questions and to-dos as plain text in your own chat reply, THEN call notify with a short pointer body; the user opens the chat, reads them there and answers by typing in this chat. Use level "warn" when something went wrong that the user should know about. The user can dismiss any notification at any time. Never notify when nothing is needed from the user. After an "action" notify, END YOUR TURN: the answers arrive as the user\'s next message in this chat. Never do the user\'s to-dos yourself.',
    usage: 'notify({ title, level, body?, files? })',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line, at most 200 characters, e.g. "Abilitie timesheet is ready — needs you".' },
        level: { type: 'string', enum: ['warn', 'action'], description: '"action" = the user must do something before the work is finished; "warn" = something went wrong, the user should know.' },
        body: { type: 'string', description: 'A short plain-words pointer: what happened and that the chat needs them, e.g. "3 questions about the October timesheet are in the chat." Not the questions themselves — those go in your chat reply. Plain text, at most 4000 characters.' },
        files: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path, or relative to this peer\'s directory.' }, label: { type: 'string', description: 'Shown instead of the file name, e.g. "October timesheet (PDF)".' } }, required: ['path'], additionalProperties: false },
          description: 'Files the user should look at. Each gets an Open button (PDFs open in the system viewer). At most 20.',
        },
      },
      required: ['title', 'level'],
      additionalProperties: false,
    },
  },
  {
    name: 'whoami',
    title: 'Who and where am I',
    description:
      'Return this session\'s identity as Peers Flow sees it: the machine it runs on (hostname / ssh host key or "local"), the peer directory, the conversation id, the Claude session id and background job id. Call it when asked where or what you are running as, or before reporting a path so the user knows which machine it is on.',
    usage: 'No arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add_remote_peer',
    title: 'Add a remote peer',
    description:
      'Track a directory on ANOTHER machine (reached over ssh) as a Peers Flow peer, exactly like the app\'s "Add remote peer" form. Peers Flow first tests the connection (hostname, claude and node versions, whether the directory exists), then saves the peer, connects to the host and waits until it is ready. Sessions there run with bypassPermissions and use THAT machine\'s own Claude login. Only call this when the user asks to add/connect a remote peer. Pass `test_only: true` to just test the connection without saving anything.',
    usage: 'add_remote_peer({ user, host, path, ssh_args?, display_name?, env_file?, claude_bin?, node_bin?, test_only? })',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'ssh login on the remote machine, e.g. "patryk".' },
        host: { type: 'string', description: 'ssh host name or IP, e.g. "theos-mac-studio.tail4a0f3d.ts.net".' },
        path: { type: 'string', description: 'Absolute path of the directory on the remote machine.' },
        ssh_args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra ssh arguments, one per array item, e.g. ["-o","IdentitiesOnly=yes","-i","/Users/demo/.ssh/id_ed25519","-o","ProxyCommand=/opt/homebrew/bin/tailscale --socket=… nc %h %p"]. Binaries inside ProxyCommand need absolute paths.',
        },
        display_name: { type: 'string', description: 'Optional name for the peer card.' },
        env_file: { type: 'string', description: 'Optional file on the remote sourced before every command (e.g. "~/.config/peersflow/env" holding CLAUDE_CODE_OAUTH_TOKEN).' },
        claude_bin: { type: 'string', description: 'claude binary on the remote. Default "claude".' },
        node_bin: { type: 'string', description: 'node binary on the remote. Default "node".' },
        test_only: { type: 'boolean', description: 'Only test the connection; save nothing.' },
      },
      required: ['user', 'host', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_local_peer',
    title: 'Add a local peer',
    description:
      'Track a directory on THIS machine as a Peers Flow peer, exactly like the app\'s "Add directory" button. Peers Flow checks that the path is absolute, exists and is a readable directory, then saves the peer (named after the directory, disambiguated like every other card) and shows it in the sidebar at once; its skills and MCP connections are read from the directory as for any peer. A directory that is already tracked is returned as is, never duplicated. Only call this when the user asks to add/track a local directory as a peer. Pass `test_only: true` to just check the path without saving anything.',
    usage: 'add_local_peer({ path, display_name?, test_only? })',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the directory on this machine, e.g. "/Users/demo/projects/arrow".' },
        display_name: { type: 'string', description: 'Optional name for the peer card, at most 60 characters. Defaults to the directory name. Must not clash with another peer\'s name.' },
        test_only: { type: 'boolean', description: 'Only check the path; save nothing.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_peer',
    title: 'Remove a peer',
    description:
      'Stop tracking a peer (local or remote), exactly like the card\'s "Remove" action: it leaves the sidebar and list_peers, and its conversations come back if the directory is added again. Nothing on disk is ever deleted. Only call this when the user explicitly asks to remove/untrack that peer. Name the peer with one of `name`, `path` or `id`, as shown by list_peers.',
    usage: 'remove_peer({ name? | path? | id? })',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The peer\'s name, as shown by list_peers.' },
        path: { type: 'string', description: 'The peer\'s absolute path.' },
        id: { type: 'string', description: 'The peer\'s id.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_routines',
    title: 'List routines',
    description:
      'Return every routine in the Peers Flow Routines tab: a routine is a saved prompt that Peers Flow starts as a fresh chat in a peer on a schedule. Each entry has its id, name, peer, prompt, schedule in words, whether it is enabled, its next run and how the last run ended. Call this before updating, deleting or running a routine.',
    usage: 'No arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_routine',
    title: 'Create a routine',
    description:
      'Add a routine to the Peers Flow Routines tab, exactly like its "New routine" form: from then on Peers Flow starts a fresh, unattended chat in the chosen peer at each scheduled time and sends it `prompt` as the first message. That chat shares NONE of your conversation context, so `prompt` must be self-contained (a slash command of that peer, e.g. "/reddit-daily-routine", or a full brief). Only call this when the user asks for something to run on a schedule, and tell them the name, peer and schedule you set.',
    usage: 'create_routine({ name, prompt, time, cadence?, directory?, weekday?, weekdays?, month_days?, start_date?, date?, provider?, model?, icon?, catch_up?, enabled? })',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name shown in the Routines tab, at most 60 characters.' },
        prompt: { type: 'string', description: 'The first message of every run, verbatim. Self-contained: the run knows nothing about this conversation.' },
        directory: { type: 'string', description: 'Peer the routine runs in: its name, absolute path or id, as shown by list_peers. Defaults to the peer this session is rooted in.' },
        cadence: { type: 'string', enum: ['once', 'daily', 'every2days', 'weekdays', 'weekly', 'twiceMonthly', 'monthly'], description: 'How often it runs. Default "daily". "once" = a single run on `date` at `time`; if the computer is off then, it runs as soon as the app is back, however many days later. "weekdays" = every week on the days listed in `weekdays` (e.g. Monday, Wednesday, Friday); "weekly" = one day a week.' },
        time: { type: 'string', description: 'Time of day as "HH:MM", 24-hour, in the LOCAL time of the machine Peers Flow runs on, e.g. "09:00".' },
        weekday: { type: 'string', description: 'weekly only: the day name ("monday") or 0–6 with 0 = Sunday. Default Monday.' },
        weekdays: { type: 'array', items: { type: 'string' }, description: 'weekdays only, and required for it: the days of the week it runs on, as day names or 0–6 with 0 = Sunday, e.g. ["monday", "wednesday", "friday"]. At least one day.' },
        month_days: { type: 'array', items: { type: 'number' }, description: 'monthly: one day, e.g. [1]. twiceMonthly: two different days, e.g. [1, 15]. Each 1–28.' },
        start_date: { type: 'string', description: 'every2days only: "YYYY-MM-DD" of a day it runs on; it then runs every second day from there. Default today.' },
        date: { type: 'string', description: 'once only (required for it): "YYYY-MM-DD", the local day of the single run. Must not be in the past.' },
        provider: { type: 'string', enum: ['claude', 'codex'], description: 'Agent that runs it. Default "claude".' },
        model: { type: 'string', description: 'Model alias for the run (e.g. "opus"). Omit for the default.' },
        icon: { type: 'string', enum: ['reddit', 'mail', 'chart', 'broom', 'bug', 'rocket', 'book', 'bell', 'shield', 'leaf', 'coin', 'star', 'gear', 'globe', 'clock', 'flask'], description: 'Icon shown in the Routines tab.' },
        catch_up: { type: 'boolean', description: 'Run a slot late if the computer was off at its time. Default true. Ignored for "once": a one-off always runs late.' },
        enabled: { type: 'boolean', description: 'Pass false to create it paused. Default true.' },
      },
      required: ['name', 'prompt', 'time'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_routine',
    title: 'Change a routine',
    description:
      'Change an existing routine: rename it, replace its prompt, move it to another peer, reschedule it, or pause / resume it with `enabled`. Pass only the fields to change. Only call this when the user asks.',
    usage: 'update_routine({ routine, name?, prompt?, directory?, cadence?, time?, weekday?, weekdays?, month_days?, start_date?, date?, provider?, model?, icon?, catch_up?, enabled? })',
    inputSchema: {
      type: 'object',
      properties: {
        routine: { type: 'string', description: 'Which routine: its id or its exact name, as shown by list_routines.' },
        name: { type: 'string', description: 'New name, at most 60 characters.' },
        prompt: { type: 'string', description: 'New first message for every run.' },
        directory: { type: 'string', description: 'Peer to run in from now on: name, absolute path or id.' },
        cadence: { type: 'string', enum: ['once', 'daily', 'every2days', 'weekdays', 'weekly', 'twiceMonthly', 'monthly'], description: 'How often it runs. "once" = a single run on `date` at `time`. "weekdays" = every week on the days listed in `weekdays`; "weekly" = one day a week.' },
        time: { type: 'string', description: 'Time of day as "HH:MM", 24-hour, in the LOCAL time of the machine Peers Flow runs on, e.g. "09:00".' },
        weekday: { type: 'string', description: 'weekly only: the day name ("monday") or 0–6 with 0 = Sunday. Default Monday.' },
        weekdays: { type: 'array', items: { type: 'string' }, description: 'weekdays only: the days of the week it runs on, as day names or 0–6 with 0 = Sunday, e.g. ["monday", "wednesday", "friday"]. Replaces the whole list; required when switching to the weekdays cadence.' },
        month_days: { type: 'array', items: { type: 'number' }, description: 'monthly: one day, e.g. [1]. twiceMonthly: two different days, e.g. [1, 15]. Each 1–28.' },
        start_date: { type: 'string', description: 'every2days only: "YYYY-MM-DD" of a day it runs on; it then runs every second day from there. Default today.' },
        date: { type: 'string', description: 'once only (required for it): "YYYY-MM-DD", the local day of the single run. Must not be in the past.' },
        provider: { type: 'string', enum: ['claude', 'codex'], description: 'Agent that runs it.' },
        model: { type: 'string', description: 'Model alias for the run (e.g. "opus"). Omit for the default.' },
        icon: { type: 'string', enum: ['reddit', 'mail', 'chart', 'broom', 'bug', 'rocket', 'book', 'bell', 'shield', 'leaf', 'coin', 'star', 'gear', 'globe', 'clock', 'flask'], description: 'Icon shown in the Routines tab.' },
        catch_up: { type: 'boolean', description: 'Run a slot late if the computer was off at its time.' },
        enabled: { type: 'boolean', description: 'false pauses the routine, true resumes it.' },
      },
      required: ['routine'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_routine',
    title: 'Delete a routine',
    description:
      'Remove a routine and its run history from the Routines tab. This cannot be undone; to stop a routine but keep it, use update_routine with `enabled: false` instead. Only call this when the user explicitly asks to delete that routine.',
    usage: 'delete_routine({ routine })',
    inputSchema: {
      type: 'object',
      properties: { routine: { type: 'string', description: 'Which routine: its id or its exact name, as shown by list_routines.' } },
      required: ['routine'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_routine',
    title: 'Run a routine now',
    description:
      'Start a routine immediately, like the "Run now" button: Peers Flow opens its chat right away, outside the schedule, and returns the new chat\'s conversation id without waiting for it to finish. Only call this when the user asks.',
    usage: 'run_routine({ routine })',
    inputSchema: {
      type: 'object',
      properties: { routine: { type: 'string', description: 'Which routine: its id or its exact name, as shown by list_routines.' } },
      required: ['routine'],
      additionalProperties: false,
    },
  },
] as const;

export type ToolDef = (typeof TOOL_DEFS)[number];

// The mcp-config env key that tells the MCP server what kind of chat it serves.
// Missing or unknown means 'chat', so a config written before this flag existed
// (or a typo) fails closed: no notify.
export const CHAT_KIND_ENV = 'PEERSFLOW_CHAT_KIND';

// One string for both refusals (the MCP server's and main's), so a chat that
// somehow calls notify learns where its question belongs instead.
export const NOTIFY_REFUSED =
  'notify is only available to chats started by a routine. This is a casual chat: write your questions and to-dos as plain text in your reply — the user reads them here.';

// A row's own chatKind wins; a row older than the field is a routine chat when
// a routine run points at it.
export function resolveChatKind(conv: { chatKind?: ChatKind } | undefined, hasRoutineRun: boolean): ChatKind {
  return conv?.chatKind ?? (hasRoutineRun ? 'routine' : 'chat');
}

export function chatKindFromEnv(env: NodeJS.ProcessEnv): ChatKind {
  return env[CHAT_KIND_ENV] === 'routine' ? 'routine' : 'chat';
}

// Only a routine runs unattended, so only a routine's chat may ring the bell; a
// casual chat has the user reading it already.
export function mayNotify(kind: ChatKind): boolean {
  return kind === 'routine';
}

export function toolDefsFor(kind: ChatKind): readonly ToolDef[] {
  return mayNotify(kind) ? TOOL_DEFS : TOOL_DEFS.filter((t) => t.name !== 'notify');
}

/** The tools that are one `routines` bridge request each, and the `op` they send. */
export const ROUTINE_TOOL_OPS: Record<string, string> = {
  list_routines: 'list',
  create_routine: 'create',
  update_routine: 'update',
  delete_routine: 'delete',
  run_routine: 'run',
};

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

  for (const skillsDir of [path.join(claudeDir, 'skills'), path.join(dirPath, '.agents', 'skills')]) {
    let skillEntries: fs.Dirent[] = [];
    try {
      skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      /* no skills dir */
    }
    for (const ent of skillEntries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const skillFile = path.join(skillsDir, ent.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      if (!out.some((s) => s.name === ent.name && s.kind === 'skill')) out.push({ name: ent.name, description: describeMarkdown(skillFile), kind: 'skill' });
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out.slice(0, MAX_SKILLS_PER_PEER);
}

export function buildPeerInfo(dir: TrackedDirectory): PeerInfo {
  if (dir.remote) {
    // Never stat a remote path locally: a same-named local dir would lie.
    // No cache yet (host never connected) reads as "missing, no skills".
    // hostKey is spelled out rather than imported so this module stays
    // shippable to the remote host as a single file.
    const c = dir.remoteCache;
    return {
      id: dir.id,
      displayName: dir.displayName,
      path: dir.path,
      exists: c?.exists ?? false,
      hasClaudeMd: c?.hasClaudeMd ?? false,
      hasAgentsMd: c?.hasAgentsMd ?? false,
      hasCodexConfig: c?.hasCodexConfig ?? false,
      hasProjectMcp: c?.hasProjectMcp ?? false,
      skills: c ? c.skills.slice(0, MAX_SKILLS_PER_PEER) : [],
      remote: { hostKey: `${dir.remote.user}@${dir.remote.host}`, hostname: c?.hostname ?? dir.remote.host },
    };
  }
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
    hasAgentsMd: exists && fs.existsSync(path.join(dir.path, 'AGENTS.md')),
    hasCodexConfig: exists && fs.existsSync(path.join(dir.path, '.codex', 'config.toml')),
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
// `self` is set only for a session running on a remote peer's machine: without
// it that session assumes it shares the laptop's filesystem and hands back
// paths nobody on the laptop can open.
export function renderBootstrapPrompt(reg: Registry, self?: SelfInfo, kind: ChatKind = 'chat'): string {
  const lines: string[] = [];
  lines.push('# Peers Flow — your peers & delegation');
  lines.push('');
  lines.push('## File delivery — links by default; opening requires an explicit user request');
  lines.push('');
  lines.push('- **Return a clickable file link/URL or an absolute file path in chat by default. Keep the user in chat.**');
  lines.push(
    `- **NEVER call \`${qualifiedToolName('open_file')}\` unless the user explicitly asks to open or display that specific file in the IDE or a viewer.** A request to create, edit, read, inspect, review, or deliver a file is not permission to open it on the user's screen. Reading files internally to do the work is fine.`,
  );
  lines.push('- Never open a file automatically when finishing a task, presenting an artifact, or reporting changes. A request for a link, URL, or path must be answered in chat.');
  lines.push('- Without an explicit request to open the file, just provide the link/path; do not add a routine permission question. Do not bypass this rule with shell commands, another tool, or UI automation.');
  lines.push('- This rule also applies to delegated peers. Pass along permission to open a file only when the user has explicitly given it for that file.');
  lines.push('');
  if (mayNotify(kind)) {
    lines.push('## Telling the user something (notifications)');
    lines.push('');
    lines.push('- This chat was started by a **routine**, so it may reach the user through the bell (`notify`). Casual chats cannot.');
    lines.push(
      `- When the work cannot finish without the user — questions only they can answer, a file they must check, something they must do by hand (send an email, approve, pay) — list the questions and the to-dos as plain text in your chat message, then call \`${qualifiedToolName('notify')}\` with level "action", a short pointer body and any files, then END YOUR TURN. The notification only points the user to this chat; they answer by typing here, so the answers arrive as the user's next chat message — continue from there. Never do the user's to-dos yourself.`,
    );
    lines.push('- When something went wrong that the user should know about, call it with level "warn".');
    lines.push('- Do not notify when nothing is needed from the user — the app already shows that a chat finished.');
  } else {
    lines.push('## This is a casual chat — no notifications');
    lines.push('');
    lines.push(
      "- This chat was started by the user, not by a routine (Routines tab), so it has no `notify` tool and must not try to reach the user's bell any other way. When you need the user — a question, a file to check, a to-do — write it as plain text in your reply and end your turn; the user is reading this chat.",
    );
  }
  lines.push('');
  lines.push(
    'This agent session runs inside **Peers Flow**, which tracks several project directories. In Peers Flow each tracked directory is a **peer**: a sibling agent rooted in its own directory, with its own skills and MCP connections (Slack, Gmail, …). A peer is NOT one of your subagents — it is a lateral collaborator you can delegate to and rely on.',
  );
  lines.push('');
  lines.push(`## Your peers (live as of ${reg.generatedAt})`);
  if (reg.peers.length === 0) {
    lines.push('_No directories are currently tracked._');
  } else {
    for (const p of reg.peers) {
      const mcp = p.hasProjectMcp ? ' · has its own MCP connections' : '';
      const missing = p.exists ? '' : ' · ⚠️ path missing';
      // A remote peer's path lives on another machine; say which, or the
      // reader treats it as a local path and goes looking for it.
      const where = p.remote ? ` on ${p.remote.hostname} (remote peer, ssh \`${p.remote.hostKey}\`)` : '';
      lines.push(`- **${p.displayName}** — \`${p.path}\`${where}${skillLine(p)}${mcp}${missing}`);
    }
  }
  lines.push('');
  if (self) {
    lines.push('## Where you are running');
    lines.push(
      `You are running on **${self.hostname}** (ssh \`${self.hostKey}\`), inside the remote peer **${self.displayName}** at \`${self.dir}\`. Your working tree, your \`~/.claude\` skills and every path you print are on THAT machine. The Peers Flow app, the delegation bridge and every peer not marked "remote" live on the user's laptop; paths you receive from them are laptop paths. Call \`${qualifiedToolName('whoami')}\` for your exact ids when you need to report where you are.`,
    );
    lines.push('');
  }
  lines.push('## How to collaborate');
  lines.push('Before project work, follow AGENTS.md. If the directory has only CLAUDE.md, read and follow that file as the repository guidance. Each provider uses its own configured connections; a configuration file is not proof of authentication.');
  lines.push('Directory instructions and user approvals still apply. Connections do not grant permission to send messages or change external state. Tool prefixes differ between hosts; use the peersflow tools as exposed by your runtime.');
  lines.push(
    `- Call \`${qualifiedToolName('list_peers')}\` any time to refresh this list — the user adds/removes directories during a session.`,
  );
  lines.push(
    `- Call \`${qualifiedToolName('delegate')}\` when a task needs another peer's capability (e.g. its Slack connection) or work done inside it. It spawns a fresh agent (use provider: claude or codex to choose) rooted in that peer's directory, runs your goal to completion, and returns a structured result.`,
  );
  lines.push(
    '- The peer shares **none** of your context: make the `goal` self-contained and state the exact `deliverable` you need back.',
  );
  lines.push("- Prefer delegating over reaching into another peer's files directly.");
  lines.push(
    `- When the user asks to connect or add a directory on another machine, call \`${qualifiedToolName('add_remote_peer')}\` (user, host, absolute path, ssh options). It tests the connection first and returns the new peer's name to delegate to.`,
  );
  lines.push(
    `- When the user asks to add or track a directory on this machine as a peer, call \`${qualifiedToolName('add_local_peer')}\` (absolute path). It returns the new peer's name to delegate to. \`${qualifiedToolName('remove_peer')}\` untracks a peer (never deletes files); call it only when the user explicitly asks.`,
  );
  lines.push(
    `- When the user asks for something to run on a schedule ("every morning", "each Monday") or once at a set day and time ("tomorrow at 9", "on Friday"; cadence \`once\` + \`date\`), call \`${qualifiedToolName('create_routine')}\`: it adds a routine to the app's Routines tab, which starts a fresh chat in a peer at each scheduled time. \`${qualifiedToolName('list_routines')}\`, \`${qualifiedToolName('update_routine')}\` (also pauses / resumes), \`${qualifiedToolName('delete_routine')}\` and \`${qualifiedToolName('run_routine')}\` manage them. Never create, change, delete or run a routine the user did not ask for.`,
  );
  lines.push(
    `- Only after an explicit user request to open / show / pull up / display a specific file in the IDE or a viewer, use \`${qualifiedToolName('open_file')}\`. Peers Flow is the IDE you are running inside; this tool brings the file up in its file view. Defaults to the peer you're rooted in; pass \`directory\` to target another peer, and \`line\` to land on a specific line.`,
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
    if (p.remote) lines.push(`- host: ${p.remote.hostname} (remote peer, ssh \`${p.remote.hostKey}\`)`);
    lines.push(`- delegate with: \`directory: "${p.displayName}"\``);
    if (p.hasProjectMcp) lines.push('- has its own MCP connections (`.mcp.json`)');
    if (p.hasClaudeMd) lines.push('- Claude instructions: `CLAUDE.md`');
    if (p.hasAgentsMd) lines.push('- Codex instructions: `AGENTS.md`');
    if (p.hasCodexConfig) lines.push('- Codex project configuration: `.codex/config.toml`');
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
    'Follow AGENTS.md in your directory. If it is absent, read CLAUDE.md before doing project work.',
    '',
    'Deliver files as clickable links/URLs or absolute paths in your response. Do not open files in the IDE or a viewer unless this brief relays an explicit user request to open that specific file. Creating, editing, or completing a file does not grant that permission; do not ask to open it as a routine final step.',
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
