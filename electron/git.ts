import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type GitEntryStatus = 'untracked' | 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';

// Per-directory cache of repo identity + branch. These don't change between
// status calls unless the user runs `git init` / `git checkout`, which the
// file-watcher signals via invalidateGitCache(). 60 s fallback TTL covers the
// no-watcher case (network mounts where watcher events may be dropped).
interface RepoMeta { isRepo: boolean; gitDir: string | null; branch?: string; cachedAt: number }
const repoCache = new Map<string, RepoMeta>();
const REPO_CACHE_TTL_MS = 60_000;

export function invalidateGitCache(cwd: string): void {
  repoCache.delete(cwd);
  // The worktree cache is keyed on (dir, reference branch), so a single dir can
  // hold several entries — drop every one of them, not just the default-ref key.
  // `_publishCache` deliberately needs no invalidation: it is keyed on the two
  // commit shas it describes, so a moved ref simply produces a different key.
  const prefix = `${cwd}\u0000`;
  for (const key of _worktreesCache.keys()) {
    if (key.startsWith(prefix)) _worktreesCache.delete(key);
  }
}

export interface GitEntry {
  path: string;          // relative to repo cwd
  status: GitEntryStatus;
  staged: boolean;       // X column from porcelain
  unstaged: boolean;     // Y column from porcelain
  oldPath?: string;      // for renames
}

export interface GitStatusResult {
  isRepo: boolean;
  branch?: string;
  entries: GitEntry[];
}

function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    env.NO_COLOR = '1';
    env.GIT_OPTIONAL_LOCKS = '0';
    delete env.FORCE_COLOR;
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const o: Buffer[] = [];
    const e: Buffer[] = [];
    child.stdout!.on('data', (b: Buffer) => o.push(b));
    child.stderr!.on('data', (b: Buffer) => e.push(b));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(o).toString('utf8'), stderr: Buffer.concat(e).toString('utf8') }));
    child.on('error', () => resolve({ code: -1, stdout: '', stderr: '' }));
  });
}

function classify(xy: string): GitEntryStatus {
  if (xy === '??') return 'untracked';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('A')) return 'added';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('M')) return 'modified';
  return 'unknown';
}

/**
 * Cheap synchronous probe: is `cwd` inside a git work tree, and where is the
 * git dir? Avoids the cost of spawning `git rev-parse --is-inside-work-tree`
 * on every refresh by walking up the tree once and caching the result.
 */
function probeRepo(cwd: string): { isRepo: boolean; gitDir: string | null } {
  let dir = cwd;
  // Walk up at most 64 levels — well beyond any realistic project nesting.
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(dir, '.git');
    try {
      const st = fs.statSync(candidate);
      if (st.isDirectory()) return { isRepo: true, gitDir: candidate };
      // .git can be a regular file pointing at the real git dir (worktrees, submodules).
      if (st.isFile()) {
        try {
          const txt = fs.readFileSync(candidate, 'utf8').trim();
          const m = txt.match(/^gitdir:\s*(.+)$/);
          if (m) {
            const resolved = path.isAbsolute(m[1]) ? m[1] : path.join(dir, m[1]);
            return { isRepo: true, gitDir: resolved };
          }
        } catch { /* ignore */ }
      }
    } catch { /* not found at this level */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { isRepo: false, gitDir: null };
}

/**
 * The root of the *linked worktree* `cwd` sits inside, plus the main repo that
 * owns it — or null if `cwd` belongs to an ordinary working tree (or no repo).
 *
 * Distinguishing the two is what makes "which worktree is this chat in?"
 * answerable without spawning git: a linked worktree's `.git` is a FILE holding
 * `gitdir: <main>/.git/worktrees/<name>`, while a main working tree's `.git` is
 * a DIRECTORY. Walking up from `cwd` and stopping at whichever comes first also
 * handles a session sitting in a *subdirectory* — of a worktree (→ attributes
 * the worktree root, which is what the UI matches on) or of the main tree
 * (→ null, rather than mistaking the subdirectory itself for a worktree).
 *
 * `gitdir` pointing anywhere other than a `worktrees/<name>` entry means a
 * submodule or a plain gitlink, which is not a worktree — hence null.
 */
export function linkedWorktreeRoot(cwd: string): { root: string; mainRepo: string } | null {
  let dir = cwd;
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(dir, '.git');
    try {
      const st = fs.statSync(candidate);
      // Main working tree — reached before any worktree marker, so `cwd` is not
      // in a linked worktree.
      if (st.isDirectory()) return null;
      if (st.isFile()) {
        const txt = fs.readFileSync(candidate, 'utf8').trim();
        const m = txt.match(/^gitdir:\s*(.+)$/);
        if (!m) return null;
        const gitDir = path.isAbsolute(m[1]) ? m[1] : path.join(dir, m[1]);
        // <mainRepo>/.git/worktrees/<name>  →  strip three segments for the repo.
        const parts = gitDir.split(path.sep);
        const wtIdx = parts.lastIndexOf('worktrees');
        if (wtIdx < 2 || parts[wtIdx - 1] !== '.git' || wtIdx !== parts.length - 2) return null;
        return { root: dir, mainRepo: parts.slice(0, wtIdx - 1).join(path.sep) };
      }
    } catch { /* no .git at this level — keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function getRepoMeta(cwd: string): RepoMeta {
  const cached = repoCache.get(cwd);
  if (cached && Date.now() - cached.cachedAt < REPO_CACHE_TTL_MS) return cached;
  const probed = probeRepo(cwd);
  const meta: RepoMeta = { isRepo: probed.isRepo, gitDir: probed.gitDir, cachedAt: Date.now() };
  repoCache.set(cwd, meta);
  return meta;
}

// Coalesce concurrent identical requests per directory. The file tree fires its
// `refresh()` on mount, on every file-watcher event, and on a heartbeat — bursts
// that used to launch several identical child processes for the same directory
// at the same instant (observed: 3 concurrent `git status` spawns on one peer,
// each ~1s under the resulting contention). Sharing the in-flight promise per
// cwd collapses each burst to a single spawn; the entry is deleted the moment it
// settles, so a later call always re-runs and results are never stale.
const _statusInFlight = new Map<string, Promise<GitStatusResult>>();
const _listInFlight = new Map<string, Promise<FileEntry[]>>();

export function gitStatus(cwd: string): Promise<GitStatusResult> {
  const existing = _statusInFlight.get(cwd);
  if (existing) return existing;
  const p = gitStatusImpl(cwd).finally(() => { _statusInFlight.delete(cwd); });
  _statusInFlight.set(cwd, p);
  return p;
}

async function gitStatusImpl(cwd: string): Promise<GitStatusResult> {
  try { fs.accessSync(cwd); } catch { return { isRepo: false, entries: [] }; }
  const meta = getRepoMeta(cwd);
  if (!meta.isRepo) return { isRepo: false, entries: [] };

  // Single call: porcelain=v1 -z --branch gives the branch as a `## <name>`
  // record before the file entries, so we get branch + status in one spawn
  // instead of `rev-parse --abbrev-ref HEAD` + `status` separately.
  const statusRes = await runGit(
    ['status', '--porcelain=v1', '--untracked-files=all', '--branch', '-z'],
    cwd,
  );
  if (statusRes.code !== 0) return { isRepo: true, branch: meta.branch, entries: [] };

  const { branch, entries } = parsePorcelainV1Z(statusRes.stdout);
  if (branch && branch !== meta.branch) {
    repoCache.set(cwd, { ...meta, branch, cachedAt: meta.cachedAt });
  }
  return { isRepo: true, branch: branch ?? meta.branch, entries };
}

/**
 * Parse `git status --porcelain=v1 -z --branch` output. With `-z`, records are
 * NUL-separated and the branch header is the first record (`## <branch>` or
 * `## HEAD (no branch)` when detached). Renamed entries are followed by the
 * old-path as a separate NUL-terminated record.
 */
export function parsePorcelainV1Z(buf: string): { branch?: string; entries: GitEntry[] } {
  const entries: GitEntry[] = [];
  let branch: string | undefined;
  let i = 0;
  // Branch header (if present) is the first record.
  if (buf.startsWith('## ')) {
    const end = buf.indexOf('\0');
    const header = end === -1 ? buf.slice(3) : buf.slice(3, end);
    // header forms we care about:
    //   "main"
    //   "main...origin/main"
    //   "main...origin/main [ahead 1]"
    //   "HEAD (no branch)"
    if (header.startsWith('HEAD (no branch)')) {
      branch = 'HEAD';
    } else {
      const dotIdx = header.indexOf('...');
      const spaceIdx = header.indexOf(' ');
      let cut = header.length;
      if (dotIdx >= 0) cut = Math.min(cut, dotIdx);
      if (spaceIdx >= 0) cut = Math.min(cut, spaceIdx);
      branch = header.slice(0, cut);
    }
    i = (end === -1 ? buf.length : end + 1);
  }
  while (i < buf.length) {
    const xy = buf.slice(i, i + 2);
    // skip past "XY "
    i += 3;
    let pathEnd = buf.indexOf('\0', i);
    if (pathEnd === -1) pathEnd = buf.length;
    const filePath = buf.slice(i, pathEnd);
    i = pathEnd + 1;
    let oldPath: string | undefined;
    if (xy.includes('R')) {
      let oldEnd = buf.indexOf('\0', i);
      if (oldEnd === -1) oldEnd = buf.length;
      oldPath = buf.slice(i, oldEnd);
      i = oldEnd + 1;
    }
    if (!filePath) continue;
    entries.push({
      path: filePath,
      status: classify(xy),
      staged: xy[0] !== ' ' && xy[0] !== '?',
      unstaged: xy[1] !== ' ' && xy[1] !== '?',
      oldPath,
    });
  }
  return { branch, entries };
}

export interface FileEntry {
  path: string;          // relative
  isIgnored: boolean;
}

export function listFiles(cwd: string): Promise<FileEntry[]> {
  const existing = _listInFlight.get(cwd);
  if (existing) return existing;
  const p = listFilesImpl(cwd).finally(() => { _listInFlight.delete(cwd); });
  _listInFlight.set(cwd, p);
  return p;
}

async function listFilesImpl(cwd: string): Promise<FileEntry[]> {
  try { fs.accessSync(cwd); } catch { return []; }
  // Skip the git probes entirely if we already know it's not a repo.
  if (!getRepoMeta(cwd).isRepo) return walkFs(cwd);

  // Tracked + untracked-but-not-ignored
  const a = await runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd);
  // Also tracked + ignored (with --ignored we get extra list) — we use a separate call so we can mark them.
  const ignoredRes = await runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], cwd);

  const nonIgnored = parseZ(a.stdout);
  const ignored = new Set(parseZ(ignoredRes.stdout));

  if (a.code !== 0) {
    // Fall back to plain fs scan if not a git repo (shouldn't happen — getRepoMeta said it was)
    return walkFs(cwd);
  }

  const out: FileEntry[] = [];
  for (const p of nonIgnored) out.push({ path: p, isIgnored: false });
  for (const p of ignored) out.push({ path: p, isIgnored: true });
  return out;
}

function parseZ(s: string): string[] {
  if (!s) return [];
  return s.split('\0').filter(Boolean);
}

// Non-git directories fall back to this filesystem walk. It is bounded — by depth
// and total entries — and skips heavy build/dependency dirs, so a huge non-repo
// folder (e.g. ~/Desktop) can't block the main thread for hundreds of ms on every
// `files:list`. (Git repos never reach here; they use `git ls-files`.)
const WALK_MAX_ENTRIES = 5000;
const WALK_MAX_DEPTH = 6;
const WALK_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', '.cache', '.turbo',
  '__pycache__', '.venv', 'venv', '.gradle', '.idea', 'DerivedData',
]);
function walkFs(cwd: string, sub = '', acc: FileEntry[] = [], depth = 0): FileEntry[] {
  if (acc.length >= WALK_MAX_ENTRIES || depth > WALK_MAX_DEPTH) return acc;
  const here = sub ? path.join(cwd, sub) : cwd;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    if (acc.length >= WALK_MAX_ENTRIES) break;
    if (WALK_SKIP_DIRS.has(ent.name)) continue;
    const rel = sub ? path.join(sub, ent.name) : ent.name;
    if (ent.isDirectory()) walkFs(cwd, rel, acc, depth + 1);
    else acc.push({ path: rel, isIgnored: false });
  }
  return acc;
}

// ---- Git worktrees ---------------------------------------------------------

export interface WorktreeInfo {
  path: string;          // absolute worktree directory
  branch: string;        // short branch name, or 'HEAD' when detached
  head: string;          // short HEAD sha
  isMain: boolean;       // the repo's primary working tree
  isCurrent: boolean;    // realpath === the requested dir
  changedCount: number;  // uncommitted (working-tree) file count
  dirty: boolean;        // changedCount > 0
  // --- publish state, measured against `refBranch` ------------------------
  // The branch every row was compared against, '' when none could be resolved
  // (a detached primary working tree with no pinned reference).
  refBranch: string;
  ahead: number;         // raw commits here that the ref does not have
  behind: number;        // commits on the ref that are not here
  unpublished: number;   // `ahead` minus commits that already landed reworded/rebased
  published: boolean;    // everything on this branch is in the ref
}

interface RawWorktree { path: string; head: string; branch?: string; detached: boolean; bare: boolean }

function parseWorktreePorcelain(out: string): RawWorktree[] {
  const list: RawWorktree[] = [];
  let cur: Partial<RawWorktree> | null = null;
  const flush = () => {
    if (cur && cur.path) {
      list.push({ path: cur.path, head: cur.head ?? '', branch: cur.branch, detached: !!cur.detached, bare: !!cur.bare });
    }
    cur = null;
  };
  for (const line of out.split('\n')) {
    if (line === '') { flush(); continue; }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') { flush(); cur = { path: val }; }
    else if (!cur) { continue; }
    else if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
  }
  flush();
  return list;
}

function realpathOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * How many worktrees are scanned at once.
 *
 * Deliberately NOT `Promise.all` over every worktree. Wall-clock is flat across
 * limits (a 20-worktree repo measured 2332ms unbounded vs 1913ms at 4 — inside
 * the noise), but the *event-loop* cost is not: spawning twenty gits at once
 * stalled the main process for p95 1792ms, against 149ms at a limit of 4. That
 * loop is what carries PTY output to the chat pane, so an unbounded fan-out
 * shows up as the terminal freezing for a second whenever the sidebar refreshes.
 * Raising this back to "all of them" buys no speed and costs exactly that.
 */
const WORKTREE_SCAN_CONCURRENCY = 4;

/** `Promise.all`-alike that keeps at most `limit` tasks in flight, preserving order. */
async function mapPooled<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

interface PublishState { ahead: number; behind: number; unpublished: number; published: boolean }

// Publish state is a pure function of two immutable object ids (the ref's sha
// and the branch's sha), so unlike the worktree list it can be memoised
// forever instead of on a TTL — if neither sha moved, the answer cannot have
// changed. That matters because the accurate answer costs up to two extra git
// spawns per unpublished worktree, and the Changes sidebar refetches on every
// file-watcher burst.
const _publishCache = new Map<string, PublishState>();
const PUBLISH_CACHE_MAX = 500;

/**
 * Ahead/behind for every local branch in ONE spawn, via for-each-ref's
 * `%(ahead-behind:)` (git 2.41+). The per-branch `rev-list` this replaces cost
 * roughly 9x as much on a 20-worktree repo — 725ms across 28 spawns versus
 * 80ms in one. Returns null on older git, where the token is not interpolated,
 * so the caller transparently falls back to per-branch rev-list.
 */
async function batchAheadBehind(
  cwd: string,
  ref: string,
): Promise<Map<string, { ahead: number; behind: number }> | null> {
  const r = await runGit(
    ['for-each-ref', `--format=%(refname:short) %(ahead-behind:${ref})`, 'refs/heads/'],
    cwd,
  );
  if (r.code !== 0) return null;
  const map = new Map<string, { ahead: number; behind: number }>();
  for (const line of r.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const ahead = parseInt(parts[1], 10);
    const behind = parseInt(parts[2], 10);
    if (Number.isNaN(ahead) || Number.isNaN(behind)) return null; // git too old
    map.set(parts[0], { ahead, behind });
  }
  return map.size > 0 ? map : null;
}

async function publishState(
  cwd: string,
  ref: string,
  refSha: string,
  rev: string,
  revSha: string,
  known?: { ahead: number; behind: number },
): Promise<PublishState> {
  const key = `${refSha}\u0000${revSha}`;
  const hit = _publishCache.get(key);
  if (hit) return hit;

  let out: PublishState = { ahead: 0, behind: 0, unpublished: 0, published: true };
  // `known` is this branch's row from the batched for-each-ref pass. Only
  // detached worktrees, which have no branch ref to batch over, still pay for
  // an individual rev-list here.
  const counts = known
    ? { code: 0, stdout: `${known.behind}\t${known.ahead}` }
    : await runGit(['rev-list', '--left-right', '--count', `${ref}...${rev}`], cwd);
  if (counts.code === 0) {
    const [behind, ahead] = counts.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
    out = { ahead, behind, unpublished: ahead, published: ahead === 0 };

    if (ahead > 0) {
      // `ahead` overcounts what is actually left to ship. A commit that reached
      // the ref by cherry-pick or rebase carries a new sha but the same patch,
      // so a plain rev-list still calls it "not in the ref". `git cherry`
      // compares patch-ids and marks those already present with '-'.
      const cherry = await runGit(['cherry', ref, rev], cwd);
      if (cherry.code === 0) {
        const unpublished = cherry.stdout.split('\n').filter((l) => l.startsWith('+')).length;
        out = { ...out, unpublished, published: unpublished === 0 };
      }
      if (!out.published) {
        // Last check: a branch whose commits net out to no change at all (work
        // that was later reverted, say) has nothing left to ship even though
        // `cherry` still counts those commits.
        //
        // NOTE this is deliberately narrow, and in particular does NOT detect
        // squash-merges: `ref...rev` diffs the merge-base against rev, so it
        // stays non-empty after a squash even though the content did land.
        // Detecting that reliably needs per-file tree comparison (merge-tree
        // reports conflicts on rebased branches, so it is not a substitute).
        // The consequence is conservative — a squash-merged branch reads as
        // unpublished, never the reverse.
        const diff = await runGit(['diff', '--quiet', `${ref}...${rev}`], cwd);
        if (diff.code === 0) out = { ...out, unpublished: 0, published: true };
      }
    }
  }

  // Whole-map eviction rather than LRU bookkeeping: entries are tiny and a repo
  // only ever has a handful of live (ref, branch) pairs, so the cap is a leak
  // guard for long sessions, not a hot path.
  if (_publishCache.size >= PUBLISH_CACHE_MAX) _publishCache.clear();
  _publishCache.set(key, out);
  return out;
}

export interface BranchList {
  local: string[];   // e.g. 'v3.1.0'
  remote: string[];  // e.g. 'origin/v3.1.0'
}

/**
 * Branches for the reference picker, most-recently-committed first, split by
 * kind. Remotes are deliberately NOT deduplicated against locals: `v3.1.0` and
 * `origin/v3.1.0` answer different questions ("is it merged?" vs "is it
 * pushed?"), and a release branch is exactly where those two diverge.
 */
export async function listBranches(cwd: string): Promise<BranchList> {
  const empty: BranchList = { local: [], remote: [] };
  try { fs.accessSync(cwd); } catch { return empty; }
  if (!getRepoMeta(cwd).isRepo) return empty;
  const r = await runGit(
    ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/', 'refs/remotes/'],
    cwd,
  );
  if (r.code !== 0) return empty;
  const all = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const local = new Set<string>();
  const remote: string[] = [];
  const localRes = await runGit(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
    cwd,
  );
  if (localRes.code === 0) {
    for (const b of localRes.stdout.split('\n').map((s) => s.trim())) if (b) local.add(b);
  }
  const localOrdered: string[] = [];
  for (const b of all) {
    if (local.has(b)) localOrdered.push(b);
    // `origin/HEAD` is a symbolic pointer at the default branch, not a branch
    // anyone means to compare against — it would just duplicate origin/main.
    else if (!/\/HEAD$/.test(b)) remote.push(b);
  }
  return { local: localOrdered, remote };
}

// ~2 s TTL + in-flight coalescing keyed on the requested dir *and* the
// reference branch. The Changes sidebar refetches on every file-watcher burst;
// without this a repo with several worktrees would fan a burst out into
// (worktrees × git) spawns. The file-watcher clears this alongside the
// repo-meta cache on ref/index changes.
interface WorktreesCacheEntry { at: number; promise: Promise<WorktreeInfo[]> }
const _worktreesCache = new Map<string, WorktreesCacheEntry>();
const WORKTREES_TTL_MS = 2_000;

export function listWorktrees(cwd: string, refBranch?: string): Promise<WorktreeInfo[]> {
  const key = `${cwd}\u0000${refBranch ?? ''}`;
  const cached = _worktreesCache.get(key);
  if (cached && Date.now() - cached.at < WORKTREES_TTL_MS) return cached.promise;
  const promise = listWorktreesImpl(cwd, refBranch).catch((err) => {
    // On failure don't poison the cache — let the next call retry.
    _worktreesCache.delete(key);
    throw err;
  });
  _worktreesCache.set(key, { at: Date.now(), promise });
  return promise;
}

async function listWorktreesImpl(cwd: string, refBranch?: string): Promise<WorktreeInfo[]> {
  try { fs.accessSync(cwd); } catch { return []; }
  if (!getRepoMeta(cwd).isRepo) return [];

  const res = await runGit(['worktree', 'list', '--porcelain'], cwd);
  if (res.code !== 0) return [];
  const raws = parseWorktreePorcelain(res.stdout).filter((w) => !w.bare);
  if (raws.length === 0) return [];

  // The branch every row is measured against. It defaults to the primary
  // working tree's branch — which is what this used to compare against
  // implicitly, under the name "main" — but the user can pin an explicit one,
  // e.g. a release branch, to see what has and hasn't landed in it. A pinned
  // branch that has since been deleted falls back to the default rather than
  // silently reporting everything as unpublished.
  const primary = raws[0];
  let ref = primary.branch;
  if (refBranch) {
    // `^{commit}` resolves any ref kind — local branch, remote-tracking branch
    // (origin/v3.1.0) or tag — so the picker is not limited to local heads.
    // A ref that no longer resolves leaves `ref` at the repo default rather
    // than reporting every worktree as unpublished against nothing.
    const ok = await runGit(['rev-parse', '--verify', '--quiet', `${refBranch}^{commit}`], cwd);
    if (ok.code === 0) ref = refBranch;
  }
  const refShaRes = ref ? await runGit(['rev-parse', ref], cwd) : null;
  const refSha = refShaRes && refShaRes.code === 0 ? refShaRes.stdout.trim() : '';
  const realCwd = realpathOrSelf(cwd);

  // One spawn covers ahead/behind for every branch, so the per-worktree work
  // below is left with just its `git status` (plus a `cherry` for the few trees
  // that actually have unpublished commits).
  const aheadBehind = ref && refSha ? await batchAheadBehind(cwd, ref) : null;

  const out = await mapPooled(raws, WORKTREE_SCAN_CONCURRENCY, async (w, idx): Promise<WorktreeInfo> => {
    const status = await gitStatus(w.path);
    const changedCount = status.entries.length;

    // Every tree is compared uniformly, the primary one included — when it sits
    // on the reference itself that trivially yields 0/0/published, but when the
    // reference is a release branch "is main itself in it?" is a real question.
    let ps: PublishState = { ahead: 0, behind: 0, unpublished: 0, published: false };
    if (ref && refSha) {
      const known = w.branch ? aheadBehind?.get(w.branch) : undefined;
      ps = await publishState(cwd, ref, refSha, w.branch ?? w.head, w.head, known);
    }

    return {
      path: w.path,
      branch: w.branch ?? (w.detached ? 'HEAD' : ''),
      head: w.head.slice(0, 8),
      isMain: idx === 0,
      isCurrent: realpathOrSelf(w.path) === realCwd,
      changedCount,
      dirty: changedCount > 0,
      refBranch: ref ?? '',
      ahead: ps.ahead,
      behind: ps.behind,
      unpublished: ps.unpublished,
      published: ps.published,
    };
  });

  return out;
}

export async function removeWorktree(
  repoDir: string,
  worktreePath: string,
  force = false,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Never let the primary working tree be removed out from under a peer.
  try {
    const raws = parseWorktreePorcelain((await runGit(['worktree', 'list', '--porcelain'], repoDir)).stdout).filter((w) => !w.bare);
    const target = realpathOrSelf(worktreePath);
    if (raws.length > 0 && realpathOrSelf(raws[0].path) === target) {
      return { ok: false, error: 'Refusing to remove the primary working tree.' };
    }
    if (realpathOrSelf(repoDir) === target) {
      return { ok: false, error: 'Refusing to remove the currently open worktree.' };
    }
  } catch { /* fall through to git, which has its own guards */ }

  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  const res = await runGit(args, repoDir);
  if (res.code === 0) {
    _worktreesCache.delete(repoDir);
    return { ok: true };
  }
  const error = (res.stderr || res.stdout || 'git worktree remove failed').trim();
  return { ok: false, error };
}
