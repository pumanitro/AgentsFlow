// Conversation → wire `ConversationSummary`, plus list ordering and filters.
// Pure; no electron import.
import type { Conversation, PinnedItemRef, TrackedDirectory } from '../../shared/types';
import type { ConversationSummary } from '../../shared/mobile';
import type { ClaudeAgentJsonRow, JobState } from '../claude-cli';
import { deriveDescription, deriveLiveDescription, effectiveState, reconcileLiveState } from '../derive-state';
import { jobIsBlocked, normalizeState } from './job-state';

const UNPINNED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UNPINNED_MAX = 50;

export function toSummary(conv: Conversation, dirs: TrackedDirectory[], row: ClaudeAgentJsonRow | undefined, job: JobState | null, updatedAtMs: number): ConversationSummary {
  const peerName = dirs.find((d) => d.id === conv.directoryId)?.displayName ?? conv.displayName ?? '?';
  const rawState = (row
    ? reconcileLiveState(row, job) ?? conv.state
    : (job ? effectiveState(job) ?? conv.state : conv.state)) ?? '';
  const blocked = jobIsBlocked(job) || (row?.status || '').toLowerCase() === 'waiting';
  const state = normalizeState(rawState, blocked);
  const liveDetail = row ? deriveLiveDescription(row, job) : job ? deriveDescription(job) : conv.description;
  const updatedMs = updatedAtMs || Date.parse(conv.createdAt);
  const summary: ConversationSummary = {
    id: conv.id,
    peerId: conv.directoryId,
    peerName,
    title: conv.title || conv.lastPrompt?.slice(0, 80) || 'Untitled chat',
    detail: liveDetail || conv.description || '',
    state,
    rawState,
    needsYou: state === 'blocked',
    pinned: !!conv.pinned,
    provider: conv.provider === 'codex' ? 'codex' : 'claude',
    chatKind: conv.chatKind ?? 'chat',
    createdAt: conv.createdAt,
    updatedAt: new Date(Number.isFinite(updatedMs) ? updatedMs : 0).toISOString(),
    hasSession: !!conv.sessionId,
  };
  if (conv.unpinnedAt) summary.unpinnedAt = conv.unpinnedAt;
  if (conv.delegatedByConversationId) summary.delegatedBy = conv.delegatedByConversationId;
  if (conv.host) summary.host = conv.host;
  return summary;
}

function ms(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export function orderSummaries(list: ConversationSummary[], pinnedOrder: PinnedItemRef[], nowMs: number): ConversationSummary[] {
  const pinned = list.filter((s) => s.pinned);
  const byId = new Map(pinned.map((s) => [s.id, s] as const));
  const ordered: ConversationSummary[] = [];
  const seen = new Set<string>();
  for (const ref of pinnedOrder) {
    if (ref.kind !== 'conversation') continue;
    const s = byId.get(ref.id);
    if (s && !seen.has(s.id)) { ordered.push(s); seen.add(s.id); }
  }
  const missing = pinned.filter((s) => !seen.has(s.id))
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  const unpinned = list
    .filter((s) => !s.pinned && s.unpinnedAt && nowMs - ms(s.unpinnedAt) <= UNPINNED_WINDOW_MS)
    .sort((a, b) => ms(b.unpinnedAt) - ms(a.unpinnedAt))
    .slice(0, UNPINNED_MAX);
  return [...missing, ...ordered, ...unpinned];
}

export function filterSummaries(list: ConversationSummary[], filter: string | null, peerId: string | null): ConversationSummary[] {
  let out = list;
  switch (filter) {
    case 'needs': out = out.filter((s) => s.needsYou); break;
    case 'working': out = out.filter((s) => s.state === 'working' || s.state === 'starting'); break;
    case 'done': out = out.filter((s) => s.state === 'done' || s.state === 'failed' || !s.pinned); break;
    default: break;
  }
  if (peerId) out = out.filter((s) => s.peerId === peerId);
  return out;
}
