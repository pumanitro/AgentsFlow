import * as fs from 'fs';
import * as path from 'path';

// Locating a Claude Code session's transcript on disk.
//
// Transcripts live under <projectsRoot>/<munged-cwd>/<sessionId>.jsonl, where
// the cwd is munged by replacing every non-alphanumeric character with '-'
// (e.g. /Users/x/Desktop/App → -Users-x-Desktop-App).

export function mungeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function transcriptPath(root: string, cwd: string, sessionId: string): string {
  return path.join(root, mungeCwd(cwd), `${sessionId}.jsonl`);
}

// Whether a session has materialized a transcript ANYWHERE under `root`, not
// just in the project dir of the cwd it was spawned in.
//
// The cwd→project-dir mapping is not stable for the lifetime of a session: one
// that enters a git worktree (EnterWorktree — which the workflow-style skills do,
// one worktree per lane) re-homes its transcript to the project dir of the
// *worktree* path, leaving nothing behind at the original location. Observed
// 2026-07-25: two forks of /game-council in ~/IdeaProjects/atlas-of-doors wrote
// their transcripts to …-atlas-of-doors--claude-worktrees-{ghost-sessions-
// activation,conclude-title-hook-adcopy}/ instead.
//
// Reading that as "no transcript ⇒ never opened" is badly wrong in both places
// that ask: the ⑂ button jams forever on the same un-openable fork, and the next
// cold attach re-forks from the source over the top of it, discarding everything
// that fork did. So fall back to scanning the whole tree for the session id —
// ~120 dirs in practice, one stat each, and only on the miss path (~10ms).
export function transcriptExists(root: string, cwd: string, sessionId: string): boolean {
  return findTranscript(root, cwd, sessionId) !== null;
}

/** Same search, returning the path — for readers, not just existence checks. */
export function findTranscript(root: string, cwd: string, sessionId: string): string | null {
  const direct = transcriptPath(root, cwd, sessionId);
  if (fs.existsSync(direct)) return direct;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  // A worktree of this cwd munges to `<munged-cwd>--claude-worktrees-<name>`, so
  // that subtree is by far the likeliest home — look there before everywhere else.
  const own = mungeCwd(cwd);
  dirs.sort((a, b) => Number(b.startsWith(own)) - Number(a.startsWith(own)));
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// A session that was backgrounded from an interactive chat (← to the agents
// list, or Ctrl+B) "parks" its conversation in a new background job and ends
// its own transcript with {"type":"continued-in","continuedInSessionId":…}.
// Everything after that point lives in the new session, so resuming the old id
// shows a conversation that stops at "Backgrounding…". The CLI reads the marker
// the same way: scanning back from the end, a continued-in seen before any
// user/assistant message wins.
const TAIL_BYTES = 256 * 1024;

export function continuedIn(file: string): string | null {
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  if (!text.includes('"type":"continued-in"')) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const marker = line.includes('"type":"continued-in"');
    if (!marker && !line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    try {
      const entry = JSON.parse(line);
      if (marker) return typeof entry.continuedInSessionId === 'string' ? entry.continuedInSessionId : null;
      if (entry.type === 'user' || entry.type === 'assistant') return null;
    } catch {
      // The first line of the tail window is usually cut mid-entry.
    }
  }
  return null;
}

/** Follow continued-in markers to the session that holds the latest turns. */
export function latestContinuation(root: string, cwd: string, sessionId: string): string {
  let current = sessionId;
  for (let hop = 0; hop < 5; hop++) {
    const file = findTranscript(root, cwd, current);
    const next = file ? continuedIn(file) : null;
    if (!next || next === current || !findTranscript(root, cwd, next)) break;
    current = next;
  }
  return current;
}
