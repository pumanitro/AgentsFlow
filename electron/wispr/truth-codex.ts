// Codex sessions as a truth source:
//   <sessionsRoot>/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl
//
// The day directories are the index: a window only ever needs a couple of
// them, so the tree is never walked. A session started late yesterday can still
// be written today, hence one extra day before the window.

import * as fs from 'fs';
import * as path from 'path';
import type { TruthSource, UserMessage } from './types';
import { cleanUserText, createIncrementalTruth, type IncrementalTruth } from './truth-sources';

const DAY_MS = 24 * 60 * 60 * 1000;
// Guard against a degenerate window (fromMs = 0) turning into 20k readdirs.
const MAX_DAYS = 400;
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

interface CodexEntry {
  type?: unknown; timestamp?: unknown;
  payload?: { type?: unknown; role?: unknown; content?: unknown };
}

export function parseCodexLine(line: string, fallbackSessionId: string): UserMessage | null {
  if (!line.includes('"role":"user"')) return null;
  let e: CodexEntry;
  try {
    e = JSON.parse(line) as CodexEntry;
  } catch {
    return null;
  }
  const p = e?.payload;
  if (!e || e.type !== 'response_item' || !p || p.type !== 'message' || p.role !== 'user') return null;
  if (!Array.isArray(p.content)) return null;
  // Codex injects AGENTS.md, environment context and plugin hints as user
  // messages too — all of them open with a <tag>.
  const texts = (p.content as Array<{ type?: unknown; text?: unknown }>)
    .filter((c) => c?.type === 'input_text' && typeof c.text === 'string' && !c.text.trim().startsWith('<'))
    .map((c) => c.text as string);
  const text = cleanUserText(texts.join('\n'));
  if (!text) return null;
  const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  if (Number.isNaN(at)) return null;
  return { at, text, source: 'codex', sessionId: fallbackSessionId };
}

export function codexSessionId(file: string): string {
  const m = UUID_RE.exec(path.basename(file));
  return m ? m[1] : path.basename(file, '.jsonl');
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local-date day dirs covering [day(from) − 1, day(to)]. */
export function codexDayDirs(root: string, fromMs: number, toMs: number): string[] {
  const end = new Date(toMs);
  end.setHours(0, 0, 0, 0);
  const d = new Date(Math.max(fromMs, toMs - MAX_DAYS * DAY_MS));
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  const out: string[] = [];
  // setDate, not += DAY_MS: DST days are 23/25 h long.
  for (; d.getTime() <= end.getTime(); d.setDate(d.getDate() + 1)) {
    out.push(path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
  }
  return out;
}

async function listSessions(root: string, fromMs: number, toMs: number): Promise<string[]> {
  const out: string[] = [];
  for (const dir of codexDayDirs(root, fromMs, toMs)) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // no sessions that day, or no ~/.codex at all
    }
    for (const f of entries) if (f.isFile() && f.name.endsWith('.jsonl')) out.push(path.join(dir, f.name));
  }
  return out;
}

export function createCodexTruth(opts: { sessionsRoot: string; retainMs?: number }): TruthSource & Pick<IncrementalTruth, '__stats'> {
  return createIncrementalTruth({
    name: 'codex',
    retainMs: opts.retainMs,
    listFiles: (from, to) => listSessions(opts.sessionsRoot, from, to),
    parseLine: (line, file) => parseCodexLine(line, codexSessionId(file)),
  });
}
