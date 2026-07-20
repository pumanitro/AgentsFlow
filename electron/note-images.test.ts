import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sweepNoteDir, sweepNoteImages, noteDirForPath } from './note-images';

const DAY = 24 * 60 * 60 * 1000;

let root = '';

function write(rel: string, content: string | Buffer, ageMs = 2 * DAY): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(full, t, t);
  return full;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-images-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sweepNoteDir', () => {
  it('deletes old pasted images that no .md references', () => {
    const orphan = write('node1/pasted-1700000000000-abc123.png', 'x');
    write('node1/notes.md', 'no images here');
    const res = sweepNoteDir(path.join(root, 'node1'));
    assert.equal(res.deleted, 1);
    assert.equal(fs.existsSync(orphan), false);
  });

  it('keeps pasted images referenced by any .md in the same dir', () => {
    const kept = write('node1/pasted-1700000000000-abc123.png', 'x');
    write('node1/notes.md', '![shot](pasted-1700000000000-abc123.png)');
    const res = sweepNoteDir(path.join(root, 'node1'));
    assert.equal(res.deleted, 0);
    assert.equal(fs.existsSync(kept), true);
  });

  it('sweeps inside images/ subdirectories and prunes them when emptied', () => {
    const orphan = write('node1/images/pasted-1700000000000-abc123.png', 'x');
    write('node1/notes.md', 'nothing referenced');
    const res = sweepNoteDir(path.join(root, 'node1'));
    assert.equal(res.deleted, 1);
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(path.join(root, 'node1/images')), false);
  });

  it('keeps a referenced image inside images/ and does not prune its dir', () => {
    const kept = write('node1/images/pasted-1700000000000-abc123.png', 'x');
    write('node1/notes.md', '![shot](images/pasted-1700000000000-abc123.png)');
    sweepNoteDir(path.join(root, 'node1'));
    assert.equal(fs.existsSync(kept), true);
    assert.equal(fs.existsSync(path.join(root, 'node1/images')), true);
  });

  it('never deletes files younger than the age guard (unsaved-editor window)', () => {
    const fresh = write('node1/pasted-1700000000000-abc123.png', 'x', 60 * 1000);
    write('node1/notes.md', 'not referenced');
    const res = sweepNoteDir(path.join(root, 'node1'));
    assert.equal(res.deleted, 0);
    assert.equal(fs.existsSync(fresh), true);
  });

  it('ignores files that do not match the pasted-name pattern', () => {
    const photo = write('node1/vacation.png', 'x');
    write('node1/notes.md', 'not referenced');
    const res = sweepNoteDir(path.join(root, 'node1'));
    assert.equal(res.deleted, 0);
    assert.equal(fs.existsSync(photo), true);
  });

  it('a reference in a SIBLING .md protects the image (shared images dir)', () => {
    const kept = write('node1/images/pasted-1700000000000-abc123.png', 'x');
    write('node1/a.md', 'no refs');
    write('node1/b.md', 'see ![x](images/pasted-1700000000000-abc123.png)');
    const res = sweepNoteDir(path.join(root, 'node1'));
    assert.equal(res.deleted, 0);
    assert.equal(fs.existsSync(kept), true);
  });
});

describe('sweepNoteImages', () => {
  it('sweeps every node dir under the root, scoping references per dir', () => {
    // node1 references its image; node2 has an orphan with the same-shaped name.
    const kept = write('node1/pasted-1700000000000-abc123.png', 'x');
    write('node1/notes.md', '![x](pasted-1700000000000-abc123.png)');
    const orphan = write('node2/pasted-1700000000001-def456.png', 'x');
    write('node2/notes.md', 'nothing');
    const res = sweepNoteImages(root);
    assert.equal(res.deleted, 1);
    assert.equal(fs.existsSync(kept), true);
    assert.equal(fs.existsSync(orphan), false);
  });

  it('returns 0 for a missing root', () => {
    assert.equal(sweepNoteImages(path.join(root, 'nope')).deleted, 0);
  });
});

describe('noteDirForPath', () => {
  it('maps a nested path to its top-level note dir', () => {
    assert.equal(
      noteDirForPath('/data/notes', '/data/notes/abc/images/pasted-1-a.png'),
      '/data/notes/abc',
    );
    assert.equal(noteDirForPath('/data/notes', '/data/notes/abc/file.md'), '/data/notes/abc');
  });

  it('returns null for paths outside the notes root', () => {
    assert.equal(noteDirForPath('/data/notes', '/data/other/file.md'), null);
    assert.equal(noteDirForPath('/data/notes', '/data/notes'), null);
  });
});
