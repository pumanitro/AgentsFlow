// Copying the shipped guards into ~/.claude/hooks/peersflow, and moving the
// hand-made copies they replace out of the way.
//
// The shipped dir may sit inside app.asar, where readFileSync works but
// copyFileSync does not and nothing is executable — so every file is read into
// memory and written out (tmp + rename) with its mode set by extension. A file
// whose bytes already match is left alone, which keeps a second pass silent.
// Superseded hand-made files are renamed aside, never unlinked: the user can
// always get them back. Node builtins only (never `electron`).

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 0644 for docs, 0755 for everything else (scripts, the Python core, the shims). */
export function modeFor(rel: string): number {
  return rel.endsWith('.md') ? 0o644 : 0o755;
}

/**
 * Copies each `rel` from shippedDir to installDir (byte-compare first; tmp +
 * rename; mode by extension; parent dirs created). A file with the right bytes
 * but the wrong mode only gets a chmod and still counts as unchanged. Files in
 * installDir that are not in `rels` are never touched. Throws on an unreadable
 * source or an unwritable destination.
 */
export function syncShippedFiles(shippedDir: string, installDir: string, rels: readonly string[]): { written: string[]; unchanged: string[] } {
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const rel of rels) {
    let content: Buffer;
    try {
      content = fs.readFileSync(path.join(shippedDir, rel));
    } catch (err) {
      throw new Error(`cannot read shipped ${rel} from ${shippedDir}: ${errMsg(err)}`);
    }
    const dest = path.join(installDir, rel);
    const mode = modeFor(rel);
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(dest);
    } catch {
      current = null;
    }
    if (current && current.equals(content)) {
      if ((fs.statSync(dest).mode & 0o777) !== mode) fs.chmodSync(dest, mode);
      unchanged.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, content, { mode });
      fs.chmodSync(tmp, mode); // writeFileSync's mode is masked by the umask
      fs.renameSync(tmp, dest);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw new Error(`cannot write ${dest}: ${errMsg(err)}`);
    }
    written.push(rel);
  }
  return { written, unchanged };
}

/**
 * Renames `<handmadeHooksDir>/<name>` to `<supersededDir>/<name>.<nowMs>` for
 * each name that exists. Skips missing names, and — when `skipLinksInto` is
 * given — a symlink whose target resolves inside that dir (a user who already
 * pointed the old name at the installed copy keeps the link). NEVER unlinks.
 */
export function supersedeHandmade(handmadeHooksDir: string, supersededDir: string, names: readonly string[], nowMs: number, skipLinksInto?: string): { from: string; to: string }[] {
  const moved: { from: string; to: string }[] = [];
  let skipRoot: string | null = null;
  if (skipLinksInto) {
    try { skipRoot = fs.realpathSync(skipLinksInto); } catch { skipRoot = path.resolve(skipLinksInto); }
  }
  for (const name of names) {
    const from = path.join(handmadeHooksDir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(from);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() && skipRoot) {
      let target: string;
      try { target = fs.realpathSync(from); } catch { target = path.resolve(handmadeHooksDir, fs.readlinkSync(from)); }
      if (target === skipRoot || target.startsWith(skipRoot + path.sep)) continue;
    }
    fs.mkdirSync(supersededDir, { recursive: true });
    const to = path.join(supersededDir, `${name}.${nowMs}`);
    fs.renameSync(from, to);
    moved.push({ from, to });
  }
  return moved;
}
