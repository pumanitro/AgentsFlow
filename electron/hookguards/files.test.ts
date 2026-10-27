// Copying shipped guards (idempotence, modes, nested dirs, extra files left
// alone) and moving superseded hand-made files aside (timestamped, never
// unlinked, missing names and links into the install dir skipped).

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { supersedeHandmade, syncShippedFiles } from './files';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

const RELS = ['README.md', 'lib/killcheck.py', 'bin/pkill', 'guard.sh'];

describe('syncShippedFiles', () => {
  test('first sync writes all (nested dirs created, modes by extension); second writes nothing', () => {
    const shipped = tmp('hg-shipped-');
    const install = path.join(tmp('hg-install-'), 'peersflow');
    for (const r of RELS) write(shipped, r, `# ${r}\n`);
    const a = syncShippedFiles(shipped, install, RELS);
    assert.deepEqual(a.written, RELS);
    assert.equal(fs.statSync(path.join(install, 'README.md')).mode & 0o777, 0o644);
    for (const r of RELS.slice(1)) assert.equal(fs.statSync(path.join(install, r)).mode & 0o777, 0o755, r);
    const b = syncShippedFiles(shipped, install, RELS);
    assert.deepEqual(b.written, []);
    assert.deepEqual(b.unchanged, RELS);
  });

  test('a changed source is rewritten, a wrong mode is fixed without a write, extra files are untouched', () => {
    const shipped = tmp('hg-shipped-');
    const install = tmp('hg-install-');
    for (const r of RELS) write(shipped, r, `# ${r}\n`);
    syncShippedFiles(shipped, install, RELS);
    write(install, '__pycache__/x.pyc', 'cache');
    write(shipped, 'guard.sh', '# new\n');
    fs.chmodSync(path.join(install, 'bin/pkill'), 0o600);
    const r = syncShippedFiles(shipped, install, RELS);
    assert.deepEqual(r.written, ['guard.sh']);
    assert.equal(fs.readFileSync(path.join(install, 'guard.sh'), 'utf8'), '# new\n');
    assert.equal(fs.statSync(path.join(install, 'bin/pkill')).mode & 0o777, 0o755);
    assert.equal(fs.readFileSync(path.join(install, '__pycache__/x.pyc'), 'utf8'), 'cache');
    assert.ok(!fs.readdirSync(install).some((f) => f.endsWith('.tmp')));
  });

  test('throws on a missing source', () => {
    const shipped = tmp('hg-shipped-');
    assert.throws(() => syncShippedFiles(shipped, tmp('hg-install-'), ['nope.sh']), /cannot read shipped nope\.sh/);
  });
});

describe('supersedeHandmade', () => {
  test('moves with a timestamp, never unlinks, skips missing', () => {
    const hooks = tmp('hg-hooks-');
    const sup = path.join(tmp('hg-sup-'), 'peersflow-superseded');
    write(hooks, 'block-mass-kill.py', 'old');
    write(hooks, 'crew.py', 'keep');
    const moved = supersedeHandmade(hooks, sup, ['block-mass-kill.py', 'mem-admission.sh'], 1234);
    assert.deepEqual(moved, [{ from: path.join(hooks, 'block-mass-kill.py'), to: path.join(sup, 'block-mass-kill.py.1234') }]);
    assert.equal(fs.readFileSync(path.join(sup, 'block-mass-kill.py.1234'), 'utf8'), 'old');
    assert.ok(!fs.existsSync(path.join(hooks, 'block-mass-kill.py')));
    assert.ok(fs.existsSync(path.join(hooks, 'crew.py')));
    assert.deepEqual(supersedeHandmade(hooks, sup, ['block-mass-kill.py'], 5678), []);
  });

  test('a symlink into the install dir is skipped; another symlink is moved as a link', () => {
    const hooks = tmp('hg-hooks-');
    const install = tmp('hg-install-');
    const sup = tmp('hg-sup-');
    write(install, 'mem-admission.sh', 'installed');
    write(hooks, 'elsewhere.sh', 'x');
    fs.symlinkSync(path.join(install, 'mem-admission.sh'), path.join(hooks, 'mem-admission.sh'));
    fs.symlinkSync(path.join(hooks, 'elsewhere.sh'), path.join(hooks, 'block-second-chrome.sh'));
    const moved = supersedeHandmade(hooks, sup, ['mem-admission.sh', 'block-second-chrome.sh'], 9, install);
    assert.deepEqual(moved.map((m) => path.basename(m.to)), ['block-second-chrome.sh.9']);
    assert.ok(fs.lstatSync(path.join(hooks, 'mem-admission.sh')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(sup, 'block-second-chrome.sh.9')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(install, 'mem-admission.sh'), 'utf8'), 'installed');
  });
});
