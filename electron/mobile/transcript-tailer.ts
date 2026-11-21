// Readers over a Claude Code transcript (.jsonl) for the mobile gateway.
//
// Pure, synchronous `fs` like keeper/transcript-signals.ts; no electron import.
// All offsets are BYTE offsets into the file, so they can be handed to the
// phone as cursors and come back as `?before=` / `fromEnd` unchanged.
//
// Known limit: consecutive sidechain (subagent) entries collapse into one
// `subagent` entry only within the lines read together. A run that straddles a
// page boundary of `readMessagesPage`, or an append boundary of
// `readAppended`, shows up as two `subagent` entries.
import * as fs from 'fs';
import * as path from 'path';
import type { MessageEntry, MessageSource, MessagesPage } from '../../shared/mobile';
import type { LogFn, Tailer } from './types';

const CHUNK = 256 * 1024;
const TOOL_RESULT_MAX = 2048;

/** Normalisation used to match a sent message against the transcript's user text. */
export function normaliseText(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

// A slash command reaches the transcript as CLI markup:
//   <command-message>voice-task</command-message>
//   <command-name>/voice-task</command-name>
//   <command-args>check the invoices…</command-args>
// The phone shows what the user actually said: "/voice-task check the invoices…".
const CMD_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const CMD_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
export function readableUserText(text: string): string {
  if (!text.includes('<command-name>')) return text;
  const name = CMD_NAME.exec(text)?.[1]?.trim() ?? '';
  const args = CMD_ARGS.exec(text)?.[1]?.trim() ?? '';
  const rest = text
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(CMD_NAME, '').replace(CMD_ARGS, '').trim();
  const head = [name.startsWith('/') || !name ? name : '/' + name, stripSpokenAt(args)].filter(Boolean).join(' ');
  return [head, rest].filter(Boolean).join('\n');
}
// A background agent finishing reaches the transcript as a user turn of raw XML
// (<task-notification><task-id>…<summary>Agent "x" finished</summary><result>…).
// The phone shows one short line instead: 'Agent "x" finished · completed'.
// Returns null when the text is not such a notification.
const TAG = (t: string, name: string): string =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(t)?.[1]?.trim() ?? '';
export function noticeText(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith('<task-notification>')) return null;
  const summary = TAG(t, 'summary') || 'Background task update';
  const status = TAG(t, 'status');
  return status && !summary.toLowerCase().includes(status.toLowerCase()) ? `${summary} · ${status}` : summary;
}
// Strip harness-only blocks the user never typed.
export function stripHarnessBlocks(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

// The gateway appends "spokenAt: <iso>" to a voice task for the agent; the user never said it.
export function stripSpokenAt(s: string): string {
  return s.replace(/\s*\n\s*spokenAt:\s*\S+\s*$/, '').trim();
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

export function toolSummary(name: string, input: unknown): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof inp[k] === 'string' ? (inp[k] as string) : '');
  let out: string;
  switch (name) {
    case 'Bash':
      out = `Bash: ${str('description') || str('command')}`;
      break;
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      out = `${name}: ${path.basename(str('file_path') || str('notebook_path') || '')}`;
      break;
    case 'Agent': case 'Task':
      out = `Agent: ${str('description') || str('prompt').slice(0, 80)}`;
      break;
    case 'Grep': case 'Glob':
      out = `${name}: ${str('pattern')}`;
      break;
    case 'WebFetch': case 'WebSearch':
      out = `${name}: ${str('url') || str('query')}`;
      break;
    default: {
      const first = Object.values(inp).find((v) => typeof v === 'string' && v.trim().length > 0) as string | undefined;
      out = first ? `${name}: ${oneLine(first, 80)}` : name;
    }
  }
  return oneLine(out, 120);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const part = p as { type?: string; text?: unknown };
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    else if (part.type === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

interface ParsedLine { text: string; offset: number }
type Tagged = { entry: MessageEntry; line: number };

/** Core parser: entries tagged with the index of the line that produced them. */
function parseTagged(lines: string[], sources?: Map<string, MessageSource>): Tagged[] {
  const out: Tagged[] = [];
  let run: { entry: MessageEntry; hasText: boolean } | null = null;
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li].trim();
    if (!raw || raw[0] !== '{') continue;
    let e: any;
    try { e = JSON.parse(raw); } catch { continue; }
    if (!e || (e.type !== 'user' && e.type !== 'assistant')) continue;
    if (e.type === 'user' && e.isMeta) continue;
    const at: string = typeof e.timestamp === 'string' ? e.timestamp : '';
    const uuid: string = typeof e.uuid === 'string' && e.uuid ? e.uuid : `noid-${li}`;
    const rawContent = e.message?.content;
    const parts: any[] = typeof rawContent === 'string' ? [{ type: 'text', text: rawContent }]
      : Array.isArray(rawContent) ? rawContent : [];

    if (e.isSidechain === true) {
      if (!run) {
        run = { entry: { id: `${uuid}:0`, kind: 'subagent', at, text: 'subagent working', sidechain: true }, hasText: false };
        out.push({ entry: run.entry, line: li });
      }
      if (!run.hasText) {
        for (const p of parts) {
          if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
            run.entry.text = oneLine(p.text, 300);
            run.hasText = true;
            break;
          }
        }
      }
      continue;
    }
    run = null;

    parts.forEach((p, i) => {
      if (!p || typeof p !== 'object') return;
      const id = `${uuid}:${i}`;
      if (e.type === 'user') {
        if (p.type === 'text' && typeof p.text === 'string') {
          const notice = noticeText(p.text);
          if (notice) { out.push({ entry: { id, kind: 'notice', at, text: notice }, line: li }); return; }
          const clean = stripHarnessBlocks(p.text);
          if (!clean) return;
          const entry: MessageEntry = { id, kind: 'user.text', at, text: readableUserText(clean) };
          const src = sources?.get(normaliseText(p.text));
          if (src) entry.source = src;
          out.push({ entry, line: li });
        } else if (p.type === 'tool_result') {
          const full = toolResultText(p.content);
          const entry: MessageEntry = { id, kind: 'tool_result', at, text: full.slice(0, TOOL_RESULT_MAX) };
          if (typeof p.tool_use_id === 'string') entry.toolUseId = p.tool_use_id;
          if (full.length > TOOL_RESULT_MAX) entry.truncated = true;
          out.push({ entry, line: li });
        }
      } else {
        if (p.type === 'text' && typeof p.text === 'string') {
          if (!p.text.trim()) return;
          out.push({ entry: { id, kind: 'assistant.text', at, text: p.text }, line: li });
        } else if (p.type === 'tool_use') {
          const name = typeof p.name === 'string' ? p.name : 'tool';
          const entry: MessageEntry = { id, kind: 'tool_use', at, text: toolSummary(name, p.input), toolName: name };
          if (typeof p.id === 'string') entry.toolUseId = p.id;
          out.push({ entry, line: li });
        } else if (p.type === 'thinking') {
          out.push({ entry: { id, kind: 'thinking', at, text: typeof p.thinking === 'string' ? p.thinking : '' }, line: li });
        }
      }
    });
  }
  return out;
}

export function entriesFromJsonl(lines: string[], sources?: Map<string, MessageSource>): MessageEntry[] {
  return parseTagged(lines, sources).map((t) => t.entry);
}

function readRange(file: string, start: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  if (len <= 0) return buf;
  const fd = fs.openSync(file, 'r');
  try {
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

export function readMessagesPage(file: string, o: { before?: number; limit: number }): MessagesPage {
  const limit = Math.max(1, Math.floor(o.limit) || 1);
  let size: number;
  try { size = fs.statSync(file).size; } catch { return { entries: [], hasMore: false, cursor: 0, end: 0 }; }
  const reqEnd = Math.max(0, Math.min(o.before ?? size, size));

  // Complete lines, newest first, collected backwards in chunks.
  const collected: ParsedLine[] = [];
  let pos = reqEnd;
  let tail: Buffer = Buffer.alloc(0);   // bytes after `pos` not yet split into a full line
  let end = -1;                          // byte offset after the last complete line
  let tagged: Tagged[] = [];
  let ordered: ParsedLine[] = [];
  while (pos > 0) {
    const start = Math.max(0, pos - CHUNK);
    const chunk = readRange(file, start, pos - start);
    let buf = tail.length ? Buffer.concat([chunk, tail]) : chunk;
    let bufStart = start;
    if (end < 0) {
      // Ignore a trailing partial line (no '\n') at the requested end.
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl === -1) {
        if (start === 0) { end = 0; tail = Buffer.alloc(0); pos = 0; break; }
        tail = buf; pos = start; continue;
      }
      end = bufStart + lastNl + 1;
      buf = buf.subarray(0, lastNl + 1);
    }
    // Split `buf` into lines; the first one is incomplete unless we hit offset 0.
    let lineEnd = buf.length;      // exclusive, points just past a '\n'
    let i = buf.length - 2;
    const fresh: ParsedLine[] = [];
    while (i >= -1) {
      if (i === -1 || buf[i] === 0x0a) {
        const ls = i + 1;
        if (i === -1 && start > 0) break;   // partial head: keep for the next chunk
        fresh.push({ text: buf.subarray(ls, lineEnd).toString('utf8'), offset: bufStart + ls });
        lineEnd = ls;
      }
      i--;
    }
    tail = buf.subarray(0, lineEnd);
    collected.push(...fresh);
    pos = start;
    ordered = collected.slice().reverse();
    tagged = parseTagged(ordered.map((l) => l.text));
    if (tagged.length >= limit) break;
  }
  if (end < 0) end = reqEnd === size ? 0 : reqEnd;
  if (collected.length === 0) return { entries: [], hasMore: false, cursor: 0, end: Math.max(0, end) };

  let pick = tagged;
  let cursor: number;
  if (tagged.length > limit) {
    pick = tagged.slice(tagged.length - limit);
    const cutLine = pick[0].line;
    if (tagged[tagged.length - limit - 1].line === cutLine) {
      // The cut falls inside one line: drop that line's newer parts too so the
      // next page (before = its start) returns the whole line exactly once.
      const rest = pick.filter((t) => t.line !== cutLine);
      if (rest.length > 0) pick = rest;
      else pick = tagged.filter((t) => t.line === cutLine);   // one line > limit: return it whole
    }
    cursor = ordered[pick[0].line].offset;
  } else {
    // Either the file start was reached (everything older is returned), or
    // exactly `limit` entries were found and the oldest one's line is the cursor.
    cursor = pos === 0 || tagged.length === 0 ? 0 : ordered[tagged[0].line].offset;
  }
  return { entries: pick.map((t) => t.entry), hasMore: cursor > 0, cursor, end };
}

export function readAppended(file: string, from: number): { entries: MessageEntry[]; end: number } {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return { entries: [], end: from }; }
  let start = Math.max(0, from);
  if (size < start) start = 0;   // truncated / rotated
  if (size === start) return { entries: [], end: start };
  let buf: Buffer;
  try { buf = readRange(file, start, size - start); } catch { return { entries: [], end: start }; }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return { entries: [], end: start };
  const text = buf.subarray(0, lastNl + 1).toString('utf8');
  return { entries: entriesFromJsonl(text.split('\n')), end: start + lastNl + 1 };
}

export function hasUserTextAfter(file: string, from: number, text: string): boolean {
  const needle = text.trim();
  if (!needle) return false;
  const needleFlat = normaliseText(needle);
  const matches = (s: string): boolean => s.includes(needle) || normaliseText(s).includes(needleFlat);
  const { entries } = readAppended(file, from);
  if (entries.some((e) => (e.kind === 'user.text' || e.kind === 'tool_result') && matches(e.text))) return true;
  // A chat that is mid-turn does not write a user line for typed input: Claude
  // queues it ({"type":"queue-operation","operation":"enqueue","content":…})
  // and absorbs it later. That IS accepted — missing it made the phone retype
  // the message dozens of times and report "Not sent" (2026-11-06).
  return queuedTextsAfter(file, from).some(matches);
}

function queuedTextsAfter(file: string, from: number): string[] {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return []; }
  let start = Math.max(0, from);
  if (size < start) start = 0;
  if (size === start) return [];
  let raw: string;
  try { raw = readRange(file, start, size - start).toString('utf8'); } catch { return []; }
  const out: string[] = [];
  for (const l of raw.split('\n')) {
    if (!l.includes('"queue-operation"') || !l.includes('"enqueue"')) continue;
    try {
      const d = JSON.parse(l) as { type?: string; operation?: string; content?: unknown };
      if (d.type === 'queue-operation' && d.operation === 'enqueue' && typeof d.content === 'string') out.push(d.content);
    } catch { /* partial line */ }
  }
  return out;
}

export function createTailer(o: { intervalMs?: number; log: LogFn }): Tailer {
  const intervalMs = o.intervalMs ?? 1000;
  type Sub = { file: string; end: number; onAppend: (entries: MessageEntry[], end: number) => void; missingLogged: boolean };
  const subs = new Map<string, Sub>();
  let timer: NodeJS.Timeout | null = null;

  const tick = (): void => {
    for (const [convId, s] of Array.from(subs.entries())) {
      let size: number;
      try { size = fs.statSync(s.file).size; } catch {
        if (!s.missingLogged) { s.missingLogged = true; o.log('[agentsflow][mobile] tailer: transcript missing', { convId, file: s.file }); }
        continue;
      }
      s.missingLogged = false;
      if (size === s.end) continue;
      try {
        const r = readAppended(s.file, s.end);
        s.end = r.end;
        if (r.entries.length > 0 && subs.get(convId) === s) s.onAppend(r.entries, r.end);
      } catch (err) {
        o.log('[agentsflow][mobile] tailer: read failed', { convId, error: String(err) });
      }
    }
  };
  const ensureTimer = (): void => {
    if (subs.size > 0 && !timer) {
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    } else if (subs.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  return {
    subscribe(convId, file, fromEnd, onAppend) {
      subs.set(convId, { file, end: fromEnd, onAppend, missingLogged: false });
      ensureTimer();
    },
    unsubscribe(convId) {
      subs.delete(convId);
      ensureTimer();
    },
    stop() {
      subs.clear();
      ensureTimer();
    },
  };
}
