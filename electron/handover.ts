// Moving a conversation from one provider to the other.
//
// When the pool switches provider (by hand, or because rotation found no
// headroom left on this side) every unfinished conversation follows: its row
// keeps its place, title and directory, and the next message it receives goes
// to the new agent together with a condensed transcript of what the previous
// agent did. Nothing is sent at switch time — a handover costs the new
// provider tokens only when the conversation is actually continued.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentProvider, ConversationHandover } from '../shared/types';
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
