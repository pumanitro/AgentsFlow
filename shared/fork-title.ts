// Title for a forked conversation: version-prefix the source title so forks
// read as iterations of the same task in the pinned list.
//   "Fix the parser"      → "V2 · Fix the parser"
//   "V2 · Fix the parser" → "V3 · Fix the parser"   (re-forking bumps the
// version instead of stacking prefixes.)
const VERSION_PREFIX = /^V(\d+) · /;

export function forkTitle(srcTitle: string): string {
  const base = (srcTitle || 'forked chat').trim();
  const m = base.match(VERSION_PREFIX);
  const version = m ? Number(m[1]) + 1 : 2;
  const bare = m ? base.slice(m[0].length) : base;
  return `V${version} · ${bare}`.slice(0, 80);
}
