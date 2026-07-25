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
  if (fs.existsSync(transcriptPath(root, cwd, sessionId))) return true;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return false;
  }
  // A worktree of this cwd munges to `<munged-cwd>--claude-worktrees-<name>`, so
  // that subtree is by far the likeliest home — look there before everywhere else.
  const own = mungeCwd(cwd);
  dirs.sort((a, b) => Number(b.startsWith(own)) - Number(a.startsWith(own)));
  return dirs.some((d) => fs.existsSync(path.join(root, d, `${sessionId}.jsonl`)));
}
