import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { Conversation, TrackedDirectory } from '../../shared/types';
import type { ConversationSummary } from '../../shared/mobile';
import type { ClaudeAgentJsonRow, JobState } from '../claude-cli';
import { filterSummaries, orderSummaries, toSummary } from './summaries';

const DIRS = [{ id: 'd1', path: '/Users/x/LISA', displayName: 'LISA' }] as TrackedDirectory[];

function conv(p: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1', sessionId: 'sess-1', daemonShort: 'abcd1234', sessionName: '', directoryId: 'd1', directoryPath: '/Users/x/LISA',
    displayName: 'LISA', title: 'Invoices', description: 'stored text', pinned: true, state: 'done', status: '', intent: '',
    createdAt: '2026-10-28T09:00:00.000Z', lastPrompt: 'check the invoices', ...p,
  } as Conversation;
}
const row = (p: Partial<ClaudeAgentJsonRow>): ClaudeAgentJsonRow => ({ pid: 1, cwd: '/x', kind: 'bg', startedAt: 0, sessionId: 'sess-1', ...p });

describe('toSummary', () => {
  test('live busy row beats a stale done job', () => {
    const job: JobState = { state: 'done', output: { result: 'old result' } };
    const s = toSummary(conv(), DIRS, row({ status: 'busy' }), job, Date.parse('2026-10-28T10:00:00.000Z'));
    assert.equal(s.state, 'working');
    assert.equal(s.rawState, 'working');
    assert.equal(s.detail, 'working…');
    assert.equal(s.needsYou, false);
    assert.equal(s.updatedAt, '2026-10-28T10:00:00.000Z');
    assert.equal(s.peerName, 'LISA');
    assert.equal(s.provider, 'claude');
    assert.equal(s.chatKind, 'chat');
    assert.equal(s.hasSession, true);
  });
  test('blocked job, no row', () => {
    const job: JobState = { state: 'working', tempo: 'blocked', block: { questions: [{ question: 'Which option?' }] } };
    const s = toSummary(conv(), DIRS, undefined, job, 0);
    assert.equal(s.state, 'blocked');
    assert.equal(s.needsYou, true);
    assert.equal(s.detail, 'Which option?');
    assert.equal(s.updatedAt, '2026-10-28T09:00:00.000Z');   // falls back to createdAt
  });
  test('waiting row marks blocked', () => {
    const s = toSummary(conv(), DIRS, row({ status: 'waiting', waitingFor: 'permission prompt' }), null, 0);
    assert.equal(s.state, 'blocked');
    assert.equal(s.detail, 'waiting — permission prompt');
  });
  test('no row, no job: stored fields; title fallbacks; unknown peer', () => {
    const s = toSummary(conv({ title: '', directoryId: 'zz', displayName: 'Other', provider: 'codex', chatKind: 'voice', host: 'h1', delegatedByConversationId: 'p1' }), DIRS, undefined, null, 0);
    assert.equal(s.state, 'done');
    assert.equal(s.detail, 'stored text');
    assert.equal(s.title, 'check the invoices');
    assert.equal(s.peerName, 'Other');
    assert.equal(s.provider, 'codex');
    assert.equal(s.chatKind, 'voice');
    assert.equal(s.host, 'h1');
    assert.equal(s.delegatedBy, 'p1');
    assert.equal(toSummary(conv({ title: '', lastPrompt: '' }), DIRS, undefined, null, 0).title, 'Untitled chat');
  });
});

function sum(id: string, p: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, peerId: 'd1', peerName: 'LISA', title: id, detail: '', state: 'done', rawState: 'done', needsYou: false,
    pinned: false, provider: 'claude', chatKind: 'chat', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    hasSession: true, ...p,
  };
}

describe('orderSummaries', () => {
  const now = Date.parse('2026-10-28T12:00:00.000Z');
  test('pinned in pinnedOrder order, missing pinned first, then unpinned newest first', () => {
    const list = [
      sum('a', { pinned: true }), sum('b', { pinned: true }), sum('c', { pinned: true, createdAt: '2026-10-05T00:00:00.000Z' }),
      sum('u1', { unpinnedAt: '2026-10-27T00:00:00.000Z' }), sum('u2', { unpinnedAt: '2026-10-28T00:00:00.000Z' }),
      sum('old', { unpinnedAt: '2026-10-01T00:00:00.000Z' }), sum('never'),
    ];
    const out = orderSummaries(list, [
      { kind: 'divider', id: 'x' }, { kind: 'conversation', id: 'b' }, { kind: 'todo', id: 't' }, { kind: 'conversation', id: 'a' },
      { kind: 'conversation', id: 'gone' },
    ], now);
    assert.deepEqual(out.map((s) => s.id), ['c', 'b', 'a', 'u2', 'u1']);
  });
  test('unpinned capped at 50', () => {
    const list = Array.from({ length: 80 }, (_, i) => sum('u' + i, { unpinnedAt: new Date(now - i * 60_000).toISOString() }));
    const out = orderSummaries(list, [], now);
    assert.equal(out.length, 50);
    assert.equal(out[0].id, 'u0');
    assert.equal(out[49].id, 'u49');
  });
});

describe('filterSummaries', () => {
  const list = [
    sum('n', { state: 'blocked', needsYou: true, pinned: true }),
    sum('w', { state: 'working', pinned: true }),
    sum('s', { state: 'starting', pinned: true, peerId: 'd2' }),
    sum('d', { state: 'done', pinned: true }),
    sum('f', { state: 'failed', pinned: true }),
    sum('i', { state: 'idle', pinned: false }),
  ];
  const ids = (l: ConversationSummary[]) => l.map((s) => s.id);
  test('filters', () => {
    assert.deepEqual(ids(filterSummaries(list, 'needs', null)), ['n']);
    assert.deepEqual(ids(filterSummaries(list, 'working', null)), ['w', 's']);
    assert.deepEqual(ids(filterSummaries(list, 'done', null)), ['d', 'f', 'i']);
    assert.equal(filterSummaries(list, 'all', null).length, 6);
    assert.equal(filterSummaries(list, null, null).length, 6);
    assert.deepEqual(ids(filterSummaries(list, 'working', 'd2')), ['s']);
  });
});
