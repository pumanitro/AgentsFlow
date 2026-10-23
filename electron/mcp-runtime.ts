/**
 * Stages the standalone MCP server into a directory Claude Code can always read.
 *
 * Every peer-aware session's `--mcp-config` names a script that `claude` reads
 * when it spawns the server. Reading it straight out of the build tree under
 * ~/Desktop fails intermittently with EPERM (a macOS protected folder), which
 * leaves the chat without its peersflow tools. Reads under ~/Library do not, so
 * the server's require closure (MCP_RUNTIME_FILES) is copied into
 * `<stageRoot>/<sha1>/` and the configs point there instead.
 *
 * Same shape as RemoteHosts' bundle: sha1 over the concatenated contents in
 * MCP_RUNTIME_FILES order, `.ok` written last so a half-written copy is never
 * mistaken for a complete one. Imports only node builtins (never `electron`) so
 * it loads under plain node in tests and scripts/pf-runtime-check.mjs.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Relative to bundleRoot, in hash order. The compiled server requires only node builtins + ../locale + ../registry. */
export const MCP_RUNTIME_FILES = ['electron/mcp/agentsflow-mcp-server.js', 'electron/registry.js', 'electron/locale.js'] as const;

export interface McpRuntime {
  hash: string;
  dir: string;
  serverScript: string;
  bundleRoot: string;
  stagedAt: string;
  /** true when this call wrote the hash dir. */
  fresh: boolean;
}

const SERVER_REL = MCP_RUNTIME_FILES[0];
const CURRENT = 'current.json';
const HASH_DIR = /^[0-9a-f]{40}$/;
const TMP_PREFIX = '.tmp-';
const TMP_STALE_MS = 60 * 60 * 1000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function writeAtomic(p: string, content: string): void {
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, p);
}

/**
 * Copies MCP_RUNTIME_FILES from bundleRoot into `${stageRoot}/${sha1}/<rel>`;
 * idempotent; atomic (tmp dir + renameSync, `.ok` written before the rename,
 * `current.json` via tmp + rename); prunes hash dirs beyond `keep` (default 2,
 * newest mtime kept, current never pruned) and `.tmp-*` older than 1 h. Throws
 * when a source file is unreadable or stageRoot unwritable.
 */
export function stageMcpRuntime(opts: { bundleRoot: string; stageRoot: string; keep?: number }): McpRuntime {
  const { bundleRoot, stageRoot } = opts;
  const keep = opts.keep ?? 2;
  const hasher = crypto.createHash('sha1');
  const files: { rel: string; content: Buffer }[] = [];
  for (const rel of MCP_RUNTIME_FILES) {
    let content: Buffer;
    try {
      content = fs.readFileSync(path.join(bundleRoot, rel));
    } catch (err) {
      throw new Error(`cannot read ${rel} from ${bundleRoot}: ${errMsg(err)}`);
    }
    hasher.update(content);
    files.push({ rel, content });
  }
  const hash = hasher.digest('hex');
  const dir = path.join(stageRoot, hash);
  const serverScript = path.join(dir, SERVER_REL);
  fs.mkdirSync(stageRoot, { recursive: true });

  let fresh = false;
  if (!fs.existsSync(path.join(dir, '.ok'))) {
    const tmp = path.join(stageRoot, `${TMP_PREFIX}${hash}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      for (const f of files) {
        const dest = path.join(tmp, f.rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.content, { mode: 0o644 });
      }
      fs.writeFileSync(path.join(tmp, '.ok'), '', { mode: 0o644 });
      // A dir without `.ok` is a leftover from a crash mid-write; replace it.
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      try {
        fs.renameSync(tmp, dir);
        fresh = true;
      } catch (err) {
        // Another process staged the same hash between our check and rename.
        if (!fs.existsSync(path.join(dir, '.ok'))) throw err;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const prev = readCurrentJson(stageRoot);
  let stagedAt: string;
  if (!fresh && prev && prev.hash === hash && prev.dir === dir && typeof prev.stagedAt === 'string') {
    stagedAt = prev.stagedAt;
  } else {
    stagedAt = new Date().toISOString();
    const cur = { version: 1, hash, dir, serverScript, bundleRoot, stagedAt };
    writeAtomic(path.join(stageRoot, CURRENT), JSON.stringify(cur, null, 2));
  }

  prune(stageRoot, hash, keep);
  return { hash, dir, serverScript, bundleRoot, stagedAt, fresh };
}

function readCurrentJson(stageRoot: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stageRoot, CURRENT), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function prune(stageRoot: string, currentHash: string, keep: number): void {
  let names: string[];
  try { names = fs.readdirSync(stageRoot); } catch { return; }
  const now = Date.now();
  const hashDirs: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const p = path.join(stageRoot, name);
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { continue; }
    if (name.startsWith(TMP_PREFIX)) {
      if (now - st.mtimeMs > TMP_STALE_MS) fs.rmSync(p, { recursive: true, force: true });
    } else if (st.isDirectory() && HASH_DIR.test(name)) {
      hashDirs.push({ name, mtimeMs: st.mtimeMs });
    }
  }
  hashDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  hashDirs.forEach((d, i) => {
    if (i < keep || d.name === currentHash) return;
    fs.rmSync(path.join(stageRoot, d.name), { recursive: true, force: true });
  });
}

/** Parses `${stageRoot}/current.json`; null unless its serverScript and `${dir}/.ok` exist. */
export function readCurrentRuntime(stageRoot: string): McpRuntime | null {
  const c = readCurrentJson(stageRoot);
  if (!c) return null;
  const { hash, dir, serverScript, bundleRoot, stagedAt } = c;
  if (typeof hash !== 'string' || typeof dir !== 'string' || typeof serverScript !== 'string') return null;
  if (!fs.existsSync(serverScript) || !fs.existsSync(path.join(dir, '.ok'))) return null;
  return {
    hash,
    dir,
    serverScript,
    bundleRoot: typeof bundleRoot === 'string' ? bundleRoot : '',
    stagedAt: typeof stagedAt === 'string' ? stagedAt : '',
    fresh: false,
  };
}

const RELATIVE_REQUIRE = /require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

/** Transitive relative require("./x"|"../x") closure of a compiled entry file, as bundleRoot-relative paths (.js added). */
export function relativeRequireClosure(bundleRoot: string, entryRel: string): string[] {
  const seen = new Set<string>();
  const queue = [entryRel.split(path.sep).join('/')];
  while (queue.length) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src: string;
    try {
      src = fs.readFileSync(path.join(bundleRoot, rel), 'utf8');
    } catch (err) {
      if (rel === entryRel) throw new Error(`cannot read ${rel} from ${bundleRoot}: ${errMsg(err)}`);
      continue; // listed, so a subset check still catches it
    }
    for (const m of src.matchAll(RELATIVE_REQUIRE)) {
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      if (!path.posix.extname(target)) target += '.js';
      if (!seen.has(target)) queue.push(target);
    }
  }
  return [...seen];
}
