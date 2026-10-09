import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildProbeScript,
  delegationLooksFinished,
  lastAssistantText,
  localAttachmentPaths,
  parseProbeOutput,
  recomputeDisplayNamesKeepingRemote,
  remoteDisplayName,
  remoteSelfInfo,
  resolveSkillsDir,
  rewriteAttachmentPaths,
  shortHostName,
  validateAddRemoteRequest,
  whoamiEnvelope,
} from './main-remote';
import { DEFAULT_EXTRA_PATH } from '../shared/remote';
import type { Conversation, RemotePeerSpec, TrackedDirectory } from '../shared/types';

const SPEC: RemotePeerSpec = {
  host: 'theos-mac-studio.tail4a0f3d.ts.net', user: 'patryk', sshArgs: [], claudeBin: 'claude', nodeBin: 'node',
  extraPath: [...DEFAULT_EXTRA_PATH], permissionMode: 'bypassPermissions',
};

function dir(id: string, p: string, displayName: string, remote?: RemotePeerSpec): TrackedDirectory {
  return { id, path: p, displayName, addedAt: '2026-10-09T00:00:00Z', ...(remote ? { remote } : {}) };
}

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1', sessionId: 's-123', daemonShort: 'abcd1234', sessionName: '', directoryId: 'd1',
    directoryPath: '/Users/patryk/pf-peer', displayName: 'pf-peer', title: 'Fix it', description: '',
    pinned: true, state: 'idle', status: 'idle', intent: '', createdAt: '2026-10-09T00:00:00Z', lastPrompt: '',
    ...over,
  };
}

// ---- validateAddRemoteRequest ---------------------------------------------

test('validate: a minimal request gets defaults and forced bypass mode', () => {
  const r = validateAddRemoteRequest({ user: ' patryk ', host: 'studio', path: '/Users/patryk/pf-peer/', permissionMode: 'default' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.path, '/Users/patryk/pf-peer');
  assert.equal(r.spec.user, 'patryk');
  assert.equal(r.spec.claudeBin, 'claude');
  assert.equal(r.spec.nodeBin, 'node');
  assert.deepEqual(r.spec.extraPath, DEFAULT_EXTRA_PATH);
  assert.deepEqual(r.spec.sshArgs, []);
  assert.equal(r.spec.permissionMode, 'bypassPermissions');
  assert.equal(r.spec.envFile, undefined);
  assert.equal(r.displayName, undefined);
});

test('validate: keeps sshArgs, envFile, displayName, custom extraPath', () => {
  const r = validateAddRemoteRequest({
    user: 'u', host: 'h', path: '/x', sshArgs: ['-i', '/k'], envFile: '~/.config/peersflow/env',
    extraPath: ['/opt/bin'], displayName: '  Studio  ',
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.spec.sshArgs, ['-i', '/k']);
  assert.equal(r.spec.envFile, '~/.config/peersflow/env');
  assert.deepEqual(r.spec.extraPath, ['/opt/bin']);
  assert.equal(r.displayName, 'Studio');
});

test('validate: rejects missing user/host, relative path, bad sshArgs, option-looking host', () => {
  assert.equal(validateAddRemoteRequest(null).ok, false);
  assert.equal(validateAddRemoteRequest({ user: '', host: 'h', path: '/x' }).ok, false);
  assert.equal(validateAddRemoteRequest({ user: 'u', host: ' ', path: '/x' }).ok, false);
  assert.equal(validateAddRemoteRequest({ user: 'u', host: 'h', path: 'relative/x' }).ok, false);
  assert.equal(validateAddRemoteRequest({ user: 'u', host: 'h', path: '~/x' }).ok, false);
  assert.equal(validateAddRemoteRequest({ user: 'u', host: 'h', path: '/x', sshArgs: '-i k' }).ok, false);
  assert.equal(validateAddRemoteRequest({ user: 'u', host: 'h', path: '/x', sshArgs: ['-i', 3] }).ok, false);
  assert.equal(validateAddRemoteRequest({ user: 'u', host: '-oProxyCommand=x', path: '/x' }).ok, false);
  assert.equal(validateAddRemoteRequest({ user: 'u@v', host: 'h', path: '/x' }).ok, false);
});

// ---- probe ----------------------------------------------------------------

test('probe script quotes the directory and the binaries', () => {
  const s = buildProbeScript({ nodeBin: 'node', claudeBin: 'claude' }, "/Users/p/it's here");
  assert.match(s, /test -d '\/Users\/p\/it'\\''s here'/);
  assert.match(s, /'claude' --version/);
  assert.match(s, /PF_HOSTNAME=\$\(hostname\)/);
});

test('parseProbeOutput: success, with noise from the env file before the markers', () => {
  const r = parseProbeOutput({
    code: 0, timedOut: false, stderr: '',
    stdout: 'welcome banner\nPF_HOSTNAME=theos-mac-studio\nPF_HOME=/Users/patryk\nPF_NODE=v26.0.0\nPF_CLAUDE=2.1.295 (Claude Code)\nDIR_OK\n',
  });
  assert.deepEqual(r, {
    ok: true, hostname: 'theos-mac-studio', home: '/Users/patryk', nodeVersion: 'v26.0.0',
    claudeVersion: '2.1.295 (Claude Code)', dirExists: true,
  });
});

test('parseProbeOutput: missing dir and missing claude', () => {
  const r = parseProbeOutput({ code: 0, timedOut: false, stderr: '', stdout: 'PF_HOSTNAME=h\nPF_HOME=/h\nPF_NODE=v1\nPF_CLAUDE=\nDIR_MISSING\n' });
  assert.equal(r.ok, true);
  assert.equal(r.dirExists, false);
  assert.equal(r.claudeVersion, undefined);
});

test('parseProbeOutput: timeout, non-zero exit, garbage', () => {
  assert.deepEqual(parseProbeOutput({ code: -1, timedOut: true, stderr: 'x', stdout: '' }), { ok: false, error: 'timed out' });
  assert.deepEqual(
    parseProbeOutput({ code: 255, timedOut: false, stderr: '\nssh: Could not resolve hostname h\nmore\n', stdout: '' }),
    { ok: false, error: 'ssh: Could not resolve hostname h' },
  );
  assert.deepEqual(parseProbeOutput({ code: 255, timedOut: false, stderr: '', stdout: '' }), { ok: false, error: 'ssh exited with code 255' });
  assert.equal(parseProbeOutput({ code: 0, timedOut: false, stderr: '', stdout: 'hello\n' }).ok, false);
});

// ---- naming ---------------------------------------------------------------

test('shortHostName takes the first DNS label', () => {
  assert.equal(shortHostName('theos-mac-studio.tail4a0f3d.ts.net'), 'theos-mac-studio');
  assert.equal(shortHostName('10.0.0.5'), '10');
  assert.equal(shortHostName('studio'), 'studio');
});

test('remoteDisplayName suffixes the host only on a collision', () => {
  const others = [dir('a', '/Users/me/pf-peer', 'pf-peer')];
  assert.equal(remoteDisplayName('other', SPEC.host, others), 'other');
  assert.equal(remoteDisplayName('pf-peer', SPEC.host, others), 'pf-peer @theos-mac-studio');
  assert.equal(remoteDisplayName('PF-PEER', SPEC.host, others), 'PF-PEER @theos-mac-studio');
  const taken = [...others, dir('b', '/x', 'pf-peer @theos-mac-studio')];
  assert.equal(remoteDisplayName('pf-peer', SPEC.host, taken), 'pf-peer @theos-mac-studio (2)');
});

test('recomputeDisplayNamesKeepingRemote leaves remote names alone and ignores remote paths', () => {
  const dirs = [
    dir('l1', '/a/app', 'stale'),
    dir('l2', '/b/app', 'stale'),
    dir('r1', '/Users/patryk/app', 'app @studio', SPEC),
    dir('l3', '/c/solo', 'x'),
  ];
  const out = recomputeDisplayNamesKeepingRemote(dirs);
  assert.deepEqual(out.map((d) => d.displayName), ['a/app', 'b/app', 'app @studio', 'solo']);
  // A remote peer with the same basename must not push a local one to a longer name.
  const out2 = recomputeDisplayNamesKeepingRemote([dir('l1', '/a/app', ''), dir('r1', '/z/app', 'app @s', SPEC)]);
  assert.equal(out2[0].displayName, 'app');
});

// ---- attachments ----------------------------------------------------------

test('rewriteAttachmentPaths replaces every occurrence, longest path first', () => {
  const map = new Map([
    ['/tmp/a.png', '/r/att/c1/a.png'],
    ['/tmp/a.png.txt', '/r/att/c1/a.png.txt'],
  ]);
  const out = rewriteAttachmentPaths('see /tmp/a.png and /tmp/a.png.txt and /tmp/a.png again', map);
  assert.equal(out, 'see /r/att/c1/a.png and /r/att/c1/a.png.txt and /r/att/c1/a.png again');
  assert.equal(rewriteAttachmentPaths('untouched', new Map()), 'untouched');
});

test('localAttachmentPaths keeps absolute paths once', () => {
  assert.deepEqual(localAttachmentPaths(['/a', 'rel', '/a', '/b']), ['/a', '/b']);
  assert.deepEqual(localAttachmentPaths(undefined), []);
});

// ---- skills dir resolution ------------------------------------------------

test('resolveSkillsDir: id wins, then a local dir by path, then a remote one', () => {
  const local = dir('l', '/same', 'same');
  const remote = dir('r', '/same', 'same @s', SPEC);
  const remoteOnly = dir('r2', '/only-remote', 'only', SPEC);
  const dirs = [remote, local, remoteOnly];
  assert.equal(resolveSkillsDir(dirs, '/same', 'r')?.id, 'r');
  assert.equal(resolveSkillsDir(dirs, '/same')?.id, 'l');
  assert.equal(resolveSkillsDir(dirs, '/only-remote')?.id, 'r2');
  assert.equal(resolveSkillsDir(dirs, '/nowhere'), undefined);
  assert.equal(resolveSkillsDir(dirs, null), undefined);
  assert.equal(resolveSkillsDir(dirs, '/same', 'missing-id')?.id, 'l');
});

// ---- whoami ---------------------------------------------------------------

test('whoamiEnvelope for a local conversation', () => {
  const env = whoamiEnvelope(conv(), dir('d1', '/Users/patryk/pf-peer', 'pf-peer'), 'laptop');
  assert.deepEqual(env, {
    status: 'success', conversationId: 'c1', sessionId: 's-123', daemonShort: 'abcd1234',
    directory: 'pf-peer', directoryPath: '/Users/patryk/pf-peer', host: null, hostname: 'laptop',
    remote: false, title: 'Fix it',
  });
});

test('whoamiEnvelope for a remote conversation prefers the remote hostname', () => {
  const hostKey = 'patryk@theos-mac-studio.tail4a0f3d.ts.net';
  const d = dir('d1', '/Users/patryk/pf-peer', 'pf-peer', SPEC);
  const withCache: TrackedDirectory = {
    ...d,
    remoteCache: {
      refreshedAt: '', exists: true, hasClaudeMd: false, hasAgentsMd: false, hasProjectMcp: false, hasCodexConfig: false,
      skills: [], hostname: 'Theos-Mac-Studio.local', home: '/Users/patryk', claudeVersion: '', nodeVersion: '',
    },
  };
  const c = conv({ host: hostKey });
  assert.equal(whoamiEnvelope(c, withCache, 'laptop').hostname, 'Theos-Mac-Studio.local');
  assert.equal(whoamiEnvelope(c, d, 'laptop').hostname, SPEC.host);
  assert.equal(whoamiEnvelope(c, undefined, 'laptop').hostname, hostKey);
  assert.equal(whoamiEnvelope(c, d, 'laptop').host, hostKey);
  assert.equal(whoamiEnvelope(c, d, 'laptop').remote, true);
});

test('remoteSelfInfo uses the same hostname precedence as whoami', () => {
  const hostKey = 'patryk@studio.ts.net';
  const d = dir('d1', '/p', 'p', { ...SPEC, host: 'studio.ts.net' });
  assert.deepEqual(remoteSelfInfo(hostKey, d, '/p/sub', 'p'), { hostKey, hostname: 'studio.ts.net', dir: '/p/sub', displayName: 'p' });
  assert.equal(remoteSelfInfo(hostKey, undefined, '/p', 'p').hostname, hostKey);
});

// ---- delegation fallback --------------------------------------------------

test('lastAssistantText picks the last non-empty assistant text, string or parts', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-10-09T10:00:00Z', message: { content: 'brief' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T10:00:02Z', message: { content: 'first' } }),
    '{"type":"assistant", broken',
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T10:00:04Z', message: { content: [{ type: 'text', text: 'LAPTOP=' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'IIJs-MacBook-Pro.local' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T10:00:05Z', message: { content: [{ type: 'tool_use', name: 'y' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T10:00:06Z', message: { content: '   ' } }),
    '',
  ];
  assert.deepEqual(lastAssistantText(lines.join('\n')), { text: 'LAPTOP=\nIIJs-MacBook-Pro.local', at: '2026-10-09T10:00:04Z' });
  assert.equal(lastAssistantText(lines[0]), null);
  assert.equal(lastAssistantText(''), null);
});

test('delegationLooksFinished needs an idle row, idle/absent tempo and nothing in flight', () => {
  assert.equal(delegationLooksFinished({ status: 'idle' }, { tempo: 'idle', inFlight: { tasks: 0 } }), true);
  assert.equal(delegationLooksFinished({ status: 'idle' }, null), true);
  assert.equal(delegationLooksFinished({ status: 'idle' }, {}), true);
  assert.equal(delegationLooksFinished({ status: 'working' }, { tempo: 'idle' }), false);
  assert.equal(delegationLooksFinished({ status: 'idle' }, { tempo: 'active' }), false);
  assert.equal(delegationLooksFinished({ status: 'idle' }, { tempo: 'idle', inFlight: { tasks: 2 } }), false);
  assert.equal(delegationLooksFinished({}, null), false);
});
