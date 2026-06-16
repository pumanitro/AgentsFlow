import { Conversation } from '../../shared/types';

/**
 * Tailwind background class for a conversation's status dot.
 * - When marked done (unpinned), always shows the muted/archived gray —
 *   UNLESS `treatAsLive` is set (delegated peer rows are intentionally unpinned
 *   for UI placement but should still reflect their real state: blue=working,
 *   amber=blocked, green=done).
 * - Otherwise reflects Claude's live state.
 */
export function statusDotClass(
  c: Pick<Conversation, 'pinned' | 'state' | 'status'>,
  treatAsLive = false,
): string {
  if (!treatAsLive && !c.pinned) return 'bg-subtle';
  const { state, status } = c;
  if (state === 'working' || status === 'working') return 'bg-info animate-pulse';
  if (state === 'needs-input' || state === 'blocked' || status === 'needs-input') return 'bg-warn animate-pulse';
  if (state === 'done' || state === 'completed' || status === 'completed') return 'bg-ok';
  if (state === 'failed' || status === 'failed') return 'bg-err';
  if (state === 'starting') return 'bg-muted animate-pulse';
  return 'bg-muted';
}
