// What the user actually SENT to an agent — the "truth" a Wispr dictation is
// compared against. Dictation history says what Wispr heard and pasted; the
// transcript says what left the composer after the user fixed it by hand. The
// difference between the two is what the learner learns from.
//
// The transcripts are big and hot: Claude Code alone touched 127 files / 377 MB
// in a 48 h sample, single files up to 36 MB, almost all of it tool output. A
// tick every few minutes cannot re-read that. So every source here is
// INCREMENTAL: per file it remembers the byte offset it has consumed and, on
// the next call, reads only what was appended since. Files untouched since the
// start of the window are not even opened (one stat each).

import * as fs from 'fs';
import type { TruthSource, UserMessage } from './types';

const LOG = '[agentsflow][wispr-learner]';
export const DEFAULT_RETAIN_MS = 48 * 60 * 60 * 1000;

/**
 * Human text out of a raw user turn, or null when the turn is not something a
 * person typed/dictated (harness injections, interrupt markers, attachments
 * boilerplate, empty strings).
 */
export function cleanUserText(raw: string): string | null {
  let t = raw.trim();
  if (!t || t.startsWith('<') || t.startsWith('[Request interrupted')) return null;
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  // Peers Flow wraps pasted text in <pasted_content …>…</pasted_content>: pasted, not
  // dictated, so neither its words nor the tag name belong to the user's vocabulary.
  t = t.replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g, ' ');
  // Any other harness tag left in a mixed turn: drop the tag itself, keep the words.
  t = t.replace(/<\/?[A-Za-z][\w-]*\b[^<>]*>/g, ' ');
  t = t.replace(/\[Image #\d+\]/g, '');
  // Codex (and pasted images in Claude) append an "I attached N image…" footer
  // listing absolute paths — never part of what was said.
  const footer = t.indexOf('\n\nI attached ');
  if (footer >= 0) t = t.slice(0, footer);
  t = t.replace(/\s+/g, ' ').trim();
  return t.length < 2 ? null : t;
}

/** Merge several sources; one broken source must not cost the others. */
export async function readAllMessages(sources: TruthSource[], fromMs: number, toMs: number): Promise<UserMessage[]> {
  const settled = await Promise.allSettled(sources.map((s) => s.readMessages(fromMs, toMs)));
  const out: UserMessage[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') out.push(...r.value);
    else console.warn(`${LOG} truth source ${sources[i]?.name ?? i} failed`, (r.reason as Error)?.message ?? r.reason);
  });
  return out.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------
// The shared incremental engine (Claude and Codex differ only in which files
// to look at and how to parse one line).

export interface IncrementalTruthOptions {
  name: TruthSource['name'];
  retainMs?: number;
  /** Candidate files for a window; the engine still skips ones with mtime < fromMs. */
  listFiles(fromMs: number, toMs: number): Promise<string[]>;
  /** Parse one complete line of `file`. */
  parseLine(line: string, file: string): UserMessage | null;
}

/** Test-only introspection; not part of TruthSource. */
export interface IncrementalTruth extends TruthSource {
  __stats(): { offsets: Record<string, number>; bytesRead: number; opened: number; buffered: number };
}

interface FileState { offset: number; carry: Buffer }

// A file that cannot be read (permissions, vanished mid-tick) is skipped every
// tick — warn once per process, not every five minutes forever.
const warned = new Set<string>();
function warnOnce(file: string, err: unknown): void {
  if (warned.has(file)) return;
  warned.add(file);
  console.warn(`${LOG} cannot read transcript, skipping`, file, (err as Error)?.message ?? err);
}

const NL = 0x0a;
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

export function createIncrementalTruth(opts: IncrementalTruthOptions): IncrementalTruth {
  const retainMs = opts.retainMs ?? DEFAULT_RETAIN_MS;
  const files = new Map<string, FileState>();
  // Keyed for dedupe: a rewritten file is re-read from 0 and yields its old turns again.
  const buffer = new Map<string, UserMessage>();
  let bytesRead = 0;
  let opened = 0;
  // Serialize calls: two overlapping reads of one file would both start at the same offset.
  let chain: Promise<unknown> = Promise.resolve();

  const keep = (m: UserMessage): void => {
    buffer.set(`${m.sessionId}\u0000${m.at}\u0000${m.text}`, m);
  };

  const consumeLines = (file: string, chunk: Buffer, st: FileState): void => {
    const data = st.carry.length ? Buffer.concat([st.carry, chunk]) : chunk;
    let start = 0;
    for (let nl = data.indexOf(NL, start); nl >= 0; nl = data.indexOf(NL, start)) {
      if (nl > start) {
        const m = opts.parseLine(data.toString('utf8', start, nl), file);
        if (m) keep(m);
      }
      start = nl + 1;
    }
    // Split on bytes, not decoded text: a chunk (or EOF mid-write) can end inside
    // a multi-byte character, and a decoded carry would turn it into U+FFFD.
    st.carry = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
  };

  const readFile = async (file: string, fromMs: number): Promise<void> => {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch (err) {
      warnOnce(file, err);
      return;
    }
    if (stat.mtimeMs < fromMs) return;
    let st = files.get(file);
    if (!st) files.set(file, (st = { offset: 0, carry: Buffer.alloc(0) }));
    if (stat.size < st.offset) {
      // Shorter than what we consumed ⇒ rewritten (compaction, restore): start over.
      st.offset = 0;
      st.carry = Buffer.alloc(0);
    }
    if (stat.size === st.offset) return;
    const end = stat.size;
    const state = st;
    opened++;
    try {
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(file, { start: state.offset, end: end - 1 });
        rs.on('data', (chunk) => {
          const b = chunk as Buffer;
          bytesRead += b.length;
          consumeLines(file, b, state);
        });
        rs.on('error', reject);
        rs.on('end', resolve);
      });
      state.offset = end;
    } catch (err) {
      // Half a read: forget the file and re-read it from 0 next time — the
      // buffer's dedupe key absorbs the turns this attempt already kept.
      files.delete(file);
      warnOnce(file, err);
    }
  };

  const run = async (fromMs: number, toMs: number): Promise<UserMessage[]> => {
    let list: string[];
    try {
      list = await opts.listFiles(fromMs, toMs);
    } catch (err) {
      console.warn(`${LOG} cannot list ${opts.name} transcripts`, (err as Error)?.message ?? err);
      list = [];
    }
    for (const file of list) {
      await readFile(file, fromMs);
      await yieldToLoop();
    }
    const horizon = fromMs - retainMs;
    const out: UserMessage[] = [];
    for (const [k, m] of buffer) {
      if (m.at < horizon) buffer.delete(k);
      else if (m.at >= fromMs && m.at <= toMs) out.push(m);
    }
    return out.sort((a, b) => a.at - b.at);
  };

  return {
    name: opts.name,
    readMessages(fromMs, toMs) {
      const p = chain.then(() => run(fromMs, toMs));
      chain = p.catch(() => undefined);
      return p;
    },
    __stats() {
      const offsets: Record<string, number> = {};
      for (const [f, s] of files) offsets[f] = s.offset;
      return { offsets, bytesRead, opened, buffered: buffer.size };
    },
  };
}
