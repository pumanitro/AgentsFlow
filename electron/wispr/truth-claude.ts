// Claude Code transcripts as a truth source:
//   <projectsRoot>/<munged-cwd>/<sessionId>.jsonl   (see transcript-path.ts)
//
// Most `"type":"user"` lines are NOT the user: tool results come back as user
// turns, and the harness injects system reminders, command wrappers and meta
// turns the same way. Only text blocks a person could have typed survive.

import * as fs from 'fs';
import * as path from 'path';
import type { TruthSource, UserMessage } from './types';
import { cleanUserText, createIncrementalTruth, type IncrementalTruth } from './truth-sources';

interface ClaudeBlock { type?: unknown; text?: unknown }
interface ClaudeEntry {
  type?: unknown; isMeta?: unknown; timestamp?: unknown; sessionId?: unknown;
  isCompactSummary?: unknown; isVisibleInTranscriptOnly?: unknown;
  origin?: { kind?: unknown } | null;
  message?: { content?: unknown };
}

// Cross-session / teammate messages arrive as plain-string user turns. Measured
// 2026-10-23 on 48 h of real transcripts: ~250 of ~450 "user" texts were these.
const PEER_PREFIX = 'Another Claude session sent a message:';

export function parseClaudeLine(line: string, fallbackSessionId: string): UserMessage | null {
  // Fast reject before JSON.parse: the bulk of a transcript is assistant/tool traffic.
  if (!line.includes('"type":"user"')) return null;
  let e: ClaudeEntry;
  try {
    e = JSON.parse(line) as ClaudeEntry;
  } catch {
    return null;
  }
  if (!e || e.type !== 'user' || e.isMeta === true) return null;
  // Compaction summaries ("This session is being continued…") and messages a
  // peer agent typed into this session are user turns nobody dictated.
  if (e.isCompactSummary === true || e.isVisibleInTranscriptOnly === true) return null;
  if (e.origin && typeof e.origin === 'object' && e.origin.kind === 'peer') return null;
  const content = e.message?.content;
  let raw: string;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    const blocks = content as ClaudeBlock[];
    if (blocks.some((b) => b?.type === 'tool_result')) return null;
    raw = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string' && !b.text.trim().startsWith('<'))
      .map((b) => b.text as string)
      .join('\n');
  } else {
    return null;
  }
  if (raw.trimStart().startsWith(PEER_PREFIX)) return null;
  const text = cleanUserText(raw);
  if (!text) return null;
  const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  if (Number.isNaN(at)) return null;
  const sessionId = typeof e.sessionId === 'string' && e.sessionId ? e.sessionId : fallbackSessionId;
  return { at, text, source: 'claude', sessionId };
}

// Exactly two levels: project dir, then transcript. Deeper dirs (subagents/,
// tool-results/) hold agent-to-agent traffic, not the user.
async function listTranscripts(root: string): Promise<string[]> {
  let dirs: fs.Dirent[];
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of entries) if (f.isFile() && f.name.endsWith('.jsonl')) out.push(path.join(dir, f.name));
  }
  return out;
}

export function createClaudeTruth(opts: { projectsRoot: string; retainMs?: number }): TruthSource & Pick<IncrementalTruth, '__stats'> {
  return createIncrementalTruth({
    name: 'claude',
    retainMs: opts.retainMs,
    listFiles: () => listTranscripts(opts.projectsRoot),
    parseLine: (line, file) => parseClaudeLine(line, path.basename(file, '.jsonl')),
  });
}
