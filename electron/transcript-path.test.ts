import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mungeCwd, transcriptPath, transcriptExists } from './transcript-path';

const CWD = '/Users/x/IdeaProjects/atlas-of-doors';
const SID = '7aabaf6e-9462-4841-9bc6-196a64052f98';

let root = '';

function seed(projectDir: string, sessionId: string): void {
  fs.mkdirSync(path.join(root, projectDir), { recursive: true });
  fs.writeFileSync(path.join(root, projectDir, `${sessionId}.jsonl`), '{}\n');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-path-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('mungeCwd', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    assert.equal(mungeCwd(CWD), '-Users-x-IdeaProjects-atlas-of-doors');
  });

  it('munges a worktree path to the parent dir name plus a suffix', () => {
    assert.equal(
      mungeCwd(`${CWD}/.claude/worktrees/ghost-sessions-activation`),
      '-Users-x-IdeaProjects-atlas-of-doors--claude-worktrees-ghost-sessions-activation',
    );
  });
});

describe('transcriptExists', () => {
  it('finds a transcript in the project dir of the given cwd', () => {
    seed(mungeCwd(CWD), SID);
    assert.equal(transcriptExists(root, CWD, SID), true);
  });

  // The 2026-07-25 fork bug: a session that runs EnterWorktree re-homes its
  // transcript under the worktree's project dir and leaves nothing behind, so a
  // direct-path-only check reports "never opened" for a fork that is very much
  // alive — jamming ⑂ on it forever and inviting a re-fork over its own work.
  it('finds a transcript that moved to a worktree project dir', () => {
    seed(`${mungeCwd(CWD)}--claude-worktrees-ghost-sessions-activation`, SID);
    assert.equal(fs.existsSync(transcriptPath(root, CWD, SID)), false);
    assert.equal(transcriptExists(root, CWD, SID), true);
  });

  it('finds a transcript that moved outside this cwd entirely', () => {
    seed('-Users-x-Desktop-somewhere-else', SID);
    assert.equal(transcriptExists(root, CWD, SID), true);
  });

  it('is false when no project dir holds the session id', () => {
    seed(mungeCwd(CWD), 'some-other-session');
    seed(`${mungeCwd(CWD)}--claude-worktrees-lane`, 'yet-another-session');
    assert.equal(transcriptExists(root, CWD, SID), false);
  });

  it('is false — not a throw — when the projects root does not exist', () => {
    assert.equal(transcriptExists(path.join(root, 'nope'), CWD, SID), false);
  });

  it('ignores a same-named dir that only prefixes this cwd', () => {
    // …-atlas-of-doors-old must not answer for …-atlas-of-doors.
    seed(`${mungeCwd(CWD)}-old`, SID);
    // Still found by the full scan (the transcript really is there under some
    // project) — the prefix sort is an ordering hint, never a filter.
    assert.equal(transcriptExists(root, CWD, SID), true);
  });
});
