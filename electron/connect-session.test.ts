import test from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation, TrackedDirectory } from '../shared/types';
import {
  planConnect, isInsideRemotePath, sanitizeConnect, expandLauncher, transcriptProbeArgv,
  connectAttachOpts, launcherExitReason, isSessionId, type PlanConnectDeps, type ConnectSessionArgs,
} from './connect-session';

const SRC = '4359c196-800c-4c31-9e63-16edfeb8f45d';
const HOST = 'demo@box';
const PEER: TrackedDirectory = {
  id: 'd1', path: '/Users/demo/bcfc-bot', displayName: 'bcfc-bot', addedAt: '2026-01-01T00:00:00Z',
  remote: { host: 'box', user: 'demo', claudeBin: 'claude', extraPath: [] } as any,
};
const LOCAL: TrackedDirectory = { id: 'd2', path: '/Users/demo/local', displayName: 'local', addedAt: '' };

function deps(over: Partial<PlanConnectDeps> = {}): PlanConnectDeps {
  let n = 0;
  return {
    directories: [PEER, LOCAL],
    conversations: [],
    resolvePeer: (t, ds) => ds.find((d) => d.displayName === t) ?? null,
    hostKeyFor: (d) => (d.remote ? HOST : undefined),
    newId: () => `id-${++n}`,
    now: () => '2026-11-16T10:00:00.000Z',
    ...over,
  };
}
const base: ConnectSessionArgs = { peer: 'bcfc-bot', sessionId: SRC, title: 'Fix it' };

function failStage(args: ConnectSessionArgs, d = deps()) {
  const p = planConnect(args, d);
  assert.equal(p.kind, 'failure');
  return p.kind === 'failure' ? p : null!;
}

test.describe('planConnect failures', () => {
  test('args: bad session id', () => assert.equal(failStage({ ...base, sessionId: 'nope' }).stage, 'args'));
  test('args: blank title', () => assert.equal(failStage({ ...base, title: '   ' }).stage, 'args'));
  test('args: readOnly without fork', () => {
    const f = failStage({ ...base, readOnly: true });
    assert.equal(f.stage, 'args'); assert.equal(f.error, 'readOnly needs fork: true');
  });
  test('args: bad launchers', () => {
    for (const l of [[], [''], ['a\nb'], ['a\0'], ['x'.repeat(1025)], Array(33).fill('a'), [1 as any]]) {
      assert.equal(failStage({ ...base, launcher: l }).stage, 'args');
    }
  });
  test('peer: unknown lists known names', () => {
    const f = failStage({ ...base, peer: 'ghost' });
    assert.equal(f.stage, 'peer'); assert.match(f.error, /bcfc-bot/); assert.match(f.error, /local/);
  });
  test('peer: local peer refused', () => {
    const f = failStage({ ...base, peer: 'local' });
    assert.equal(f.error, 'connect_session works on remote peers only');
  });
  test('peer: no host key refused', () => {
    assert.equal(failStage(base, deps({ hostKeyFor: () => undefined })).stage, 'peer');
  });
  test('cwd: outside / escape / sibling prefix', () => {
    for (const cwd of ['/tmp', '/Users/demo/bcfc-bot/../other', '/Users/demo/bcfc-bot-2', 'relative']) {
      const f = failStage({ ...base, cwd });
      assert.equal(f.stage, 'cwd'); assert.match(f.error, /\/Users\/demo\/bcfc-bot/);
    }
  });
});

test.describe('isInsideRemotePath', () => {
  test('equal, inside, outside, sibling prefix', () => {
    assert.equal(isInsideRemotePath('/Users/demo/bcfc', '/Users/demo/bcfc'), true);
    assert.equal(isInsideRemotePath('/Users/demo/bcfc', '/Users/demo/bcfc/'), true);
    assert.equal(isInsideRemotePath('/Users/demo/bcfc', '/Users/demo/bcfc/a/b'), true);
    assert.equal(isInsideRemotePath('/Users/demo/bcfc', '/Users/demo'), false);
    assert.equal(isInsideRemotePath('/Users/demo/bcfc', '/Users/demo/bcfc/../x'), false);
    assert.equal(isInsideRemotePath('/Users/demo/bcfc', '/Users/demo/bcfc-bot'), false);
    assert.equal(isInsideRemotePath('/Users/demo/bcfc', 'bcfc'), false);
  });
});

test.describe('planConnect create', () => {
  test('resume row shape', () => {
    const p = planConnect({ ...base, cwd: '/Users/demo/bcfc-bot/sub/' }, deps());
    assert.equal(p.kind, 'create');
    if (p.kind !== 'create') return;
    assert.equal(p.row.id, 'id-1');
    assert.equal(p.row.sessionId, SRC);
    assert.equal(p.row.host, HOST);
    assert.equal(p.row.pinned, true);
    assert.equal(p.row.chatKind, 'chat');
    assert.equal(p.row.state, 'idle');
    assert.equal(p.row.directoryId, 'd1');
    assert.equal(p.row.description, 'connected session — open the chat to continue');
    assert.equal(p.row.forkFromSessionId, undefined);
    assert.equal(p.row.worktreePath, undefined);
    assert.deepEqual(p.row.connect, { sourceSessionId: SRC, cwd: '/Users/demo/bcfc-bot/sub', connectedAt: '2026-11-16T10:00:00.000Z' });
    assert.equal(p.needsApproval, true);
    assert.equal(p.peer, PEER);
  });
  test('cwd defaults to peer path; title trimmed and cut to 80', () => {
    const p = planConnect({ ...base, title: '  ' + 'x'.repeat(100) }, deps());
    if (p.kind !== 'create') return assert.fail();
    assert.equal(p.row.connect!.cwd, '/Users/demo/bcfc-bot');
    assert.equal(p.row.title.length, 80);
  });
  test('fork row gets a new session id', () => {
    const p = planConnect({ ...base, fork: true }, deps());
    if (p.kind !== 'create') return assert.fail();
    assert.equal(p.row.sessionId, 'id-2');
    assert.equal(p.row.connect!.fork, true);
    assert.ok(!('readOnly' in p.row.connect!));
    assert.equal(p.needsApproval, true);
  });
  test('read-only fork', () => {
    const p = planConnect({ ...base, fork: true, readOnly: true, launcher: ['lock', '{conversationId}'] }, deps());
    if (p.kind !== 'create') return assert.fail();
    assert.equal(p.row.description, 'read-only copy — open the chat to view');
    assert.deepEqual(p.row.connect!.launcher, ['lock', '{conversationId}']);
    assert.equal(p.needsApproval, false);
  });
});

test.describe('planConnect reuse', () => {
  const existing = (): Conversation => {
    const p = planConnect(base, deps());
    if (p.kind !== 'create') throw new Error();
    return p.row;
  };
  test('same args → null patch', () => {
    const row = existing();
    const p = planConnect(base, deps({ conversations: [row] }));
    assert.equal(p.kind, 'reuse');
    if (p.kind === 'reuse') { assert.equal(p.conversation, row); assert.equal(p.patch, null); }
  });
  test('changed title/launcher → patch', () => {
    const row = existing();
    const p = planConnect({ ...base, title: 'New', launcher: ['w'] }, deps({ conversations: [row] }));
    if (p.kind !== 'reuse') return assert.fail();
    assert.equal(p.patch!.title, 'New');
    assert.deepEqual(p.patch!.connect!.launcher, ['w']);
    assert.equal(p.patch!.connect!.sourceSessionId, SRC);
  });
  test('unpinned row is not reused; fork flag must match', () => {
    const row = { ...existing(), pinned: false };
    assert.equal(planConnect(base, deps({ conversations: [row] })).kind, 'create');
    assert.equal(planConnect({ ...base, fork: true }, deps({ conversations: [existing()] })).kind, 'create');
  });
});

test.describe('helpers', () => {
  test('isSessionId case-insensitive', () => {
    assert.equal(isSessionId(SRC.toUpperCase()), true);
    assert.equal(isSessionId('x'), false);
  });
  test('expandLauncher', () => {
    assert.deepEqual(expandLauncher(['lock', 'peersflow:{conversationId}', '{conversationId}'], 'c1'), ['lock', 'peersflow:c1', 'c1']);
    assert.equal(expandLauncher([], 'c1'), undefined);
    assert.equal(expandLauncher(undefined, 'c1'), undefined);
  });
  test('sanitizeConnect', () => {
    const full = { sourceSessionId: SRC, cwd: '/a', fork: true, readOnly: true, launcher: ['l'], connectedAt: 't' };
    assert.deepEqual(sanitizeConnect(full), full);
    assert.equal(sanitizeConnect(null), undefined);
    assert.equal(sanitizeConnect({ sourceSessionId: 'x', cwd: '/a' }), undefined);
    assert.equal(sanitizeConnect({ sourceSessionId: SRC, cwd: 'rel' }), undefined);
    const junk = sanitizeConnect({ sourceSessionId: SRC, cwd: '/a', connectedAt: 't', fork: 'yes', launcher: [1], extra: 1 });
    assert.deepEqual(junk, { sourceSessionId: SRC, cwd: '/a', connectedAt: 't' });
  });
  test('transcriptProbeArgv', () => {
    assert.throws(() => transcriptProbeArgv('x; rm -rf /'));
    assert.deepEqual(transcriptProbeArgv(SRC),
      ['sh', '-c', `ls "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${SRC}.jsonl >/dev/null 2>&1`]);
  });
  test('connectAttachOpts combos', () => {
    const c = (fork?: true, readOnly?: true) => ({ sessionId: 'n', connect: { sourceSessionId: SRC, cwd: '/a', connectedAt: '', fork, readOnly, launcher: ['l'] } });
    assert.deepEqual(connectAttachOpts(c(), false), { remoteCwd: '/a', launcher: ['l'], peerAwareness: true });
    assert.deepEqual(connectAttachOpts(c(true), false), { remoteCwd: '/a', forkFrom: SRC, launcher: ['l'], peerAwareness: true });
    assert.deepEqual(connectAttachOpts(c(true), true), { remoteCwd: '/a', launcher: ['l'], peerAwareness: true });
    assert.deepEqual(connectAttachOpts(c(true, true), false), {
      remoteCwd: '/a', forkFrom: SRC, launcher: ['l'], peerAwareness: false,
      permissionMode: 'manual', tools: ['Read', 'Grep', 'Glob'], strictMcpConfig: true,
    });
  });
  test('launcherExitReason', () => {
    assert.equal(launcherExitReason(75, ['l'], 'a\nlocked by x\n\n'), 'The session is busy on the remote machine.\nlocked by x');
    assert.equal(launcherExitReason(75, undefined, 'x'), undefined);
    assert.equal(launcherExitReason(1, ['l'], 'x'), undefined);
  });
});
