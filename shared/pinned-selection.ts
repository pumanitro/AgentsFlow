import type { PinnedItemRef } from './types';

/** Stable identity of a pinned row across conversations, tasks and separators. */
export function refKey(r: PinnedItemRef): string {
  return `${r.kind}:${r.id}`;
}

/**
 * Move a set of pinned refs — keeping their existing relative order — so they
 * land immediately before index `dropIdx` of the CURRENT order. One moving row
 * or twenty go through the same path. Returns null when the result is a no-op.
 */
export function moveRefsTo(
  order: PinnedItemRef[],
  movingKeys: Set<string>,
  dropIdx: number,
): PinnedItemRef[] | null {
  const moving = order.filter((r) => movingKeys.has(refKey(r)));
  if (moving.length === 0) return null;
  const rest = order.filter((r) => !movingKeys.has(refKey(r)));
  // Rows removed from above the drop point shift the insertion index left.
  const removedBefore = order.slice(0, dropIdx).filter((r) => movingKeys.has(refKey(r))).length;
  const insertAt = Math.max(0, Math.min(rest.length, dropIdx - removedBefore));
  const next = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
  if (next.every((r, i) => refKey(r) === refKey(order[i]))) return null;
  return next;
}

/**
 * The drop index that nudges a selected block one row up or down: it hops the
 * nearest row that is NOT part of the block, so a scattered selection collapses
 * against it instead of jumping the gap. Returns null at the ends of the list.
 */
export function blockStepDropIndex(
  orderKeys: string[],
  movingKeys: Set<string>,
  direction: 'up' | 'down',
): number | null {
  const idxs = orderKeys.map((k, i) => (movingKeys.has(k) ? i : -1)).filter((i) => i >= 0);
  if (idxs.length === 0) return null;
  const min = idxs[0];
  const max = idxs[idxs.length - 1];
  if (direction === 'up') return min === 0 ? null : min - 1;
  return max === orderKeys.length - 1 ? null : max + 2;
}

/** A row's box in viewport coordinates, as reported by getBoundingClientRect. */
export interface RowBox {
  key: string;
  top: number;
  bottom: number;
}

/**
 * Which rows a rubber-band rectangle has caught. Rows are full-width bands, so
 * only the vertical overlap decides — dragging left or right never changes the
 * result, and a band that merely touches an edge (zero overlap) is not caught.
 */
export function marqueeHits(rows: RowBox[], top: number, bottom: number): Set<string> {
  const lo = Math.min(top, bottom);
  const hi = Math.max(top, bottom);
  const hit = new Set<string>();
  for (const r of rows) {
    if (r.top < hi && r.bottom > lo) hit.add(r.key);
  }
  return hit;
}
