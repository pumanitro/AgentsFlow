import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { linkedWorktreeRoot } from './git';

// `linkedWorktreeRoot` decides which chats get attributed to a worktree, and the
// tempting shortcut — "cwd differs from the peer directory" — is wrong: sessions
// routinely run in an ordinary subdirectory, and treating those as worktrees
// fills the field with paths the worktree panel can never match. These cases pin
// the distinction down against a real on-disk layout.

function mkRepo(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsflow-wt-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Main working tree: `.git` is a directory. */
function makeMainTree(root: string): void {
  fs.mkdirSync(path.join(root, '.git', 'worktrees'), { recursive: true });
}

/** Linked worktree: `.git` is a file pointing at the owner's worktrees entry. */
function makeLinkedWorktree(mainRepo: string, wtRoot: string, name: string): void {
  fs.mkdirSync(wtRoot, { recursive: true });
  fs.mkdirSync(path.join(mainRepo, '.git', 'worktrees', name), { recursive: true });
  fs.writeFileSync(
    path.join(wtRoot, '.git'),
    `gitdir: ${path.join(mainRepo, '.git', 'worktrees', name)}\n`,
  );
}

test('linkedWorktreeRoot', async (t) => {
  await t.test('returns null for a main working tree', () => {
    const { dir, cleanup } = mkRepo();
    try {
      makeMainTree(dir);
      assert.equal(linkedWorktreeRoot(dir), null);
    } finally { cleanup(); }
  });

  await t.test('returns null for a subdirectory of a main working tree', () => {
    const { dir, cleanup } = mkRepo();
    try {
      makeMainTree(dir);
      const sub = path.join(dir, 'art', 'prompts');
      fs.mkdirSync(sub, { recursive: true });
      // The regression: this used to be attributed as a worktree purely because
      // it isn't the peer directory itself.
      assert.equal(linkedWorktreeRoot(sub), null);
    } finally { cleanup(); }
  });

  await t.test('resolves a linked worktree to its root and owning repo', () => {
    const { dir, cleanup } = mkRepo();
    try {
      makeMainTree(dir);
      const wt = path.join(dir, '.claude', 'worktrees', 'dashboard-service');
      makeLinkedWorktree(dir, wt, 'dashboard-service');
      assert.deepEqual(linkedWorktreeRoot(wt), { root: wt, mainRepo: dir });
    } finally { cleanup(); }
  });

  await t.test('resolves from inside a linked worktree to the worktree root', () => {
    const { dir, cleanup } = mkRepo();
    try {
      makeMainTree(dir);
      const wt = path.join(dir, '.claude', 'worktrees', 'feature');
      makeLinkedWorktree(dir, wt, 'feature');
      const deep = path.join(wt, 'src', 'components');
      fs.mkdirSync(deep, { recursive: true });
      // A chat that cd'd deeper still belongs to the worktree the panel lists.
      assert.deepEqual(linkedWorktreeRoot(deep), { root: wt, mainRepo: dir });
    } finally { cleanup(); }
  });

  await t.test('resolves a worktree living outside the owning repo', () => {
    const { dir, cleanup } = mkRepo();
    try {
      const main = path.join(dir, 'atlas-of-doors');
      makeMainTree(main);
      // Sibling-path worktrees are ordinary (`git worktree add ../other`).
      const wt = path.join(dir, 'atlas-season-2');
      makeLinkedWorktree(main, wt, 'season-3');
      assert.deepEqual(linkedWorktreeRoot(wt), { root: wt, mainRepo: main });
    } finally { cleanup(); }
  });

  await t.test('returns null for a gitlink that is not a worktree', () => {
    const { dir, cleanup } = mkRepo();
    try {
      makeMainTree(dir);
      // Submodule shape: gitdir points at `modules/<name>`, not `worktrees/<name>`.
      const sub = path.join(dir, 'vendor', 'lib');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${path.join(dir, '.git', 'modules', 'lib')}\n`);
      assert.equal(linkedWorktreeRoot(sub), null);
    } finally { cleanup(); }
  });

  await t.test('returns null outside any repo', () => {
    const { dir, cleanup } = mkRepo();
    try {
      assert.equal(linkedWorktreeRoot(dir), null);
    } finally { cleanup(); }
  });
});
