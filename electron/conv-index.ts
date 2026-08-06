/**
 * Identity-keyed id→position index.
 *
 * Looking a conversation up by id used to be a `findIndex` over the whole list.
 * That list is all of history (1500+ entries here), and the lookup sits on the
 * hottest path in the app: every state.json write from every live background
 * daemon resolves one. With a fleet of agents running, that linear scan happens
 * many times a second and its cost grows with history the user will never look
 * at again — the exact shape of slowdown this indexer exists to remove.
 *
 * Memoization is keyed on the ARRAY'S IDENTITY, not a version counter, because
 * that is precisely the invariant the store already maintains: every mutation
 * that moves elements around (add / remove / filter / map) assigns a brand-new
 * array, while an in-place field update (`arr[i] = {...arr[i], ...patch}`)
 * leaves every position exactly where it was. So a reference check is not an
 * approximation of "did positions change" — it is the same question.
 *
 * The consequence worth stating plainly: an in-place *reorder* of the same array
 * object (`arr.sort()`, `arr.reverse()`) would leave the index stale, and the
 * caller would patch the wrong entry. Callers must replace the array instead.
 */
export function makeIndexer<T extends { id: string }>(): (items: T[]) => Map<string, number> {
  let cached: Map<string, number> | null = null;
  let cachedFor: T[] | null = null;
  return (items: T[]): Map<string, number> => {
    if (cached && cachedFor === items) return cached;
    const m = new Map<string, number>();
    for (let i = 0; i < items.length; i++) m.set(items[i].id, i);
    cached = m;
    cachedFor = items;
    return m;
  };
}
