// Forking a conversation to the other provider.
//
// A conversation belongs to one provider for its whole life. The only way
// across is "Fork to Codex" / "Fork to Claude": a NEW conversation starts on
// the other side, seeded with a condensed transcript of the source, while the
// source keeps running exactly where it is. Nothing is moved and no session id
// is cleared — the two chats are independent from the moment the fork is made.
//
// This file is the pure half of that: turning a transcript into a seed the
// other agent can read, and turning a source row into the fork's row plus its
// first message. WHEN the transcript is read differs by direction, and that is
// not an accident. A Claude transcript is a file on disk, so the Codex side
// reads it when its thread actually starts (see `handoverContext` in main.ts)
// and gets the newest state of a session that is still running. A Codex thread
// lives inside the app-server, which forgets it on a restart or a sign-in
// change, so it has to be read at fork time and travels inside the first
// Claude prompt.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentProvider, Conversation, ConversationHandover } from '../shared/types';
import { forkTitle } from '../shared/fork-title';
import { findTranscript } from './transcript-path';

export const HANDOVER_MAX_CHARS = 12_000;
const TAIL_BYTES = 1024 * 1024;

interface Turn { role: 'user' | 'assistant'; text: string }

// What a tool call is worth carrying across. The file paths are the part the
// next agent cannot re-derive: "[used tool Edit]" says work happened somewhere,
// "[edited src/app.ts]" says where, which is the difference between continuing
// the work and starting it again. Tool RESULTS are dropped entirely — they are
// the bulk of a transcript and the least transferable part of it.
function toolUseText(block: Record<string, unknown>): string {
  const name = String(block.name ?? '');
  const input = (block.input ?? {}) as Record<string, unknown>;
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
    const file = typeof input.file_path === 'string' ? input.file_path : '';
    return file ? `[edited ${file}]` : `[used tool ${name}]`;
  }
  if (name === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    return command ? `[ran: ${command.slice(0, 200)}]` : `[used tool ${name}]`;
  }
  return `[used tool ${name}]`;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool_use') parts.push(toolUseText(block));
    // tool_result: skipped — see above.
  }
  return parts.join('\n');
}

/** Pure: user/assistant turns out of a Claude Code transcript (JSONL), text only. */
export function extractClaudeTurns(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (entry.isApiErrorMessage) continue;
    const message = entry.message as { content?: unknown } | undefined;
    const text = textOfContent(message?.content).trim();
    // Tool results come back as user turns holding nothing else; dropping the
    // blocks above leaves them empty, and the check on `text` removes them.
    if (!text) continue;
    turns.push({ role: entry.type, text });
  }
  return turns;
}

/** Newest turns first until the budget is spent, then back in order. */
export function condense(turns: Turn[], maxChars = HANDOVER_MAX_CHARS): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const label = t.role === 'user' ? 'USER' : 'ASSISTANT';
    const body = t.text.length > 2000 ? `${t.text.slice(0, 2000)}…` : t.text;
    const block = `${label}: ${body}`;
    if (used + block.length > maxChars && kept.length > 0) break;
    kept.push(block);
    used += block.length;
  }
  return kept.reverse().join('\n\n');
}

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** The condensed tail of a Claude session's transcript, or '' when unreadable. */
export function claudeHistoryFor(h: Pick<ConversationHandover, 'sessionId' | 'directoryPath'>, maxChars = HANDOVER_MAX_CHARS): string {
  if (!h.sessionId || !h.directoryPath) return '';
  const file = findTranscript(projectsRoot(), h.directoryPath, h.sessionId);
  if (!file) return '';
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      return condense(extractClaudeTurns(text), maxChars);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Same shape for a Codex thread, from the entries the chat view already has. */
export function codexHistoryText(entries: Array<{ role: 'user' | 'assistant' | 'tool'; text: string }>, maxChars = HANDOVER_MAX_CHARS): string {
  const turns: Turn[] = entries
    .filter((e) => e.role !== 'tool' && e.text.trim())
    .map((e) => ({ role: e.role === 'user' ? 'user' : 'assistant', text: e.text }));
  return condense(turns, maxChars);
}

const NAME: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * Context only — for the Codex side, where it travels as developer instructions
 * at thread start and the user's own message stays untouched.
 */
export function buildHandoverContext(opts: { from: AgentProvider; history: string; reason?: string }): string {
  const why = opts.reason ? ` (${opts.reason})` : '';
  const head = `This conversation was handed over to you from ${NAME[opts.from]}${why}. Continue the same work in the same directory: do not start over, and do not repeat steps that are already done.`;
  if (!opts.history.trim()) return `${head}\n\nThe previous transcript could not be read. Ask for a short recap if you need one.`;
  return `${head}\n\n=== Previous conversation with ${NAME[opts.from]} (most recent last) ===\n${opts.history}\n=== End of previous conversation ===`;
}

/** The message the new agent receives first: context, then the user's own words. */
export function buildHandoverPrompt(opts: { from: AgentProvider; history: string; userMessage: string; reason?: string }): string {
  const why = opts.reason ? ` (${opts.reason})` : '';
  const head = `This conversation was handed over to you from ${NAME[opts.from]}${why}. Continue the same work in the same directory: do not start over, and do not repeat steps that are already done.`;
  const user = opts.userMessage.trim() || 'continue';
  if (!opts.history.trim()) {
    return `${head}\n\nThe previous transcript could not be read. Ask for a short recap if you need one.\n\nThe user's message:\n${user}`;
  }
  return `${head}\n\n=== Previous conversation with ${NAME[opts.from]} (most recent last) ===\n${opts.history}\n=== End of previous conversation ===\n\nThe user's message:\n${user}`;
}

// ---------------------------------------------------------------------------
// Planning a fork
// ---------------------------------------------------------------------------

// The names a person reads on the row, as opposed to NAME above, which is how
// the agents themselves are addressed in a prompt.
const SHORT: Record<AgentProvider, string> = { claude: 'Claude', codex: 'Codex' };

/**
 * The first message a fork receives.
 *
 * It asks for a report rather than for work on purpose. A fork is made to get a
 * second opinion or a clean run at something, and an agent that starts editing
 * files off the back of a transcript it has only just read is the failure mode
 * worth designing out — especially here, where the source is still running in
 * the same directory.
 */
export function forkKickoff(from: AgentProvider): string {
  return (
    `This conversation was forked to you from ${NAME[from]}. Read the previous conversation above, ` +
    'then reply with at most three lines: where the work stands and what you would do next. ' +
    'Do not start any work until asked.'
  );
}

export interface ForkPlan {
  /** Title for the fork's row — version-prefixed like any other fork. */
  title: string;
  /** What the fork's row carries beyond what a plain new conversation gets. */
  row: Partial<Conversation>;
  /** The first message sent to the new side. */
  prompt: string;
  /** Where the forked session runs: the source's worktree when it had one. */
  cwd: string;
}

/**
 * Pure: everything a fork to the other provider needs except the ids and the
 * spawning itself.
 *
 * `history` is the source's condensed transcript and is only used for a fork to
 * Claude, whose seed has to travel inside the first prompt. A fork to Codex
 * passes none: its row records which session to read instead, and the Codex
 * thread reads it when it starts.
 */
export function planFork(opts: {
  source: Conversation;
  target: AgentProvider;
  at: string;
  history?: string;
}): ForkPlan {
  const { source, target, at, history = '' } = opts;
  const from: AgentProvider = source.provider === 'codex' ? 'codex' : 'claude';
  const kickoff = forkKickoff(from);
  const reason = `forked from ${SHORT[from]}`;
  // A chat that entered a worktree is working THERE; a fork that continued in
  // the repo it was started from would be reading different files.
  const cwd = source.worktreePath || source.directoryPath;

  const row: Partial<Conversation> = {
    description: `forked to ${SHORT[target]} — starting…`,
    // The row records the kickoff line rather than the message actually sent:
    // a fork to Claude sends the whole seed, and a multi-kilobyte `lastPrompt`
    // is unreadable in the list and pointless in the store.
    intent: kickoff,
    lastPrompt: kickoff,
  };
  if (target === 'codex') {
    // Which session the Codex thread has to read, and where it lives. The
    // Claude direction needs no equivalent — its seed is already in `prompt`.
    row.handover = { from, sessionId: source.sessionId, directoryPath: cwd, at, reason };
  }

  return {
    title: forkTitle(source.title || source.description),
    row,
    cwd,
    prompt: target === 'codex' ? kickoff : buildHandoverPrompt({ from, history, userMessage: kickoff, reason }),
  };
}
