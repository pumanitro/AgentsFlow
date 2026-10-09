import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import type { BrowserWindow } from 'electron';
import type { StatResult } from '../../shared/remote';
import type { RemotePeerSpec, SearchOptions, TrackedDirectory } from '../../shared/types';
import type { RunResult } from './remote-exec';
import { RemoteHosts, setRemoteHosts } from './remote-hosts';
import * as remoteFs from './remote-fs';

const spec: RemotePeerSpec = {
  host: 'studio', user: 'patryk', sshArgs: [], claudeBin: 'claude', nodeBin: 'node',
  extraPath: [], permissionMode: 'bypassPermissions',
};
const KEY = 'patryk@studio';
const HOME = '/Users/patryk';

function dir(id: string, p: string, remote = false): TrackedDirectory {
  return { id, path: p, displayName: id, addedAt: '2026-10-09T00:00:00Z', ...(remote ? { remote: spec } : {}) };
}

// A fake host: an in-memory remote filesystem plus a log of every call. It
// borrows the real hostKeyForPath so routing tests exercise the shipped rule.
class FakeHosts {
  calls: string[] = [];
  files = new Map<string, Buffer>();
  dirsOnHost = new Set<string>();
  execResult: RunResult = { code: 0, stdout: '', stderr: '', timedOut: false };
  failWatch = false;
  homeDir: string | null = HOME;
  constructor(public deps: { getDirectories: () => TrackedDirectory[] }) {}
  hostKeyForPath(p: string): string | null {
    return RemoteHosts.prototype.hostKeyForPath.call(this as unknown as RemoteHosts, p);
  }
  home(): string | null { return this.homeDir; }
  async stat(_h: string, p: string): Promise<StatResult> {
    this.calls.push(`stat ${p}`);
    const f = this.files.get(p);
    if (f) return { exists: true, isFile: true, isDirectory: false, size: f.length, mtimeMs: 1 };
    if (this.dirsOnHost.has(p)) return { exists: true, isFile: false, isDirectory: true, size: 0, mtimeMs: 1 };
    return { exists: false, isFile: false, isDirectory: false, size: 0, mtimeMs: 0 };
  }
  async readFile(_h: string, p: string, maxBytes?: number) {
    this.calls.push(`read ${p} ${maxBytes}`);
    const f = this.files.get(p);
    if (!f) throw new Error(`ENOENT: ${p}`);
    const n = Math.min(f.length, maxBytes ?? f.length);
    return { content: f.subarray(0, n), size: f.length, truncated: f.length > n };
  }
  async writeFile(_h: string, p: string, content: Buffer | string, mode?: number) {
    this.calls.push(`write ${p} ${mode?.toString(8)}`);
    this.files.set(p, Buffer.from(content));
  }
  async exec(_h: string, argv: string[]): Promise<RunResult> {
    this.calls.push(`exec ${argv[0]} ${argv.slice(argv[0] === '/bin/sh' ? 4 : 1).join(' ')}`);
    return this.execResult;
  }
  async createFile(_h: string, p: string) { this.calls.push(`mkfile ${p}`); }
  async rename(_h: string, a: string, b: string) { this.calls.push(`rename ${a} ${b}`); }
  async remove(_h: string, p: string) { this.calls.push(`remove ${p}`); }
  async search(_h: string, d: string, q: string, _o?: SearchOptions) {
    this.calls.push(`search ${d} ${q}`);
    if (q === 'boom') throw new Error('host patryk@studio is unreachable');
    return { files: [], totalMatches: 0, filesScanned: 3, truncated: false };
  }
  async fsWatch(_h: string, d: string) {
    this.calls.push(`fswatch ${d}`);
    await new Promise((r) => setTimeout(r, 5));
    if (this.failWatch) throw new Error('watch failed');
  }
  async fsUnwatch(_h: string, d: string) { this.calls.push(`fsunwatch ${d}`); }
}

let dirs: TrackedDirectory[];
let fake: FakeHosts;
const win = (name: string) => ({ name }) as unknown as BrowserWindow;

beforeEach(() => {
  dirs = [dir('studio-app', '/Users/patryk/app', true), dir('studio-nested', '/Users/patryk/app/pkg', true), dir('local', '/Users/iij/code')];
  fake = new FakeHosts({ getDirectories: () => dirs });
  setRemoteHosts(fake as unknown as RemoteHosts);
  remoteFs.resetWatchesForTest();
});

test('resolveRemotePath: remote dir, nested peer wins, local paths and prefixes stay local', () => {
  assert.equal(remoteFs.resolveRemotePath('/Users/patryk/app/src/a.ts')?.dir.id, 'studio-app');
  assert.equal(remoteFs.resolveRemotePath('/Users/patryk/app')?.hostKey, KEY);
  assert.equal(remoteFs.resolveRemotePath('/Users/patryk/app/pkg/x')?.dir.id, 'studio-nested');
  assert.equal(remoteFs.resolveRemotePath('/Users/iij/code/a.ts'), null);
  // A sibling sharing the string prefix is not inside the peer.
  assert.equal(remoteFs.resolveRemotePath('/Users/patryk/application/x'), null);
  assert.equal(remoteFs.resolveRemotePath(''), null);
});

test('resolveRemotePath: a local tracked dir on the same path wins over the remote one', () => {
  dirs.push(dir('local-shadow', '/Users/patryk/app'));
  assert.equal(remoteFs.resolveRemotePath('/Users/patryk/app/src/a.ts'), null);
});

test('resolveRemotePath: null without a RemoteHosts', () => {
  setRemoteHosts(null);
  assert.equal(remoteFs.resolveRemotePath('/Users/patryk/app/a'), null);
});

test('readText: text, NUL sniff → binary, over the 2 MB cap → truncated without a read, missing → error', async () => {
  fake.files.set('/r/a.txt', Buffer.from('héllo', 'utf8'));
  assert.deepEqual(await remoteFs.readText(KEY, '/r/a.txt'), { content: 'héllo', size: 6, truncated: false, binary: false });

  fake.files.set('/r/bin', Buffer.from([0x50, 0x00, 0x41]));
  assert.deepEqual(await remoteFs.readText(KEY, '/r/bin'), { content: '', size: 3, truncated: false, binary: true });

  // NUL after the 8 KB sniff window is still text, as locally.
  const late = Buffer.alloc(9000, 0x61); late[8500] = 0;
  fake.files.set('/r/late', late);
  assert.equal((await remoteFs.readText(KEY, '/r/late')).binary, false);

  fake.files.set('/r/big', Buffer.alloc(remoteFs.READ_TEXT_MAX + 1, 0x61));
  fake.calls = [];
  assert.deepEqual(await remoteFs.readText(KEY, '/r/big'), { content: '', size: remoteFs.READ_TEXT_MAX + 1, truncated: true, binary: false });
  assert.deepEqual(fake.calls, ['stat /r/big']);

  const missing = await remoteFs.readText(KEY, '/r/nope');
  assert.equal(missing.content, '');
  assert.match(missing.error ?? '', /ENOENT/);
});

test('readBinary: MIME table, octet-stream fallback, 8 MB vs 64 MB PDF cap', async () => {
  fake.files.set('/r/p.PNG', Buffer.from([1, 2, 3]));
  const png = await remoteFs.readBinary(KEY, '/r/p.PNG');
  assert.equal(png.mime, 'image/png');
  assert.equal(png.dataUrl, `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
  assert.equal(png.truncated, false);

  fake.files.set('/r/x.weird', Buffer.from('z'));
  assert.equal((await remoteFs.readBinary(KEY, '/r/x.weird')).mime, 'application/octet-stream');

  const nineMb = Buffer.alloc(9 * 1024 * 1024);
  fake.files.set('/r/huge.jpg', nineMb);
  assert.deepEqual(await remoteFs.readBinary(KEY, '/r/huge.jpg'), { dataUrl: '', mime: '', size: nineMb.length, truncated: true });
  fake.files.set('/r/scan.pdf', nineMb);
  const pdf = await remoteFs.readBinary(KEY, '/r/scan.pdf');
  assert.equal(pdf.mime, 'application/pdf');
  assert.equal(pdf.truncated, false);

  assert.match((await remoteFs.readBinary(KEY, '/r/none.png')).error ?? '', /ENOENT/);
});

test('writeText: temp sibling then an in-place swap; a failed swap throws', async () => {
  assert.deepEqual(await remoteFs.writeText(KEY, '/r/a.ts', 'x'), { ok: true });
  const tmp = `/r/a.ts.${process.pid}.agentsflow-tmp`;
  assert.deepEqual(fake.calls, [`write ${tmp} 644`, `exec /bin/sh ${tmp} /r/a.ts`]);

  fake.execResult = { code: 1, stdout: '', stderr: 'mv: permission denied\n', timedOut: false };
  await assert.rejects(remoteFs.writeText(KEY, '/r/a.ts', 'x'), /permission denied/);
  await assert.rejects(remoteFs.writeText(KEY, 'rel.ts', 'x'), /absolute/);
});

test('createFile / renamePath / removePath: mkdir -p, target-exists and suspicious-path guards', async () => {
  await remoteFs.createFile(KEY, '/r/new/dir/f.ts');
  assert.deepEqual(fake.calls, ['exec mkdir -p /r/new/dir', 'mkfile /r/new/dir/f.ts']);
  await assert.rejects(remoteFs.createFile(KEY, 'f.ts'), /absolute/);

  fake.calls = [];
  await remoteFs.renamePath(KEY, '/r/a', '/r/sub/b');
  assert.deepEqual(fake.calls, ['stat /r/sub/b', 'exec mkdir -p /r/sub', 'rename /r/a /r/sub/b']);
  fake.files.set('/r/taken', Buffer.from(''));
  await assert.rejects(remoteFs.renamePath(KEY, '/r/a', '/r/taken'), /target already exists at \/r\/taken/);

  fake.calls = [];
  await remoteFs.removePath(KEY, '/r/a/b');
  assert.deepEqual(fake.calls, ['remove /r/a/b']);
  await assert.rejects(remoteFs.removePath(KEY, '/'), /suspicious/);
  await assert.rejects(remoteFs.removePath(KEY, '/Users'), /suspicious/);
  await assert.rejects(remoteFs.removePath(KEY, 'x/y'), /absolute/);
});

test('probePath: ~ uses the REMOTE home, relative resolves against the remote cwd, absolute normalises', async () => {
  fake.files.set(`${HOME}/notes.md`, Buffer.from(''));
  assert.deepEqual(await remoteFs.probePath(KEY, null, '~/notes.md'), { exists: true, absPath: `${HOME}/notes.md` });
  assert.deepEqual(await remoteFs.probePath(KEY, null, '~'), { exists: false, absPath: HOME });

  fake.files.set('/Users/patryk/app/src/a.ts', Buffer.from(''));
  assert.deepEqual(await remoteFs.probePath(KEY, '/Users/patryk/app', 'src/a.ts'), { exists: true, absPath: '/Users/patryk/app/src/a.ts' });
  assert.deepEqual(await remoteFs.probePath(KEY, '/Users/patryk/app/pkg', '../src/a.ts'), { exists: true, absPath: '/Users/patryk/app/src/a.ts' });
  assert.deepEqual(await remoteFs.probePath(KEY, '/x', '/Users/patryk/app//src/./a.ts'), { exists: true, absPath: '/Users/patryk/app/src/a.ts' });
  assert.deepEqual(await remoteFs.probePath(KEY, '/x', '/nope'), { exists: false, absPath: '/nope' });

  assert.equal(await remoteFs.probePath(KEY, null, 'rel/a.ts'), null);
  assert.equal(await remoteFs.probePath(KEY, null, ''), null);
  assert.equal(await remoteFs.probePath(KEY, null, 'x'.repeat(4097)), null);
  fake.homeDir = null;
  assert.equal(await remoteFs.probePath(KEY, null, '~/notes.md'), null);
});

test('search: passes through, and a host failure becomes the error field like the local handler', async () => {
  assert.equal((await remoteFs.search(KEY, '/r', 'needle')).filesScanned, 3);
  assert.deepEqual(await remoteFs.search(KEY, '/r', 'boom'), {
    files: [], totalMatches: 0, filesScanned: 0, truncated: false, error: 'host patryk@studio is unreachable',
  });
});

test('watch: one fswatch per dir however many windows (even concurrently), fsunwatch when the last leaves', async () => {
  const a = win('a'); const b = win('b');
  await Promise.all([remoteFs.watch(KEY, '/r', a), remoteFs.watch(KEY, '/r', b)]);
  await remoteFs.watch(KEY, '/r', a);
  assert.deepEqual(fake.calls, ['fswatch /r']);
  assert.deepEqual(remoteFs.watchingWindows(KEY, '/r'), [a, b]);

  await remoteFs.unwatch(KEY, '/r', a);
  await remoteFs.unwatch(KEY, '/r', b);
  assert.deepEqual(fake.calls, ['fswatch /r']);
  await remoteFs.unwatch(KEY, '/r', a);
  assert.deepEqual(fake.calls, ['fswatch /r', 'fsunwatch /r']);
  assert.deepEqual(remoteFs.watchingWindows(KEY, '/r'), []);

  // Unknown dir: no-op.
  await remoteFs.unwatch(KEY, '/other', a);
  assert.equal(fake.calls.length, 2);
});

test('watch: a failed fswatch forgets the entry so the next watch retries', async () => {
  fake.failWatch = true;
  await assert.rejects(remoteFs.watch(KEY, '/r', win('a')), /watch failed/);
  fake.failWatch = false;
  await remoteFs.watch(KEY, '/r', win('a'));
  assert.deepEqual(fake.calls, ['fswatch /r', 'fswatch /r']);
});
