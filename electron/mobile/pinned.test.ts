import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Conversation, PinnedDivider, PinnedTodo, TrackedDirectory } from '../../shared/types';
import type { ConversationSummary } from '../../shared/mobile';
import { buildPinnedList } from './pinned';

const conv = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  id, sessionId: 's' + id, daemonShort: 'd' + id, sessionName: '', directoryId: 'p1', directoryPath: '/p', displayName: '',
  title: 't' + id, description: '', pinned: true, state: 'working', status: '', intent: '', createdAt: '2026-10-01T00:00:00Z', lastPrompt: '', ...over,
} as Conversation);
const sum = (c: Conversation) => ({ id: c.id, title: c.title } as unknown as ConversationSummary);
const dirs = [{ id: 'p1', path: '/p', displayName: 'Peer', addedAt: '' } as TrackedDirectory];

test('pinned list follows desktop order with separators, to-dos, sub-chats and history', () => {
  const convs = [conv('a'), conv('b'), conv('kid', { delegatedByConversationId: 'a', pinned: false }),
    conv('h1', { pinned: false, unpinnedAt: '2026-10-02T00:00:00Z' }), conv('h2', { pinned: false, unpinnedAt: '2026-10-03T00:00:00Z' })];
  const dividers: PinnedDivider[] = [{ id: 'd1', title: 'WORK', createdAt: '' }];
  const todos: PinnedTodo[] = [
    { id: 't1', directoryId: 'p1', text: 'nested', createdAt: '1', done: false, conversationId: 'a' },
    { id: 't2', directoryId: 'p1', text: 'alone', createdAt: '2', done: false },
    { id: 't3', directoryId: 'p1', text: 'finished', createdAt: '3', done: true, conversationId: 'a' },
  ];
  const order = [{ kind: 'conversation', id: 'b' }, { kind: 'divider', id: 'd1' }, { kind: 'todo', id: 't2' }, { kind: 'conversation', id: 'a' }] as const;
  const r = buildPinnedList({ convs, dividers, todos, order: [...order], dirs, summarise: sum });
  assert.deepEqual(r.items.map((i) => i.kind === 'conversation' ? 'c:' + i.summary.id : i.kind === 'divider' ? 'd:' + i.title : 't:' + i.text),
    ['c:b', 'd:WORK', 't:alone', 'c:a']);
  const a = r.items[3] as Extract<typeof r.items[number], { kind: 'conversation' }>;
  assert.deepEqual(a.todos.map((t) => t.text), ['nested']);
  assert.deepEqual(a.children.map((c) => c.id), ['kid']);
  assert.deepEqual(r.history.map((h) => h.id), ['h2', 'h1']);   // newest first, sub-chats excluded
});
