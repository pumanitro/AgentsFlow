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

function getRepoMeta(cwd: string): RepoMeta {
  const cached = repoCache.get(cwd);
  if (cached && Date.now() - cached.cachedAt < REPO_CACHE_TTL_MS) return cached;
  const probed = probeRepo(cwd);
  const meta: RepoMeta = { isRepo: probed.isRepo, gitDir: probed.gitDir, cachedAt: Date.now() };
  repoCache.set(cwd, meta);
  return meta;
}

export async function gitStatus(cwd: string): Promise<GitStatusResult> {
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

export async function listFiles(cwd: string): Promise<FileEntry[]> {
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

function walkFs(cwd: string, sub = '', acc: FileEntry[] = []): FileEntry[] {
  const here = sub ? path.join(cwd, sub) : cwd;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const rel = sub ? path.join(sub, ent.name) : ent.name;
    if (ent.isDirectory()) walkFs(cwd, rel, acc);
    else acc.push({ path: rel, isIgnored: false });
  }
  return acc;
}
