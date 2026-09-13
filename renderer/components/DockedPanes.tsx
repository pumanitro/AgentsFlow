import { CSSProperties, ReactNode, useCallback, useEffect, useRef, useState } from 'react';

// The bottom utility cluster shared by both sidebars: Accounts, Usage, Notes —
// in that order, Notes last, always on screen.
//
// Why this is measured rather than left to flexbox. Each pane caps its own body
// in viewport units (45vh + 30vh + 25vh), so on any normal window the three of
// them together ask for more than the whole column. Flex-shrink heuristics were
// tried first and kept losing the last pane by a few pixels: a pane can refuse
// to shrink (a one-line Usage error has nothing to give), fractional chrome
// heights round the wrong way, and whatever is left over is clipped off the
// BOTTOM — which is exactly where Notes lives. So the cluster is given a real
// budget instead, computed from measured heights, and handed to the panes as a
// CSS custom property.
//
// The contract, in order of who gives way first:
//   1. the top region (peers list / file tree) shrinks to TOP_REGION_MIN and
//      scrolls inside itself,
//   2. then the OPEN Accounts/Usage bodies shrink and scroll inside themselves,
//      splitting what is left, down to header-only,
//   3. Notes never gives way.
//
// The one degenerate case — a column too short even for Notes plus three
// headers — is covered by --dock-notes-max, which lets the Notes LIST scroll
// rather than letting the pane be clipped. Its header is never lost.

// How much of the top region (peer list / file tree) must survive. The panels'
// own chrome rows sitting inside that scroller (see `topRegionInsetRefs`) are
// added on top of this, so 100px always means 100px of actual list.
export const TOP_REGION_MIN = 100;

// The cluster publishes this budget to the panes; the column publishes the top
// region's floor to its own flexible child.
export const DOCK_BODY_MAX_VAR = '--dock-body-max';
export const DOCK_NOTES_MAX_VAR = '--dock-notes-max';
export const DOCK_TOP_MIN_VAR = '--dock-top-min';

// A pane says whether it is open with `data-open` on its root. Measuring it
// instead ("taller than its header") had a trap that showed up as "Accounts /
// Usage sometimes will not open": with both panes closed the budget was 0, the
// pane the user then opened rendered its body at 0px, measured as closed, and
// was budgeted 0 again — a lock nothing but a window resize could break. The
// height check is kept only for a pane that does not declare itself; the
// epsilon keeps sub-pixel rounding from flipping that count.
const OPEN_EPSILON = 3;
// Only used before the first measurement, or if a pane ever renders without a
// header element: the three panes' headers are all one `px-2 py-2` row.
const FALLBACK_HEADER = 34;

type ElRef = { readonly current: HTMLElement | null };

interface Props {
  // The flex column that holds the top region, any fixed chrome rows, and this
  // cluster. Measured for the total height, and carries DOCK_TOP_MIN_VAR.
  columnRef: ElRef;
  // The one flexible child of that column — the peers list on home, the file
  // tree in the session view. Must be `flex-1 min-h-0 overflow-y-auto` with
  // `style={{ minHeight: 'var(--dock-top-min, 100px)' }}`.
  topRegionRef: ElRef;
  // Chrome rows that live INSIDE the top region's scroller (home's sticky
  // "Tracked Peers" header, the search box, the add-directory button). They are
  // measured and added to the top region's floor so the 100px minimum is 100px
  // of peers, not 100px of header. Elements outside the scroller need no ref —
  // every other child of the column is measured automatically.
  topRegionInsetRefs?: ReadonlyArray<ElRef>;
  topRegionMin?: number;
  accounts: ReactNode;
  usage: ReactNode;
  notes: ReactNode;
}

// Height including vertical margins — chrome rows in the home sidebar carry
// `mb-2`, which getBoundingClientRect does not report.
function outerHeight(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  // Fixed/absolute children (context menus, modals) are out of flow and cost
  // the column nothing, however tall they measure.
  if (cs.position === 'fixed' || cs.position === 'absolute') return 0;
  return el.getBoundingClientRect().height
    + (parseFloat(cs.marginTop) || 0)
    + (parseFloat(cs.marginBottom) || 0);
}

function px(el: HTMLElement, ...props: Array<keyof CSSStyleDeclaration & string>): number {
  const cs = getComputedStyle(el);
  let total = 0;
  for (const p of props) total += parseFloat(String(cs[p])) || 0;
  return total;
}

interface Budget {
  // Ceiling for an open Accounts/Usage body, or null while unmeasured (the
  // panes then use their own viewport-unit caps, exactly as before).
  bodyMax: number | null;
  // Ceiling for the Notes list. Only set in the degenerate case where the
  // column cannot even fit Notes plus three headers.
  notesMax: number | null;
  topMin: number;
}

export interface DockMeasurements {
  // Content height of the column that the top region and the cluster share.
  columnInner: number;
  // Every other child of that column: mode bar, summary line, filter row,
  // worktree list. All shrink-0, so this never moves with the budget.
  chrome: number;
  // The top region's own vertical padding plus any rows that scroll with it but
  // are not part of its list.
  inset: number;
  topRegionMin: number;
  // Cluster padding + border + the gaps between its three children.
  clusterExtra: number;
  accountsHeader: number;
  usageHeader: number;
  notesHeader: number;
  // Notes at its natural height — header plus its list, already capped at 25vh.
  notesHeight: number;
  // How many of Accounts/Usage are expanded: 0, 1 or 2.
  openPanes: number;
}

// The budget, in one place and free of the DOM so it can be reasoned about and
// exercised directly.
//
//   clusterFloor = notesHeight + accountsHeader + usageHeader + clusterExtra
//   topMin       = clamp(topRegionMin + inset, 0, columnInner − chrome − clusterFloor)
//   available    = max(0, columnInner − chrome − topMin)
//   slack        = available − clusterFloor
//   bodyMax      = max(0, floor(slack / max(1, openPanes)))
//   notesMax     = slack < 0 ? max(notesHeader, available − headers − clusterExtra) : none
//
// With no pane open, bodyMax is what ONE pane would get rather than 0, so the
// next pane to open has a real budget in the very frame it opens (see the
// `data-open` note above). The column then sums exactly: chrome + topMin +
// clusterFloor + openPanes × bodyMax === columnInner whenever slack ≥ 0, and
// chrome + 0 + available === columnInner when it is not.
// Measured heights carry fractions (38.5px headers, 2px cluster border, a
// scrollbar that appears once a body scrolls), and a budget that sums to the
// column exactly overflowed it by 4–7 px in practice (12 Sep 2026). This margin
// is what keeps Notes' bottom edge inside the column.
export const DOCK_SAFETY = 10;

export function computeDockBudget(m: DockMeasurements): Budget {
  const clusterFloor = m.notesHeight + m.accountsHeader + m.usageHeader + m.clusterExtra;
  const usable = m.columnInner - DOCK_SAFETY;
  // The top region's floor is itself given up — last — when the column is too
  // short to pay for both it and the cluster floor.
  const topMin = Math.max(0, Math.min(m.topRegionMin + m.inset, usable - m.chrome - clusterFloor));
  const available = Math.max(0, usable - m.chrome - topMin);
  const slack = available - clusterFloor;
  return {
    bodyMax: Math.max(0, Math.floor(slack / Math.max(1, m.openPanes))),
    // Only when even the floor does not fit: cap the Notes LIST so it scrolls
    // inside itself instead of being clipped off the bottom of the column.
    notesMax: slack < 0
      ? Math.max(m.notesHeader, Math.floor(available - m.accountsHeader - m.usageHeader - m.clusterExtra))
      : null,
    topMin: Math.round(topMin),
  };
}

export default function DockedPanes({
  columnRef,
  topRegionRef,
  topRegionInsetRefs,
  topRegionMin = TOP_REGION_MIN,
  accounts,
  usage,
  notes,
}: Props) {
  const clusterRef = useRef<HTMLDivElement | null>(null);
  const [budget, setBudget] = useState<Budget>({ bodyMax: null, notesMax: null, topMin: topRegionMin });
  const budgetRef = useRef(budget);
  budgetRef.current = budget;

  const measure = useCallback(() => {
    const column = columnRef.current;
    const cluster = clusterRef.current;
    if (!column || !cluster) return;

    const columnInner = column.getBoundingClientRect().height
      - px(column, 'paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth');
    if (columnInner <= 0) return;

    // Everything in the column that is neither the flexible top region nor this
    // cluster: mode bar, summary line, filter row, worktree list. All of them
    // are shrink-0 with content-determined heights, so this figure does not
    // move when the budget below changes — no feedback loop.
    const top = topRegionRef.current;
    let chrome = 0;
    for (const child of Array.from(column.children)) {
      if (child === cluster || child === top) continue;
      chrome += outerHeight(child as HTMLElement);
    }
    // Everything the top region spends on something other than its own list —
    // its own vertical padding, plus the rows that scroll with the list but are
    // not part of it. Added to the floor so 100px means 100px of list.
    let inset = top ? px(top, 'paddingTop', 'paddingBottom') : 0;
    for (const ref of topRegionInsetRefs ?? []) {
      if (ref.current) inset += outerHeight(ref.current);
    }

    const kids = Array.from(cluster.children) as HTMLElement[];
    if (kids.length < 3) return;
    const [accountsEl, usageEl, notesEl] = kids;
    const headerOf = (el: HTMLElement) => {
      const head = el.firstElementChild as HTMLElement | null;
      return head ? head.getBoundingClientRect().height : FALLBACK_HEADER;
    };
    const heightOf = (el: HTMLElement) => el.getBoundingClientRect().height;
    const accountsHeader = headerOf(accountsEl);
    const usageHeader = headerOf(usageEl);
    const notesHeader = headerOf(notesEl);
    const notesHeight = heightOf(notesEl);
    const isOpen = (el: HTMLElement, header: number) => {
      const declared = el.dataset.open;
      if (declared !== undefined) return declared === '1';
      return heightOf(el) > header + OPEN_EPSILON;
    };
    const openPanes = (isOpen(accountsEl, accountsHeader) ? 1 : 0) + (isOpen(usageEl, usageHeader) ? 1 : 0);

    // The cluster's own padding, border and the two gaps between its three
    // children — constant, but read from the stylesheet rather than guessed.
    const gaps = (parseFloat(getComputedStyle(cluster).rowGap) || 0) * (kids.length - 1);
    const clusterExtra = px(cluster, 'paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth') + gaps;

    const next = computeDockBudget({
      columnInner,
      chrome,
      inset,
      topRegionMin,
      clusterExtra,
      accountsHeader,
      usageHeader,
      notesHeader,
      notesHeight,
      openPanes,
    });

    column.style.setProperty(DOCK_TOP_MIN_VAR, `${next.topMin}px`);
    const prev = budgetRef.current;
    if (prev.bodyMax !== next.bodyMax || prev.notesMax !== next.notesMax || prev.topMin !== next.topMin) {
      setBudget(next);
    }
  }, [columnRef, topRegionRef, topRegionInsetRefs, topRegionMin]);

  useEffect(() => {
    const column = columnRef.current;
    const cluster = clusterRef.current;
    if (!column || !cluster || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    // Re-attached whenever a row appears or disappears (the diff summary line,
    // the worktree section, a pane's body opening) so the set of observed
    // elements always matches what is actually in the column.
    const attach = () => {
      ro.disconnect();
      ro.observe(column);
      ro.observe(cluster);
      for (const child of Array.from(column.children)) ro.observe(child);
      for (const child of Array.from(cluster.children)) ro.observe(child);
      for (const ref of topRegionInsetRefs ?? []) if (ref.current) ro.observe(ref.current);
      measure();
    };
    attach();
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(attach) : null;
    mo?.observe(column, { childList: true });
    // `data-open` flips are watched too: a pane opening from the all-closed
    // state must be re-budgeted at once, not whenever its 0px body happens to
    // move a pixel.
    mo?.observe(cluster, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-open'] });
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      mo?.disconnect();
      window.removeEventListener('resize', measure);
      column.style.removeProperty(DOCK_TOP_MIN_VAR);
    };
  }, [columnRef, topRegionInsetRefs, measure]);

  // Unmeasured panes fall back to 100vh, which leaves their own caps in charge —
  // so the panels look exactly as they did before this component existed.
  const style: CSSProperties = {};
  if (budget.bodyMax !== null) (style as Record<string, string>)[DOCK_BODY_MAX_VAR] = `${budget.bodyMax}px`;
  if (budget.notesMax !== null) (style as Record<string, string>)[DOCK_NOTES_MAX_VAR] = `${budget.notesMax}px`;

  return (
    // `shrink-0`: the cluster never gives way to flexbox. Its height is what the
    // budget above decided, and it sums with the chrome and the top region's
    // floor to exactly the column height.
    <div
      ref={clusterRef}
      className="shrink-0 min-h-0 flex flex-col gap-2 px-2 py-2 border-t-2 border-border bg-bg overflow-hidden shadow-[0_-10px_18px_-10px_rgba(0,0,0,0.7)]"
      style={style}
    >
      {accounts}
      {usage}
      {notes}
    </div>
  );
}
