import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { invalidateGitCache, listWorktrees, onWorktreesUpdated, removeWorktree } from './git';

const childProcess: typeof import('node:child_process') = require('node:child_process');
const TTL = Number(process.env.AGENTSFLOW_WORKTREES_TTL_MS) || 15_000;

interface Call {
  args: string[];
  cwd: string;
  finish: (code?: number, stderr?: string) => void;
}

// Exercise the actual cache and command scheduler, with held child processes
// and a controllable clock. No real Git processes or multi-second sleeps.
function fixture(t: TestContext, repoCount = 1, treeCount = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsflow-worktree-cache-'));
  const repos = Array.from({ length: repoCount }, (_, i) => path.join(root, `repo-${i}`));
  const trees = new Map(repos.map((repo) => [repo, Array.from({ length: treeCount }, (_, i) => i === 0 ? repo : `${repo}-tree-${i}`)]));
  for (const paths of trees.values()) {
    for (const dir of paths) fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  }
  let now = 1_800_000_000_000;
  let version = 0;
  let active = 0;
  let peak = 0;
  let hold: (call: Call) => boolean = () => false;
  const calls: Call[] = [];
  const pending = new Set<Call>();
  t.mock.method(Date, 'now', () => now);

  const output = (call: Call): string => {
    const [command, action] = call.args;
    const paths = trees.get(call.cwd) ?? [call.cwd];
    const sha = String(version + 1).padStart(40, '0');
    if (command === 'worktree' && action === 'list') {
      return paths.map((dir, i) => `worktree ${dir}\nHEAD ${sha}\nbranch refs/heads/${i === 0 ? 'main' : `feature-${i}`}\n\n`).join('');
    }
    if (command === 'worktree' && action === 'remove') {
      trees.set(call.cwd, paths.filter((dir) => dir !== call.args.at(-1)));
      return '';
    }
    if (command === 'rev-parse') return `${sha}\n`;
    if (command === 'for-each-ref') return paths.map((_, i) => `${i === 0 ? 'main' : `feature-${i}`} 0 0\n`).join('');
    if (command === 'rev-list') return '0\t0\n';
    if (command === 'status') return `## main\0${Array.from({ length: version }, (_, i) => `?? changed-${i}.ts\0`).join('')}`;
    throw new Error(`Unexpected Git command: ${call.args.join(' ')}`);
  };

  const fakeSpawn = (command: string, args: readonly string[], options: SpawnOptions) => {
    assert.equal(command, 'git');
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const call: Call = {
      args: [...args],
      cwd: String(options.cwd),
      finish(code = 0, stderr = '') {
        if (!pending.delete(call)) return;
        active--;
        child.stdout.end(code === 0 ? output(call) : '');
        child.stderr.end(stderr);
        child.emit('close', code);
      },
    };
    calls.push(call);
    pending.add(call);
    peak = Math.max(peak, ++active);
    if (!hold(call)) queueMicrotask(() => call.finish());
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  t.mock.method(childProcess, 'spawn', fakeSpawn as typeof childProcess.spawn);

  async function drain() {
    for (let i = 0; i < 200; i++) {
      await turn();
      if (!pending.size) return;
      for (const call of [...pending]) call.finish();
    }
    assert.fail('worktree commands did not drain');
  }
  t.after(async () => {
    hold = () => false;
    await drain();
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    repos, trees, calls, pending, drain,
    advance(ms: number) { now += ms; },
    version(n: number) { version = n; },
    hold(fn: (call: Call) => boolean) { hold = fn; },
    get peak() { return peak; },
    listCalls: () => calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'list'),
  };
}

const isList = (call: Call) => call.args[0] === 'worktree' && call.args[1] === 'list';

test('worktrees: a scan outlives the TTL and freshness starts at completion', async (t) => {
  const f = fixture(t);
  const [repo] = f.repos;
  f.hold(isList);
  const first = listWorktrees(repo);
  f.advance(TTL * 4);
  assert.equal(listWorktrees(repo), first);
  assert.equal(f.listCalls().length, 1);
  f.listCalls()[0].finish();
  const rows = await first;

  f.advance(TTL - 1);
  assert.equal(await listWorktrees(repo), rows);
  assert.equal(f.listCalls().length, 1, 'the scan duration must not consume the TTL');
  f.advance(2);
  assert.equal(await listWorktrees(repo), rows, 'expired rows are returned without awaiting the new scan');
  assert.equal(f.listCalls().length, 2);
  f.advance(TTL * 4);
  assert.equal(await listWorktrees(repo), rows);
  assert.equal(f.listCalls().length, 2, 'the background scan must also outlive its TTL');
});

test('worktrees: watcher bursts retain pending scans and mid-scan invalidations survive completion', async (t) => {
  const f = fixture(t);
  const [repo] = f.repos;
  f.hold(isList);
  const main = listWorktrees(repo);
  const release = listWorktrees(repo, 'release');
  for (let i = 0; i < 10; i++) {
    invalidateGitCache(repo);
    assert.equal(listWorktrees(repo), main);
    assert.equal(listWorktrees(repo, 'release'), release);
  }
  assert.equal(f.listCalls().length, 2);
  await f.drain();
  const [mainRows, releaseRows] = await Promise.all([main, release]);
  assert.equal(mainRows[0].refBranch, 'main');
  assert.equal(releaseRows[0].refBranch, 'release');

  // The invalidation arrived after the scan started, so its result cannot be
  // treated as fresh even though the completion timestamp is recent.
  assert.equal(await listWorktrees(repo), mainRows);
  assert.equal(await listWorktrees(repo, 'release'), releaseRows);
  assert.equal(f.listCalls().length, 4);
  invalidateGitCache(repo);
  assert.equal(await listWorktrees(repo), mainRows);
  assert.equal(f.listCalls().length, 4);
});

test('worktrees: a warm invalidation serves old rows and publishes one refreshed result', async (t) => {
  const f = fixture(t);
  const [repo] = f.repos;
  const rows = await listWorktrees(repo);
  const updates: Array<{ cwd: string; ref: string | undefined; changed: number }> = [];
  const off = onWorktreesUpdated((cwd, ref, next) => updates.push({ cwd, ref, changed: next[0].changedCount }));
  t.after(off);
  f.version(1);
  f.hold(isList);
  invalidateGitCache(repo);
  for (let i = 0; i < 10; i++) assert.equal(await listWorktrees(repo), rows);
  assert.equal(f.listCalls().length, 2);
  assert.deepEqual(updates, []);
  await f.drain();
  assert.deepEqual(updates, [{ cwd: repo, ref: undefined, changed: 1 }]);
  const refreshed = await listWorktrees(repo);
  assert.equal(refreshed[0].changedCount, 1);
  assert.equal(f.listCalls().length, 2);
});

test('worktrees: failed cold scans retry and failed background scans preserve cached rows', async (t) => {
  const f = fixture(t);
  const [repo] = f.repos;
  f.hold(isList);
  const first = listWorktrees(repo);
  const rejected = assert.rejects(first, /repository busy/);
  f.listCalls()[0].finish(1, 'repository busy');
  await rejected;
  f.hold(() => false);
  const rows = await listWorktrees(repo);
  assert.equal(rows.length, 2);

  f.advance(TTL + 1);
  f.hold(isList);
  assert.equal(await listWorktrees(repo), rows);
  f.listCalls().at(-1)!.finish(1, 'repository busy');
  await turn();
  assert.equal(await listWorktrees(repo), rows);
  assert.equal(f.listCalls().length, 4, 'a failed refresh releases its entry for retry');
  f.version(1);
  await f.drain();
  assert.equal((await listWorktrees(repo))[0].changedCount, 1);
});

test('worktrees: all repositories and reference branches share four Git command slots', async (t) => {
  const f = fixture(t, 3, 5);
  f.hold(() => true);
  const scans = f.repos.flatMap((repo) => [undefined, 'release', 'preview'].map((ref) => listWorktrees(repo, ref)));
  await turn();
  assert.equal(f.pending.size, 4, 'discovery commands must share the budget too');
  assert.equal(f.calls.length, 4);
  await f.drain();
  const rows = await Promise.all(scans);
  assert.ok(rows.every((r) => r.length === 5));
  assert.equal(f.peak, 4, 'per-worktree status and ref reads must use the same global budget');
  assert.ok(f.calls.some((c) => c.args[0] === 'status'));
  assert.ok(f.calls.some((c) => c.args[0] === 'for-each-ref'));
});

test('worktrees: removing a worktree invalidates cached lists for every reference branch', async (t) => {
  const f = fixture(t);
  const [repo] = f.repos;
  const removed = f.trees.get(repo)![1];
  await Promise.all([listWorktrees(repo), listWorktrees(repo, 'release')]);
  assert.deepEqual(await removeWorktree(repo, removed), { ok: true });
  await Promise.all([listWorktrees(repo), listWorktrees(repo, 'release')]);
  await f.drain();
  for (const ref of [undefined, 'release']) {
    const rows = await listWorktrees(repo, ref);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, repo);
  }
});
