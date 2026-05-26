import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type GitEntryStatus = 'untracked' | 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';

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

export async function gitStatus(cwd: string): Promise<GitStatusResult> {
  try { fs.accessSync(cwd); } catch { return { isRepo: false, entries: [] }; }
  const check = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (check.code !== 0 || check.stdout.trim() !== 'true') {
    return { isRepo: false, entries: [] };
  }
  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : undefined;
  const statusRes = await runGit(['status', '--porcelain=v1', '--untracked-files=all', '-z'], cwd);
  if (statusRes.code !== 0) return { isRepo: true, branch, entries: [] };

  const entries: GitEntry[] = [];
  const buf = statusRes.stdout;
  let i = 0;
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
  return { isRepo: true, branch, entries };
}

export interface FileEntry {
  path: string;          // relative
  isIgnored: boolean;
}

export async function listFiles(cwd: string): Promise<FileEntry[]> {
  try { fs.accessSync(cwd); } catch { return []; }
  // Tracked + untracked-but-not-ignored
  const a = await runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd);
  // Also tracked + ignored (with --ignored we get extra list) — we use a separate call so we can mark them.
  const ignoredRes = await runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], cwd);

  const nonIgnored = parseZ(a.stdout);
  const ignored = new Set(parseZ(ignoredRes.stdout));

  if (a.code !== 0) {
    // Fall back to plain fs scan if not a git repo
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
