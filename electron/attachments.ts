import * as fs from 'fs';
import * as path from 'path';
import { Conversation, TrackedDirectory } from '../shared/types';

const ATTACHMENT_FILENAME = /^\d+-[a-z0-9]+\.[a-z0-9]+$/i;
const DATE_FOLDER = /^(\d{4})-(\d{2})-(\d{2})$/;
const LEGACY_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

export function deleteAttachmentFiles(paths: string[] | undefined): void {
  if (!paths || paths.length === 0) return;
  for (const p of paths) {
    if (!p) continue;
    try { fs.unlinkSync(p); } catch {
      // file already gone or unreadable — skip silently
    }
  }
}

export function pastedImagesRoot(userDataDir: string): string {
  return path.join(userDataDir, 'pasted-images');
}

export function todayDateSlug(now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Delete every date-named subfolder under `root` whose date is strictly older
 * than yesterday in local time. Today + yesterday survive. Best-effort.
 */
export function prunePastedImages(root: string, now: Date = new Date()): { deletedFolders: number } {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  let deletedFolders = 0;
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return { deletedFolders: 0 }; }
  for (const name of names) {
    const m = DATE_FOLDER.exec(name);
    if (!m) continue;
    const folderDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (folderDate >= cutoff) continue;
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      deletedFolders++;
    } catch {
      // skip
    }
  }
  return { deletedFolders };
}

/**
 * Legacy cleanup: prior versions wrote pastes into each tracked project's
 * `.agentsflow/images/`. Walk those locations and delete files that:
 *   - have our generated filename shape (timestamp-rand.ext)
 *   - aren't referenced by any conversation
 *   - are older than 24h (guards against in-flight pastes)
 * New pastes no longer land here; this exists only to drain leftovers.
 */
export function sweepOrphanAttachments(dirs: TrackedDirectory[], convs: Conversation[]): { deleted: number } {
  const referenced = new Set<string>();
  for (const c of convs) {
    for (const p of c.attachments ?? []) referenced.add(p);
  }
  let deleted = 0;
  const cutoff = Date.now() - LEGACY_SWEEP_AGE_MS;
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
