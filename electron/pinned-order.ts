/**
 * Pure helpers for arranging the pinned-order list. Deliberately dependency-free
 * (only a type-only import) so it can be unit-tested without pulling in Electron.
 *
 * The pinned list is a flat array of refs where `divider` rows act as *section
 * headers*: a divider heads the run of conversations beneath it, up to the next
 * divider (or the end of the list). The "first separated list" the UI talks about
 * is the group of conversations under the first divider.
 */
import type { PinnedItemRef } from '../shared/types';

function sameRef(a: PinnedItemRef, b: PinnedItemRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * Place `ref` at the BOTTOM of the first section — i.e. as the last item of the
 * group headed by the first divider, just before the second divider. Falls back
 * to the very end of the list when there is one divider or none.
 *
 * Any pre-existing copy of `ref` is removed first, so this doubles as a move.
 */
export function placePinnedRefAtEndOfFirstSection(
  order: PinnedItemRef[],
  ref: PinnedItemRef,
): PinnedItemRef[] {
  const without = order.filter((r) => !sameRef(r, ref));

  const firstDividerIdx = without.findIndex((r) => r.kind === 'divider');
  // No divider heads a section yet → the whole list is the first section; the
  // new row lands at the very bottom of it.
  if (firstDividerIdx < 0) {
    return [...without, ref];
  }

  // The first section runs from just after the first divider up to the next
  // divider (or the end of the list). Insert right before that boundary.
  const secondDividerIdx = without.findIndex(
    (r, i) => i > firstDividerIdx && r.kind === 'divider',
  );
  const insertAt = secondDividerIdx < 0 ? without.length : secondDividerIdx;

  return [...without.slice(0, insertAt), ref, ...without.slice(insertAt)];
}

/**
 * Place `ref` immediately AFTER `anchor`, keeping it in the anchor's section —
 * e.g. a forked chat lands directly below its source. Any pre-existing copy of
 * `ref` is removed first, so this doubles as a move. When the anchor isn't in
 * the list, falls back to the end of the first section.
 */
export function placePinnedRefAfter(
  order: PinnedItemRef[],
  ref: PinnedItemRef,
  anchor: PinnedItemRef,
): PinnedItemRef[] {
  const without = order.filter((r) => !sameRef(r, ref));
  const anchorIdx = without.findIndex((r) => sameRef(r, anchor));
  if (anchorIdx < 0) return placePinnedRefAtEndOfFirstSection(order, ref);
  return [...without.slice(0, anchorIdx + 1), ref, ...without.slice(anchorIdx + 1)];
}
