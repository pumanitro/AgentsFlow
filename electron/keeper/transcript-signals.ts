// What a chat's own transcript says about where it stands: the last thing the
// assistant wrote, whether that reads as "finished", and whether the session has
// armed something that will wake it by itself (a cron, a /loop).
//
// Same split as limit-watch.ts: a pure parser over a transcript tail, and one
// thin reader that finds the file and caches on mtime+size.
//
// Why the transcript and not the daemon's state.json: state.json says a turn
// ended, never HOW it ended. "I've finished everything", "Which option do you
// want?" and a turn that simply ran out of steam all look like `idle` there,
// and those three need three different answers from the Keeper (call it done,
// leave it for the user, type "continue"). The words are only in the transcript.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Conversation } from '../../shared/types';
import { lastAssistantText } from '../main-remote';
import { findTranscript } from '../transcript-path';
import { isQuestion } from './keeper-policy';

export interface TranscriptSignals { lastAssistantText: string | null; lastAssistantAt: number; declaredDone: boolean; hasCron: boolean; hasLoopCommand: boolean; openTasks: number }

// Only the tail is read. The newest turn is a handful of entries; the file
// itself runs to tens of megabytes.
const TAIL_BYTES = 96 * 1024;

// The finish line of an "Until done" chat. Deliberately narrow: a false "done"
// stops the Keeper from keeping a chat alive, and the user finds a half-built
// thing in the morning — the exact failure the Keeper exists to prevent.
//
// The contract's pattern is one alternation under /i. Read literally, its last
// arm (`DONE`) then matches any message that merely ENDS in the word "done" —
// "step 1 done." included, which is precisely the stopped-short case the Keeper
// must nudge. So the phrases are case-insensitive and the bare word is not: a
// shouted DONE is a declaration, "…and that part is done" is a progress note.
const DECLARED_DONE_PHRASE = /\b(all (tasks?|steps?|items?) (are )?(done|complete[d]?)|task (is )?complete[d]?|finished (everything|all)|nothing (left|more) to do)\s*$/i;
const DECLARED_DONE_WORD = /\bDONE\.?\s*$/;

/** Whether the assistant's last words read as "I have finished" (and are not a question). */
export function isDeclaredDone(text: string | null): boolean {
  if (!text) return false;
  if (isQuestion(text)) return false;
  // "All tasks are complete." / "**Task complete!**" — closing punctuation and
  // markdown emphasis are not part of the sentence.
  const trimmed = text.replace(/[\s.!*_`]+$/, '');
  return DECLARED_DONE_PHRASE.test(trimmed) || DECLARED_DONE_WORD.test(trimmed);
}

interface Entry {
  type?: unknown;
  message?: { content?: unknown };
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // Text parts only. A tool_result is a `user` entry too, and one that merely
  // QUOTES a slash command (a file read, a grep hit) is not the user typing it.
  let out = '';
  for (const part of content) {
    const p = part as { type?: unknown; text?: unknown } | null;
    if (p && p.type === 'text' && typeof p.text === 'string') out += p.text + '\n';
  }
  return out;
}

/** Pure. `tail` = the last ≤96 KB of the transcript with the leading fragment dropped (limit-watch rule). */
export function parseTranscriptSignals(tail: string): TranscriptSignals {
  let hasCron = false;
  let hasLoopCommand = false;
  let created = 0;
  let completed = 0;
  for (const raw of tail.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue; // a half-written last line
    }
    // queue-operation, attachment, last-prompt, cost-state … say nothing here.
    // (An `attachment` carries the whole tool catalogue, CronCreate included —
    // matching on raw text instead of on entry type would see a cron in every chat.)
    if (!entry || (entry.type !== 'assistant' && entry.type !== 'user')) continue;
    const content = entry.message?.content;
    if (entry.type === 'user') {
      if (!hasLoopCommand && userText(content).includes('<command-name>/loop')) hasLoopCommand = true;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: unknown; name?: unknown; input?: { status?: unknown } } | null;
      if (!p || p.type !== 'tool_use') continue;
      if (p.name === 'CronCreate') hasCron = true;
      else if (p.name === 'TaskCreate') created++;
      else if (p.name === 'TaskUpdate' && p.input && p.input.status === 'completed') completed++;
    }
  }
  const last = lastAssistantText(tail);
  const at = last ? Date.parse(last.at) : NaN;
  return {
    lastAssistantText: last ? last.text : null,
    lastAssistantAt: Number.isFinite(at) ? at : 0,
    declaredDone: isDeclaredDone(last ? last.text : null),
    hasCron,
    hasLoopCommand,
    openTasks: Math.max(0, created - completed),
  };
}

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Locating a transcript costs a readdir of ~120 project dirs plus a stat each
// whenever the direct path misses (a chat that entered a worktree re-homes its
// transcript). That is fine once; on a 30-second timer it is the kind of steady
// main-thread load this app has had to dig out of before. The path is stable
// for a session's life, so it is resolved once and only re-resolved if it
// vanishes — or if the conversation moves to another session id.
const pathCache = new Map<string, { sessionId: string; file: string }>();

function transcriptFor(conv: Pick<Conversation, 'id' | 'directoryPath' | 'sessionId'>, root: string): string | null {
  if (!conv.sessionId) return null;
  const cached = pathCache.get(conv.id);
  if (cached && cached.sessionId === conv.sessionId && fs.existsSync(cached.file)) return cached.file;
  const found = findTranscript(root, conv.directoryPath, conv.sessionId);
  if (found) pathCache.set(conv.id, { sessionId: conv.sessionId, file: found });
  else pathCache.delete(conv.id);
  return found;
}

/**
 * The last `TAIL_BYTES` of a transcript, with the leading fragment removed.
 *
 * Removing it HERE, and only when the read actually started mid-file, is the
 * point. Dropping the first line unconditionally silently blinds the parser to
 * any transcript short enough to be read whole, where line 0 is a genuine entry
 * and often the only user turn there is.
 */
function readTail(file: string, size: number): string | null {
  let fd: number | null = null;
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    if (start === 0) return text;
    const firstBreak = text.indexOf('\n');
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// A cron set early in a long session is megabytes behind the tail (measured on
// a real hourly-cron chat: the CronCreate sat 96 KB+ back within the first few
// turns), and a Forever chat that looks cron-less gets "continue" typed over
// its sleep every five minutes. So the first time a transcript is seen, the
// whole file is searched once for the tool call's own bytes — a raw scan in
// 1 MB chunks, no parsing — and the answer is remembered for the app's life.
//
// The needle is the block as the CLI serialises it (`name` then `input`). The
// tool catalogue attachment names CronCreate too, but as `"name":…,"description"`,
// and a tool result quoting a transcript has its quotes escaped, so neither matches.
const CRON_NEEDLE = Buffer.from('"name":"CronCreate","input"');
const SCAN_CHUNK = 1024 * 1024;
const SCAN_MAX_BYTES = 64 * 1024 * 1024;

function fileMentionsCron(file: string, size: number): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const overlap = CRON_NEEDLE.length - 1;
    const buf = Buffer.alloc(SCAN_CHUNK + overlap);
    let pos = Math.max(0, size - SCAN_MAX_BYTES);
    let carried = 0;
    while (pos < size) {
      const n = fs.readSync(fd, buf, carried, Math.min(SCAN_CHUNK, size - pos), pos);
      if (n <= 0) break;
      const filled = carried + n;
      if (buf.subarray(0, filled).indexOf(CRON_NEEDLE) !== -1) return true;
      carried = Math.min(overlap, filled);
      buf.copy(buf, 0, filled - carried, filled);
      pos += n;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// An idle chat's transcript stops growing — that is the whole symptom — so
// after the first read every later tick can be a single stat. Keyed on mtime,
// which also means a chat that starts moving again is re-read at once.
//
// A cron or a /loop, once seen, is remembered for as long as the app runs: the
// tail is a 96 KB window, and a cron created three hours of tool output ago has
// scrolled out of it while still being very much set.
const scanCache = new Map<string, { file: string; mtimeMs: number; size: number; signals: TranscriptSignals | null; hasCron: boolean; hasLoopCommand: boolean }>();

/** `parseTranscriptSignals` against a conversation's transcript on disk; null when it cannot be read. */
export function readTranscriptSignals(
  conv: Pick<Conversation, 'id' | 'directoryPath' | 'sessionId'>,
  root: string = projectsRoot(),
): TranscriptSignals | null {
  try {
    const file = transcriptFor(conv, root);
    if (!file) return null;
    const stat = fs.statSync(file);
    const cached = scanCache.get(conv.id);
    const sameFile = !!cached && cached.file === file;
    if (cached && sameFile && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.signals;

    const tail = readTail(file, stat.size);
    let signals = tail === null ? null : parseTranscriptSignals(tail);
    const hasCron = (sameFile && cached!.hasCron) || !!signals?.hasCron
      || (!sameFile && stat.size > TAIL_BYTES && fileMentionsCron(file, stat.size));
    const hasLoopCommand = (sameFile && cached!.hasLoopCommand) || !!signals?.hasLoopCommand;
    if (signals) signals = { ...signals, hasCron, hasLoopCommand };
    scanCache.set(conv.id, { file, mtimeMs: stat.mtimeMs, size: stat.size, signals, hasCron, hasLoopCommand });
    return signals;
  } catch {
    return null;
  }
}

/** Drop cached paths and verdicts for conversations the Keeper no longer follows. */
export function forgetTranscriptSignals(keep: Set<string>): void {
  for (const id of Array.from(scanCache.keys())) if (!keep.has(id)) scanCache.delete(id);
  for (const id of Array.from(pathCache.keys())) if (!keep.has(id)) pathCache.delete(id);
}

/** Test seam: forget every cached path and verdict. */
export function __resetTranscriptSignalsForTests(): void {
  scanCache.clear();
  pathCache.clear();
}
