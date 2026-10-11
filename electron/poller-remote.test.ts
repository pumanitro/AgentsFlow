import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Conversation } from '../shared/types';
import type { ClaudeAgentJsonRow, ListAgentsResult } from './claude-cli';
import {
  buildHostRowIndexes, droppedWatchHosts, hostOf, LOCAL_HOST, lookupRow, parseReapKey, planRemoteWatch, reapKey, remoteHostsOf,
} from './poller-remote';

const A = 'patryk@studio';
const B = 'theo@mini';
const conv = (id: string, extra: Partial<Conversation>): Conversation => ({ id, ...extra } as unknown as Conversation);
const row = (sessionId: string, extra: Partial<ClaudeAgentJsonRow> = {}): ClaudeAgentJsonRow =>
  ({ pid: 1, cwd: '/x', kind: 'bg', startedAt: 0, sessionId, ...extra });

test('planRemoteWatch: groups non-terminal remote daemons by host, sorted and de-duplicated', () => {
  const plan = planRemoteWatch([
    conv('1', { host: A, daemonShort: 'bbbb0000', state: 'working' }),
    conv('2', { host: A, daemonShort: 'aaaa0000', state: 'blocked' }),
    conv('3', { host: A, daemonShort: 'aaaa0000', state: 'working' }),  // same job, two convs
    conv('4', { host: B, daemonShort: 'cccc0000', state: 'starting' }),
    conv('5', { host: A, daemonShort: 'dddd0000', state: 'done' }),      // terminal → not watched
    conv('6', { daemonShort: 'eeee0000', state: 'working' }),            // local → fs.watch's job
    conv('7', { host: A, state: 'working' }),                            // no daemon
    conv('8', { host: B, daemonShort: 'ffff0000', state: 'working', provider: 'codex' } as Partial<Conversation>),
  ]);
  assert.deepEqual(Array.from(plan.entries()), [[A, ['aaaa0000', 'bbbb0000']], [B, ['cccc0000']]]);
});

test('planRemoteWatch: honours the poller predicate (e.g. a finished chat that is on screen)', () => {
  const convs = [conv('1', { host: A, daemonShort: 'aaaa0000', state: 'done' })];
  assert.equal(planRemoteWatch(convs).size, 0);
  assert.deepEqual(Array.from(planRemoteWatch(convs, () => true).entries()), [[A, ['aaaa0000']]]);
});

test('droppedWatchHosts: hosts that fell out of the plan get an explicit empty set', () => {
  const plan = new Map([[A, ['aaaa0000']]]);
  assert.deepEqual(droppedWatchHosts(new Set([A, B]), plan), [B]);
  assert.deepEqual(droppedWatchHosts(new Set([A]), plan), []);
  assert.deepEqual(droppedWatchHosts([], new Map()), []);
  assert.deepEqual(droppedWatchHosts([B, A], new Map()), [A, B]);
});

test('remoteHostsOf / hostOf: local is the empty key; codex never lists', () => {
  const convs = [
    conv('1', { host: B }), conv('2', { host: A }), conv('3', { host: A }), conv('4', {}),
    conv('5', { host: 'x@codex', provider: 'codex' } as Partial<Conversation>),
  ];
  assert.deepEqual(remoteHostsOf(convs), [A, B]);
  assert.equal(hostOf(conv('4', {})), LOCAL_HOST);
  assert.equal(hostOf(conv('1', { host: B })), B);
});

test('buildHostRowIndexes: one index per host that listed; a failed host is absent (unknown)', () => {
  const results = new Map<string, ListAgentsResult>([
    [LOCAL_HOST, { ok: true, rows: [row('aaaa0000-local')] }],
    [A, { ok: true, rows: [row('aaaa0000-remote', { name: 'n1' })] }],
    [B, { ok: false, reason: 'exit' }],
  ]);
  const idx = buildHostRowIndexes(results);
  assert.deepEqual(Array.from(idx.keys()), [LOCAL_HOST, A]);
  // The same daemonShort resolves to a different row per host — never across.
  const local = idx.get(LOCAL_HOST)!;
  const remote = idx.get(A)!;
  const c = conv('1', { daemonShort: 'aaaa0000' });
  assert.equal(lookupRow(local.index, local.rows, c)?.sessionId, 'aaaa0000-local');
  assert.equal(lookupRow(remote.index, remote.rows, c)?.sessionId, 'aaaa0000-remote');
  assert.equal(lookupRow(remote.index, remote.rows, conv('2', { sessionName: 'n1' }))?.sessionId, 'aaaa0000-remote');
  assert.equal(lookupRow(remote.index, remote.rows, conv('3', { sessionId: 'nope' })), undefined);
});

test('reapKey: local keys stay the bare short; remote keys round-trip', () => {
  assert.equal(reapKey(LOCAL_HOST, 'abcd1234'), 'abcd1234');
  assert.deepEqual(parseReapKey('abcd1234'), { host: LOCAL_HOST, short: 'abcd1234' });
  assert.deepEqual(parseReapKey(reapKey(A, 'abcd1234')), { host: A, short: 'abcd1234' });
  assert.notEqual(reapKey(A, 'abcd1234'), reapKey(B, 'abcd1234'));
});
