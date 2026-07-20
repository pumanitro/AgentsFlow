import * as fs from 'fs';
import * as path from 'path';

// Pasted-image files created by the markdown editor's paste handler: the name
// embeds a millisecond timestamp + random slug, so it is unique to the paste
// and safe to treat as "ours". (Same shape as PASTED_NAME in
// renderer/components/BlockNoteMarkdownEditor.tsx — keep the two in sync.)
const PASTED_NAME = /^pasted-\d+-[a-z0-9]+\.[a-z0-9]+$/i;

// Never delete an image younger than this. The editor only writes a file's
// reference into the .md on save/flush, so a freshly pasted image can be
// referenced ONLY by an unsaved editor document for as long as the user keeps
// the note open. 24h comfortably outlasts any realistic editing session.
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

// Bound the per-note-directory walk so a runaway/symlinked tree can't stall
// the main process. Note dirs are tiny (a handful of .md files + images).
const MAX_WALK_ENTRIES = 2000;

interface DirScan {
  mdBodies: string[];
  candidates: string[]; // absolute paths of pasted-named image files
  imagesDirs: string[]; // absolute paths of images/ subdirectories seen
}

function scanNoteDir(dir: string): DirScan {
  const out: DirScan = { mdBodies: [], candidates: [], imagesDirs: [] };
  let budget = MAX_WALK_ENTRIES;
  const walk = (here: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (budget-- <= 0) return;
      const full = path.join(here, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (ent.name === 'images') out.imagesDirs.push(full);
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (ent.name.toLowerCase().endsWith('.md')) {
        try { out.mdBodies.push(fs.readFileSync(full, 'utf8')); } catch {}
      } else if (PASTED_NAME.test(ent.name)) {
        out.candidates.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Delete pasted images in ONE note directory (loose or under images/) that no
 * .md file in that directory references any more. Reference detection is a
 * plain substring check on the unique filename — any markdown link to the
 * image contains it, and the timestamp+slug makes accidental matches
 * practically impossible. Files younger than SWEEP_AGE_MS are kept (they may
 * be referenced only by a not-yet-saved editor document). Empty images/
 * subdirectories are pruned as a courtesy. Best-effort throughout.
 */
export function sweepNoteDir(dir: string, now: number = Date.now()): { deleted: number } {
  const { mdBodies, candidates, imagesDirs } = scanNoteDir(dir);
  let deleted = 0;
  for (const abs of candidates) {
    const name = path.basename(abs);
    if (mdBodies.some((body) => body.includes(name))) continue;
    try {
      const st = fs.statSync(abs);
      if (now - st.mtimeMs < SWEEP_AGE_MS) continue;
      fs.unlinkSync(abs);
      deleted++;
    } catch {
      // already gone or unreadable — skip
    }
  }
  for (const imgDir of imagesDirs) {
    try {
      if (fs.readdirSync(imgDir).length === 0) fs.rmdirSync(imgDir);
    } catch {}
  }
  return { deleted };
}

/**
 * Sweep every note directory under the app's notes root (per-conversation
 * folders plus the reserved __global__ one). Files directly at the root are
 * covered too — the root itself is swept as a directory, but the walk into
 * children already handles nested node dirs, so sweep each child separately
 * to keep the "referenced by a sibling .md" scope PER NOTE FOLDER rather than
 * across the entire tree.
 */
export function sweepNoteImages(notesRoot: string, now: number = Date.now()): { deleted: number } {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(notesRoot, { withFileTypes: true }); } catch { return { deleted: 0 }; }
  let deleted = 0;
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
    deleted += sweepNoteDir(path.join(notesRoot, ent.name), now).deleted;
  }
  return { deleted };
}

/**
 * The note directory a path belongs to, or null when the path is outside the
 * notes tree. Used to trigger a targeted sweep after a file/folder under a
 * note dir is deleted (removing a .md orphans every image only it referenced).
 */
export function noteDirForPath(notesRoot: string, targetPath: string): string | null {
  const rel = path.relative(notesRoot, targetPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0];
  if (!first) return null;
  return path.join(notesRoot, first);
}
