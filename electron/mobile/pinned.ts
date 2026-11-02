// The desktop's pinned list, rebuilt for the phone exactly as renderer/pages/index.tsx
// builds it: pinnedOrder decides the order; dividers and standalone to-dos sit
// between conversations; to-dos with a conversationId and delegated sub-chats are
// that conversation's children; unpinned conversations form the History below.
import type { Conversation, PinnedDivider, PinnedItemRef, PinnedTodo, TrackedDirectory } from '../../shared/types';
import type { ConversationSummary, PinnedListItem, PinnedListResponse } from '../../shared/mobile';

export const HISTORY_LIMIT = 50;

export function buildPinnedList(o: {
  convs: Conversation[]; dividers: PinnedDivider[]; todos: PinnedTodo[]; order: PinnedItemRef[]; dirs: TrackedDirectory[];
  summarise: (c: Conversation) => ConversationSummary;
}): PinnedListResponse {
  const top = o.convs.filter((c) => !c.delegatedByConversationId);
  const convById = new Map(top.filter((c) => c.pinned).map((c) => [c.id, c]));
  const divById = new Map(o.dividers.map((d) => [d.id, d]));
  const todoById = new Map(o.todos.filter((t) => !t.done && !t.conversationId).map((t) => [t.id, t]));
  const childrenOf = new Map<string, Conversation[]>();
  for (const c of o.convs) {
    if (!c.delegatedByConversationId) continue;
    const l = childrenOf.get(c.delegatedByConversationId) ?? []; l.push(c); childrenOf.set(c.delegatedByConversationId, l);
  }
  const todosOf = new Map<string, PinnedTodo[]>();
  for (const t of o.todos) {
    if (t.done || !t.conversationId) continue;
    const l = todosOf.get(t.conversationId) ?? []; l.push(t); todosOf.set(t.conversationId, l);
  }
  const byCreated = <T extends { createdAt: string }>(a: T, b: T) => a.createdAt.localeCompare(b.createdAt);
  const peerName = (dirId: string) => o.dirs.find((d) => d.id === dirId)?.displayName ?? '';
  const convItem = (c: Conversation): PinnedListItem => ({
    kind: 'conversation',
    summary: o.summarise(c),
    todos: (todosOf.get(c.id) ?? []).sort(byCreated).map((t) => ({ id: t.id, text: t.text, done: t.done })),
    children: (childrenOf.get(c.id) ?? []).sort(byCreated).map(o.summarise),
  });
  const items: PinnedListItem[] = [];
  const used = new Set<string>();
  for (const ref of o.order) {
    const key = `${ref.kind}:${ref.id}`;
    if (used.has(key)) continue;
    if (ref.kind === 'conversation') { const c = convById.get(ref.id); if (c) { items.push(convItem(c)); used.add(key); } }
    else if (ref.kind === 'todo') { const t = todoById.get(ref.id); if (t) { items.push({ kind: 'todo', id: t.id, text: t.text, done: false, peerName: peerName(t.directoryId) }); used.add(key); } }
    else { const d = divById.get(ref.id); if (d) { items.push({ kind: 'divider', id: d.id, title: d.title }); used.add(key); } }
  }
  for (const c of convById.values()) if (!used.has(`conversation:${c.id}`)) items.push(convItem(c));
  for (const t of todoById.values()) if (!used.has(`todo:${t.id}`)) items.push({ kind: 'todo', id: t.id, text: t.text, done: false, peerName: peerName(t.directoryId) });
  const history = top.filter((c) => !c.pinned)
    .sort((a, b) => (b.unpinnedAt ?? b.createdAt).localeCompare(a.unpinnedAt ?? a.createdAt))
    .slice(0, HISTORY_LIMIT).map(o.summarise);
  return { items, history };
}
