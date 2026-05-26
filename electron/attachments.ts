import * as fs from 'fs';
import * as path from 'path';
import { Conversation, TrackedDirectory } from '../shared/types';

const ATTACHMENT_FILENAME = /^\d+-[a-z0-9]+\.[a-z0-9]+$/i;
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

export function deleteAttachmentFiles(paths: string[] | undefined): void {
  if (!paths || paths.length === 0) return;
  for (const p of paths) {
    if (!p) continue;
    try { fs.unlinkSync(p); } catch {
      // file already gone or unreadable — skip silently
    }
  }
}

/**
 * Walk each tracked directory's .agentsflow/images folder and delete files that:
 *   - have our generated filename shape (timestamp-rand.ext)
 *   - aren't referenced by any conversation
 *   - are older than 24h (guards against in-flight pastes)
 * Best-effort: errors are swallowed.
 */
export function sweepOrphanAttachments(dirs: TrackedDirectory[], convs: Conversation[]): { deleted: number } {
  const referenced = new Set<string>();
  for (const c of convs) {
    for (const p of c.attachments ?? []) referenced.add(p);
  }
  let deleted = 0;
  const cutoff = Date.now() - SWEEP_AGE_MS;
  for (const dir of dirs) {
    const imgDir = path.join(dir.path, '.agentsflow', 'images');
    let names: string[];
    try { names = fs.readdirSync(imgDir); } catch { continue; }
    for (const name of names) {
      if (!ATTACHMENT_FILENAME.test(name)) continue;
      const full = path.join(imgDir, name);
      if (referenced.has(full)) continue;
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > cutoff) continue;
        fs.unlinkSync(full);
        deleted++;
      } catch {
        // skip
      }
    }
    // try to remove empty dirs as a courtesy
    try {
      const remaining = fs.readdirSync(imgDir);
      if (remaining.length === 0) fs.rmdirSync(imgDir);
    } catch {}
    try {
      const parent = path.join(dir.path, '.agentsflow');
      const remaining = fs.readdirSync(parent);
      if (remaining.length === 0) fs.rmdirSync(parent);
    } catch {}
  }
  return { deleted };
}
