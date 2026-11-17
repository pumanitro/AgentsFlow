/**
 * Notion-style block selection + drag for the BlockNote notes editor.
 *
 *  - Press in the margin (anywhere that is not row text) and drag → a blue
 *    selection rectangle; every row it touches is selected as a whole row.
 *  - A text selection that spans 2+ rows stays text, and a grab bar appears in
 *    the left margin beside those rows: drag it to move them, click to select.
 *  - Selected rows are painted with a blue overlay (no text highlight).
 *  - Press on any selected row (its text or its ⋮⋮ handle) and drag → all
 *    selected rows travel together: a ghost follows the pointer and a blue line
 *    shows where they will land. Release drops them there in one undo step.
 *  - Clicking the ⋮⋮ handle of an unselected row selects that row.
 *  - Esc / click elsewhere clears · Delete/Backspace removes · ⌘C / ⌘X copy ·
 *    ⇧↑ / ⇧↓ extend · ⌘⇧↑ / ⌘⇧↓ move.
 *
 * Pure overlay: nothing here writes into ProseMirror's DOM (PM would treat that
 * as a mutation). Rows are found by BlockNote's `.bn-block-outer[data-id]`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import { SideMenuExtension } from '@blocknote/core/extensions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

const DRAG_THRESHOLD = 4;
const AUTOSCROLL_EDGE = 40;

interface Rect { top: number; left: number; width: number; height: number }
interface Drop { targetId: string; placement: 'before' | 'after'; lineTop: number; lineLeft: number; lineWidth: number }

type Gesture =
  | { kind: 'idle' }
  | { kind: 'pending-band'; x: number; y: number }
  | { kind: 'band'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'pending-drag'; x: number; y: number; clickBlockId: string | null }
  | { kind: 'drag'; x: number; y: number; drop: Drop | null };

/** tiptap's view getter THROWS before the editor is mounted — never let that reach render. */
function safePmDom(editor: Editor): HTMLElement | undefined {
  try { return editor.prosemirrorView?.dom as HTMLElement | undefined; } catch { return undefined; }
}
function outerOf(el: Element | null): HTMLElement | null {
  return (el?.closest('.bn-block-outer[data-id]') as HTMLElement | null) ?? null;
}
function contentOf(outer: HTMLElement): HTMLElement | null {
  // The row's own content (not its nested children).
  return outer.querySelector(':scope > .bn-block > .bn-block-content') as HTMLElement | null;
}
function allOuters(pm: HTMLElement): HTMLElement[] {
  return Array.from(pm.querySelectorAll('.bn-block-outer[data-id]')) as HTMLElement[];
}
/** Keep only the outermost of the ids (a selected parent already carries its children). */
function outermost(pm: HTMLElement, ids: string[]): string[] {
  const set = new Set(ids);
  return allOuters(pm)
    .filter((o) => set.has(o.dataset.id!))
    .filter((o) => {
      let p = o.parentElement ? outerOf(o.parentElement) : null;
      while (p) { if (set.has(p.dataset.id!)) return false; p = p.parentElement ? outerOf(p.parentElement) : null; }
      return true;
    })
    .map((o) => o.dataset.id!);
}

export function useNotionBlockSelection(editor: Editor, hostRef: React.RefObject<HTMLDivElement | null>) {
  const [selected, setSelectedState] = useState<string[]>([]);
  const selectedRef = useRef<string[]>([]);
  const anchorRef = useRef<string | null>(null);
  const [gesture, setGestureState] = useState<Gesture>({ kind: 'idle' });
  const gestureRef = useRef<Gesture>({ kind: 'idle' });
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const setSelected = useCallback((ids: string[]) => {
    const pm = safePmDom(editor);
    const next = pm ? outermost(pm, ids) : ids;
    selectedRef.current = next;
    setSelectedState(next);
  }, [editor]);
  const setGesture = useCallback((g: Gesture) => { gestureRef.current = g; setGestureState(g); }, []);

  const pmDom = () => safePmDom(editor);

  /** Drop the text caret/selection so typing can't edit rows behind a block selection. */
  const releaseTextSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    (pmDom())?.blur();
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- geometry relative to the host's scrolled content -------------------
  const toHost = useCallback((r: DOMRect): Rect => {
    const host = hostRef.current!;
    const h = host.getBoundingClientRect();
    return { top: r.top - h.top + host.scrollTop, left: r.left - h.left + host.scrollLeft, width: r.width, height: r.height };
  }, [hostRef]);

  const computeDrop = useCallback((clientY: number): Drop | null => {
    const pm = pmDom();
    if (!pm) return null;
    const sel = new Set(selectedRef.current);
    const candidates = allOuters(pm).filter((o) => {
      // Not a selected row and not inside one.
      for (let p: HTMLElement | null = o; p; p = p.parentElement ? outerOf(p.parentElement) : null) {
        if (sel.has(p.dataset.id!)) return false;
      }
      return true;
    });
    let best: { o: HTMLElement; r: DOMRect } | null = null;
    for (const o of candidates) {
      const c = contentOf(o);
      if (!c) continue;
      const r = c.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) { best = { o, r }; break; }
      if (!best || Math.abs(clientY - (r.top + r.height / 2)) < Math.abs(clientY - (best.r.top + best.r.height / 2))) best = { o, r };
    }
    if (!best) return null;
    const placement = clientY < best.r.top + best.r.height / 2 ? 'before' : 'after';
    // After a row that has children → the line goes under the whole subtree.
    const lineRect = placement === 'after' ? best.o.getBoundingClientRect() : best.r;
    const hr = toHost(best.r);
    const y = placement === 'before' ? toHost(best.r).top : toHost(lineRect).top + lineRect.height;
    return { targetId: best.o.dataset.id!, placement, lineTop: y - 1, lineLeft: hr.left, lineWidth: Math.max(hr.width, 120) };
  }, [toHost]); // eslint-disable-line react-hooks/exhaustive-deps

  const moveSelectedTo = useCallback((targetId: string, placement: 'before' | 'after') => {
    const ids = selectedRef.current;
    if (!ids.length || ids.includes(targetId)) return;
    const blocks = ids.map((id) => editor.getBlock(id)).filter(Boolean);
    if (!blocks.length) return;
    let inserted: { id: string }[] = [];
    editor.transact(() => {
      editor.removeBlocks(ids);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inserted = editor.insertBlocks(blocks as any, targetId, placement) as { id: string }[];
    });
    setSelected(inserted.map((b) => b.id));
  }, [editor, setSelected]);

  const moveByOne = useCallback((dir: -1 | 1) => {
    const pm = pmDom();
    const ids = selectedRef.current;
    if (!pm || !ids.length) return;
    // Siblings of the first / last selected row at the same nesting level.
    const edge = pm.querySelector(`.bn-block-outer[data-id="${dir < 0 ? ids[0] : ids[ids.length - 1]}"]`) as HTMLElement | null;
    const sib = (dir < 0 ? edge?.previousElementSibling : edge?.nextElementSibling) as HTMLElement | null;
    if (!sib?.dataset.id) return;
    moveSelectedTo(sib.dataset.id, dir < 0 ? 'before' : 'after');
  }, [moveSelectedTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectionMarkdown = useCallback(async () => {
    const blocks = selectedRef.current.map((id) => editor.getBlock(id)).filter(Boolean);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return editor.blocksToMarkdownLossy(blocks as any);
  }, [editor]);

  // ---- re-measure on scroll / resize / doc change --------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.addEventListener('scroll', bump, { passive: true });
    const ro = new ResizeObserver(bump);
    ro.observe(host);
    const off = editor.onChange(() => {
      // Drop ids whose rows were deleted by an edit.
      const live = selectedRef.current.filter((id) => editor.getBlock(id));
      if (live.length !== selectedRef.current.length) setSelected(live);
      bump();
    });
    return () => { host.removeEventListener('scroll', bump); ro.disconnect(); off?.(); };
  }, [editor, hostRef, bump, setSelected]);

  // ---- text selection over 2+ rows → a grab bar in the left margin --------
  // The text selection itself stays a TEXT selection (partial words stay
  // selectable). Its rows get a bar beside them; dragging the bar moves those
  // rows whole, clicking it turns them into a row selection.
  const [spanIds, setSpanIds] = useState<string[]>([]);
  const spanRef = useRef<string[]>([]);
  useEffect(() => {
    const update = () => {
      let ids: string[] = [];
      try {
        const blocks = editor.getSelection()?.blocks ?? [];
        const pm = pmDom();
        if (blocks.length >= 2 && pm) ids = outermost(pm, blocks.map((b) => b.id));
      } catch { /* not mounted */ }
      if (ids.join() !== spanRef.current.join()) { spanRef.current = ids; setSpanIds(ids); }
    };
    const off = editor.onSelectionChange(update);
    return () => { off?.(); };
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps
  const promoteTextSelection = useCallback(() => {
    const ids = spanRef.current;
    if (ids.length < 2) return false;
    setSelected(ids);
    anchorRef.current = ids[0];
    spanRef.current = []; setSpanIds([]);
    releaseTextSelection();
    return true;
  }, [setSelected, releaseTextSelection]);

  // ---- pointer handling ---------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const sideMenu = editor.getExtension(SideMenuExtension);

    const isInteractive = (t: Element) =>
      !!t.closest('button, a, input, textarea, select, [contenteditable="false"], .bn-formatting-toolbar, .bn-toolbar, [role="menu"], [role="dialog"] .bn-menu, .bn-file-block-content-wrapper');

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const t = e.target as Element;
      const pm = pmDom();
      if (!pm) return;

      // ⋮⋮ handle: always drag through us so a whole selection travels.
      if (t.closest('.bn-notion-spanbar')) {
        e.preventDefault();
        if (promoteTextSelection()) setGesture({ kind: 'pending-drag', x: e.clientX, y: e.clientY, clickBlockId: null });
        return;
      }
      const handle = t.closest('.bn-side-menu [draggable="true"]');
      if (handle) {
        const hovered = sideMenu?.store.state?.block?.id as string | undefined;
        if (!hovered) return;
        e.preventDefault(); // no native HTML5 drag; a plain click still opens the menu
        // The handle sits on top of the span bar: grabbing it on one of the
        // text-selected rows carries all of them, same as the bar.
        if (spanRef.current.includes(hovered)) promoteTextSelection();
        else if (!selectedRef.current.includes(hovered)) { setSelected([hovered]); anchorRef.current = hovered; }
        releaseTextSelection();
        setGesture({ kind: 'pending-drag', x: e.clientX, y: e.clientY, clickBlockId: null });
        return;
      }
      if (t.closest('.bn-side-menu') || isInteractive(t)) return;

      const outer = outerOf(t);
      const inSelected = outer && selectedRef.current.some((id) => {
        for (let p: HTMLElement | null = outer; p; p = p.parentElement ? outerOf(p.parentElement) : null) if (p.dataset.id === id) return true;
        return false;
      });
      if (inSelected) {
        e.preventDefault();
        setGesture({ kind: 'pending-drag', x: e.clientX, y: e.clientY, clickBlockId: outer!.dataset.id! });
        return;
      }

      // Inside row text → normal editing; that also clears a block selection.
      if (t.closest('.bn-inline-content') || (t.closest('.bn-block-content') && pm.contains(t))) {
        if (selectedRef.current.length) setSelected([]);
        return;
      }
      // Margin / gutter / empty space → selection rectangle.
      if (!host.contains(t)) return;
      e.preventDefault();
      if (!e.shiftKey) setSelected([]);
      releaseTextSelection();
      setGesture({ kind: 'pending-band', x: e.clientX, y: e.clientY });
    };

    const bandSelect = (x0: number, y0: number, x1: number, y1: number) => {
      const pm = pmDom();
      if (!pm) return;
      const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
      const hit: string[] = [];
      for (const o of allOuters(pm)) {
        const c = contentOf(o);
        if (!c) continue;
        const r = c.getBoundingClientRect();
        if (r.bottom > top && r.top < bottom) hit.push(o.dataset.id!);
      }
      void x0; void x1; // Notion selects by vertical overlap anywhere across the page width.
      setSelected(hit);
      anchorRef.current = hit[0] ?? null;
    };

    const autoScroll = (clientY: number) => {
      const r = host.getBoundingClientRect();
      if (clientY < r.top + AUTOSCROLL_EDGE) host.scrollTop -= 12;
      else if (clientY > r.bottom - AUTOSCROLL_EDGE) host.scrollTop += 12;
    };

    const onMouseMove = (e: MouseEvent) => {
      const g = gestureRef.current;
      if (g.kind === 'idle') return;
      if (g.kind === 'pending-band' || g.kind === 'pending-drag') {
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_THRESHOLD) return;
        if (g.kind === 'pending-band') setGesture({ kind: 'band', x0: g.x, y0: g.y, x1: e.clientX, y1: e.clientY });
        else setGesture({ kind: 'drag', x: e.clientX, y: e.clientY, drop: computeDrop(e.clientY) });
        document.body.classList.add('bn-notion-dragging');
        return;
      }
      e.preventDefault();
      autoScroll(e.clientY);
      if (g.kind === 'band') {
        bandSelect(g.x0, g.y0, e.clientX, e.clientY);
        setGesture({ ...g, x1: e.clientX, y1: e.clientY });
      } else if (g.kind === 'drag') {
        setGesture({ kind: 'drag', x: e.clientX, y: e.clientY, drop: computeDrop(e.clientY) });
      }
    };

    const onMouseUp = () => {
      const g = gestureRef.current;
      document.body.classList.remove('bn-notion-dragging');
      if (g.kind === 'idle') return;
      setGesture({ kind: 'idle' });
      if (g.kind === 'drag' && g.drop) moveSelectedTo(g.drop.targetId, g.drop.placement);
      else if (g.kind === 'pending-drag' && g.clickBlockId) {
        // Plain click on a selected row → back to editing that row (like Notion).
        const id = g.clickBlockId;
        setSelected([]);
        try { editor.setTextCursorPosition(id, 'end'); editor.focus(); } catch { /* non-text block */ }
      }
    };

    host.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
    // Never let a native HTML5 drag start from inside a block selection.
    const onDragStart = (e: DragEvent) => { if (gestureRef.current.kind !== 'idle') e.preventDefault(); };
    host.addEventListener('dragstart', onDragStart, true);
    return () => {
      host.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      host.removeEventListener('dragstart', onDragStart, true);
    };
  }, [editor, hostRef, computeDrop, moveSelectedTo, promoteTextSelection, releaseTextSelection, setGesture, setSelected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- keyboard while rows are selected -----------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ids = selectedRef.current;
      if (!ids.length) return;
      const mod = e.metaKey || e.ctrlKey;
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (e.key === 'Escape') { stop(); setSelected([]); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        stop();
        const pm = pmDom();
        const after = pm?.querySelector(`.bn-block-outer[data-id="${ids[ids.length - 1]}"]`)?.nextElementSibling as HTMLElement | null;
        editor.removeBlocks(ids);
        setSelected([]);
        if (after?.dataset.id) { try { editor.setTextCursorPosition(after.dataset.id, 'start'); editor.focus(); } catch { /* ignore */ } }
        return;
      }
      if (mod && (e.key === 'c' || e.key === 'x')) {
        stop();
        const cut = e.key === 'x';
        void selectionMarkdown().then((md) => navigator.clipboard.writeText(md)).then(() => {
          if (cut) { editor.removeBlocks(selectedRef.current); setSelected([]); }
        });
        return;
      }
      if (mod && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { stop(); moveByOne(e.key === 'ArrowUp' ? -1 : 1); return; }
      if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        stop();
        const pm = pmDom();
        if (!pm) return;
        const order = allOuters(pm).filter((o) => outermost(pm, [o.dataset.id!]).length).map((o) => o.dataset.id!);
        const anchor = anchorRef.current ?? ids[0];
        const head = anchor === ids[0] ? ids[ids.length - 1] : ids[0];
        const hi = order.indexOf(head) + (e.key === 'ArrowUp' ? -1 : 1);
        if (hi < 0 || hi >= order.length) return;
        const ai = order.indexOf(anchor);
        setSelected(order.slice(Math.min(ai, hi), Math.max(ai, hi) + 1));
        return;
      }
      if (e.key.length === 1 && !mod) {
        // Typing over a block selection: just leave block mode (no destructive replace).
        setSelected([]);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editor, moveByOne, promoteTextSelection, selectionMarkdown, setSelected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- overlay ------------------------------------------------------------
  // Measured during render (no state → no update loop); scroll / resize / doc
  // changes bump a render, so these stay current.
  const rects: Rect[] = [];
  {
    const pm = pmDom();
    if (pm && hostRef.current) {
      for (const id of selected) {
        const o = pm.querySelector(`.bn-block-outer[data-id="${id}"]`) as HTMLElement | null;
        if (o) rects.push(toHost(o.getBoundingClientRect()));
      }
    }
  }

  const ghostRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    // Clone the selected rows into the ghost once per drag.
    const g = ghostRef.current;
    if (!g || gesture.kind !== 'drag' || g.childElementCount) return;
    const pm = pmDom();
    for (const id of selectedRef.current) {
      const o = pm?.querySelector(`.bn-block-outer[data-id="${id}"]`);
      if (o) g.appendChild(o.cloneNode(true));
    }
  }, [gesture.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const host = hostRef.current;
  const hostBox = host?.getBoundingClientRect();
  let spanBar: Rect | null = null;
  if (!selected.length && spanIds.length >= 2) {
    const pm = pmDom();
    const first = pm?.querySelector(`.bn-block-outer[data-id="${spanIds[0]}"]`) as HTMLElement | null;
    const last = pm?.querySelector(`.bn-block-outer[data-id="${spanIds[spanIds.length - 1]}"]`) as HTMLElement | null;
    const fc = first && contentOf(first);
    if (first && last && fc && hostRef.current) {
      const a = toHost(fc.getBoundingClientRect());
      const b = toHost(last.getBoundingClientRect());
      spanBar = { top: a.top, left: a.left - 22, width: 8, height: b.top + b.height - a.top };
    }
  }
  const overlay = (
    <div className="bn-notion-layer" aria-hidden="true">
      {spanBar && (
        <div
          className="bn-notion-spanbar"
          title={`Drag to move these ${spanIds.length} rows · click to select them`}
          style={{ top: spanBar.top, left: spanBar.left, width: spanBar.width, height: spanBar.height }}
        />
      )}
      {rects.map((r, i) => (
        <div key={i} className="bn-notion-selected" style={{ top: r.top, left: r.left, width: r.width, height: r.height }} />
      ))}
      {gesture.kind === 'band' && hostBox && host && (
        <div
          className="bn-notion-band"
          style={{
            left: Math.min(gesture.x0, gesture.x1) - hostBox.left + host.scrollLeft,
            top: Math.min(gesture.y0, gesture.y1) - hostBox.top + host.scrollTop,
            width: Math.abs(gesture.x1 - gesture.x0),
            height: Math.abs(gesture.y1 - gesture.y0),
          }}
        />
      )}
      {gesture.kind === 'drag' && gesture.drop && (
        <div className="bn-notion-dropline" style={{ top: gesture.drop.lineTop, left: gesture.drop.lineLeft, width: gesture.drop.lineWidth }} />
      )}
    </div>
  );
  const ghost = gesture.kind === 'drag' ? (
    <div className="bn-notion-ghost bn-container" style={{ left: gesture.x + 12, top: gesture.y + 8 }}>
      <div ref={ghostRef} className="bn-notion-ghost-rows" />
      {selected.length > 1 && <span className="bn-notion-ghost-count">{selected.length}</span>}
    </div>
  ) : null;

  return { overlay, ghost, selectedIds: selected, clear: () => setSelected([]) };
}

/** Styles for the overlay. Injected once; Notion-blue tuned for the dark editor. */
export const NOTION_SELECTION_CSS = `
.blocknote-host { position: relative; }
.bn-notion-layer { position: absolute; inset: 0 auto auto 0; width: 0; height: 0; pointer-events: none; z-index: 3; }
.bn-notion-selected { position: absolute; background: rgba(35, 131, 226, 0.28); border-radius: 4px; box-shadow: inset 0 0 0 1px rgba(35,131,226,.35); }
.bn-notion-spanbar { position: absolute; pointer-events: auto; cursor: grab; background: #7c6cf2; border-radius: 4px; opacity: .9;
  background-image: radial-gradient(circle, rgba(255,255,255,.75) 1px, transparent 1.4px); background-size: 4px 4px; background-repeat: repeat-y; background-position: 0 6px; }
.bn-notion-spanbar:hover { opacity: 1; box-shadow: 0 0 0 2px rgba(124,108,242,.35); }
.bn-notion-band { position: absolute; background: rgba(35, 131, 226, 0.14); border: 1px solid rgba(35, 131, 226, 0.7); border-radius: 2px; }
.bn-notion-dropline { position: absolute; height: 4px; margin-top: -2px; background: rgba(35, 131, 226, 0.95); border-radius: 2px; }
.bn-notion-ghost { position: fixed; z-index: 1000; pointer-events: none; max-width: 520px;
  background: #262a33; border: 1px solid rgba(35,131,226,.6); border-radius: 6px; box-shadow: 0 10px 28px rgba(0,0,0,.55); padding: 4px 10px; }
.bn-notion-ghost-rows { max-height: 240px; overflow: hidden; opacity: .85; }
.bn-notion-ghost-count { position: absolute; top: -8px; right: -8px; background: #2383e2; color: #fff; font: 600 11px/18px system-ui; min-width: 18px; padding: 0 5px; border-radius: 9px; text-align: center; }
body.bn-notion-dragging, body.bn-notion-dragging * { cursor: grabbing !important; user-select: none !important; }
`;
