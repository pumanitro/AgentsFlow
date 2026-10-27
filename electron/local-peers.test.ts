// The add_local_peer / remove_peer tools, main-process half: raw tool arguments
// in, an envelope out, against real temp directories and an in-memory store.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { addLocalDirectory, addLocalPeerEnvelope, checkLocalDirectory, removePeerEnvelope, type LocalPeersDeps } from './local-peers';
import { recomputeDisplayNamesKeepingRemote } from './main-remote';
import type { TrackedDirectory } from '../shared/types';

const T0 = new Date('2026-10-27T09:00:00.000Z');

function setup(initial: TrackedDirectory[] = []) {
  // realpath: os.tmpdir() is a symlink on macOS, and the store keeps what we pass.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-peers-')));
  let dirs = initial;
  let n = 0;
  const relinks: string[] = [];
  const deps: LocalPeersDeps = {
    getDirectories: () => dirs,
    setDirectories: (next) => { dirs = next; },
    relinkConversationsByPath: (p, id) => { relinks.push(`${p}→${id}`); return p.endsWith('/had-history') ? 2 : 0; },
    newId: () => `d${++n}`,
    now: () => T0,
  };
  const mk = (...segs: string[]) => { const p = path.join(root, ...segs); fs.mkdirSync(p, { recursive: true }); return p; };
  return { root, deps, mk, relinks, dirs: () => dirs };
}

describe('checkLocalDirectory', () => {
  it('accepts an absolute directory and normalises a trailing slash', () => {
    const { mk } = setup();
    const p = mk('arrow');
    assert.deepEqual(checkLocalDirectory(`${p}/`), { ok: true, path: p });
  });
  it('rejects relative, missing, empty and file paths', () => {
    const { root } = setup();
    fs.writeFileSync(path.join(root, 'file.txt'), 'x');
    assert.match((checkLocalDirectory('projects/arrow') as { error: string }).error, /must be absolute/);
    assert.match((checkLocalDirectory(path.join(root, 'nope')) as { error: string }).error, /does not exist/);
    assert.match((checkLocalDirectory('') as { error: string }).error, /required/);
    assert.match((checkLocalDirectory(42) as { error: string }).error, /required/);
    assert.match((checkLocalDirectory(path.join(root, 'file.txt')) as { error: string }).error, /Not a directory/);
  });
});

describe('add_local_peer', () => {
  it('tracks a valid directory, named after it, and returns name, id and path', () => {
    const { deps, mk, dirs } = setup();
    const p = mk('work', 'arrow');
    const r = addLocalPeerEnvelope({ path: p }, deps);
    assert.equal(r.envelope.status, 'success');
    assert.deepEqual(r.envelope.peer, { id: 'd1', displayName: 'arrow', path: p });
    assert.equal(r.envelope.delegateWith, 'directory: "arrow"');
    assert.equal(r.changed?.id, 'd1');
    assert.deepEqual(dirs(), [{ id: 'd1', path: p, displayName: 'arrow', addedAt: T0.toISOString() }]);
  });

  it('disambiguates a basename clash exactly like the Add directory button', () => {
    const { deps, mk, dirs } = setup();
    const a = mk('one', 'app');
    const b = mk('two', 'app');
    addLocalDirectory(a, deps);              // the button's path
    const r = addLocalPeerEnvelope({ path: b }, deps);
    assert.equal((r.envelope.peer as { displayName: string }).displayName, 'two/app');
    assert.deepEqual(dirs().map((d) => d.displayName), ['one/app', 'two/app']);
  });

  it('a nonexistent path is a failure and saves nothing', () => {
    const { deps, root, dirs } = setup();
    const r = addLocalPeerEnvelope({ path: path.join(root, 'missing') }, deps);
    assert.equal(r.envelope.status, 'failure');
    assert.match(String(r.envelope.error), /does not exist/);
    assert.equal(r.changed, null);
    assert.deepEqual(dirs(), []);
  });

  it('a relative path is a failure and saves nothing', () => {
    const { deps, dirs } = setup();
    const r = addLocalPeerEnvelope({ path: './arrow' }, deps);
    assert.equal(r.envelope.status, 'failure');
    assert.match(String(r.envelope.error), /must be absolute/);
    assert.deepEqual(dirs(), []);
  });

  it('a directory already tracked comes back as the existing peer, never duplicated', () => {
    const { deps, mk, dirs } = setup();
    const p = mk('arrow');
    addLocalPeerEnvelope({ path: p }, deps);
    const r = addLocalPeerEnvelope({ path: `${p}/` }, deps);
    assert.equal(r.envelope.status, 'success');
    assert.equal(r.envelope.alreadyTracked, true);
    assert.deepEqual(r.envelope.peer, { id: 'd1', displayName: 'arrow', path: p });
    assert.equal(r.changed, null);
    assert.equal(dirs().length, 1);
  });

  it('a remote peer with the same path does not count as tracked', () => {
    const { deps, mk, dirs } = setup();
    const p = mk('arrow');
    const remote = { id: 'r1', path: p, displayName: 'arrow @studio', addedAt: T0.toISOString(), remote: { host: 'studio', user: 'u', sshArgs: [], claudeBin: 'claude', nodeBin: 'node', extraPath: [], permissionMode: 'bypassPermissions' as const } };
    deps.setDirectories([remote]);
    const r = addLocalPeerEnvelope({ path: p }, deps);
    assert.equal(r.envelope.alreadyTracked, undefined);
    assert.equal(dirs().length, 2);
  });

  it('test_only checks the path and saves nothing', () => {
    const { deps, mk, dirs, relinks } = setup();
    const p = mk('arrow');
    const r = addLocalPeerEnvelope({ path: p, testOnly: true }, deps);
    assert.deepEqual(r.envelope, { status: 'success', testOnly: true, path: p, displayName: 'arrow', note: 'The directory can be added; nothing was saved.' });
    assert.deepEqual(dirs(), []);
    assert.deepEqual(relinks, []);
  });

  it('display_name pins the card name, survives later recomputes, and may not clash', () => {
    const { deps, mk, dirs } = setup();
    const a = mk('one', 'app');
    const r = addLocalPeerEnvelope({ path: a, displayName: '  Studio Bot ' }, deps);
    assert.equal((r.envelope.peer as { displayName: string }).displayName, 'Studio Bot');
    addLocalPeerEnvelope({ path: mk('two', 'app') }, deps);
    assert.equal(recomputeDisplayNamesKeepingRemote(dirs())[0].displayName, 'Studio Bot');
    const clash = addLocalPeerEnvelope({ path: mk('three'), displayName: 'studio bot' }, deps);
    assert.equal(clash.envelope.status, 'failure');
    assert.match(String(clash.envelope.error), /already named "Studio Bot"/);
    assert.equal(addLocalPeerEnvelope({ path: mk('four'), displayName: '' }, deps).envelope.status, 'failure');
  });

  it('re-adding a path re-links its recorded conversations', () => {
    const { deps, mk, relinks } = setup();
    const p = mk('had-history');
    const r = addLocalPeerEnvelope({ path: p }, deps);
    assert.equal(r.relinked, 2);
    assert.equal(r.envelope.relinkedConversations, 2);
    assert.deepEqual(relinks, [`${p}→d1`]);
  });
});

describe('remove_peer', () => {
  it('untracks by name, path or id and never deletes the directory', () => {
    const { deps, mk, dirs } = setup();
    const a = mk('arrow'), b = mk('blog'), c = mk('cards');
    for (const p of [a, b, c]) addLocalPeerEnvelope({ path: p }, deps);
    fs.writeFileSync(path.join(a, 'keep.txt'), 'x');

    const byName = removePeerEnvelope({ name: 'ARROW' }, deps);
    assert.equal(byName.envelope.status, 'success');
    assert.deepEqual(byName.envelope.removed, { id: 'd1', displayName: 'arrow', path: a });
    assert.ok(fs.existsSync(path.join(a, 'keep.txt')), 'remove_peer touched the files');

    assert.equal(removePeerEnvelope({ path: `${b}/` }, deps).removed?.id, 'd2');
    assert.equal(removePeerEnvelope({ id: 'd3' }, deps).removed?.path, c);
    assert.deepEqual(dirs(), []);
  });

  it('remaining names are recomputed once a clash goes away', () => {
    const { deps, mk, dirs } = setup();
    addLocalPeerEnvelope({ path: mk('one', 'app') }, deps);
    addLocalPeerEnvelope({ path: mk('two', 'app') }, deps);
    removePeerEnvelope({ name: 'one/app' }, deps);
    assert.deepEqual(dirs().map((d) => d.displayName), ['app']);
  });

  it('an unknown or missing peer is a failure that changes nothing', () => {
    const { deps, mk, dirs } = setup();
    addLocalPeerEnvelope({ path: mk('arrow') }, deps);
    const unknown = removePeerEnvelope({ name: 'nope' }, deps);
    assert.equal(unknown.envelope.status, 'failure');
    assert.deepEqual(unknown.envelope.known, ['arrow']);
    assert.equal(removePeerEnvelope({}, deps).envelope.status, 'failure');
    assert.equal(dirs().length, 1);
  });
});
