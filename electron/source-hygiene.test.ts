import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

// A debug probe once shipped with a hardcoded path into one Claude job's tmp
// directory (`/Users/<me>/.claude/jobs/<id>/tmp/copy-debug.log`). The moment
// that job was deleted, the write it performed on module load rejected with
// ENOENT, and the unhandled rejection surfaced as a blocking Next.js dev
// overlay the instant a chat with a remembered file opened. Nothing under
// renderer/, electron/ or shared/ may name a path on one developer's machine:
// such a path is a time bomb that only goes off after the author moves on.

// Compiled tests run from dist/electron/electron; the sources are three up.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_ROOTS = ['electron', 'renderer', 'shared'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.next-dev', 'out', 'dist']);
const SOURCE_EXT = new Set(['.ts', '.tsx']);

// `/Users/demo/…` is the fixture home used by the in-browser mock IPC layer —
// a stand-in, not a real machine. Everything else under /Users is somebody's
// real home directory, and `.claude/jobs/` is a per-session scratch dir that
// is deleted when the job ends. Only paths inside a string literal count: a
// comment that illustrates a shape (`// e.g. /Users/x/Desktop/App`) is prose.
const MACHINE_PATH = /["'`][^"'`]*(?:\/Users\/(?!demo\/)[A-Za-z0-9._-]+\/|\.claude\/jobs\/)/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* sourceFiles(abs);
    } else if (SOURCE_EXT.has(path.extname(entry.name)) && !/\.test\.tsx?$/.test(entry.name)) {
      yield abs;
    }
  }
}

describe('source hygiene', () => {
  test('shipped source names no path on one developer machine', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      const dir = path.join(ROOT, root);
      if (!fs.existsSync(dir)) continue;
      for (const file of sourceFiles(dir)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (!COMMENT_LINE.test(line) && MACHINE_PATH.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    assert.deepEqual(offenders, [], `machine-specific paths in shipped source:\n  ${offenders.join('\n  ')}`);
  });

  test('the scan actually covers the renderer and electron sources', () => {
    const seen = new Set<string>();
    for (const root of SCAN_ROOTS) for (const f of sourceFiles(path.join(ROOT, root))) seen.add(path.relative(ROOT, f));
    assert.ok(seen.has('renderer/components/BlockNoteMarkdownEditor.tsx'), 'renderer components are scanned');
    assert.ok(seen.has('electron/main.ts'), 'electron main is scanned');
    assert.ok(!seen.has('electron/source-hygiene.test.ts'), 'tests themselves are excluded');
  });
});
