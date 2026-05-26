import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '../lib/ipc';

const Terminal = dynamic(() => import('./Terminal'), { ssr: false });

export type ShellLeafNode = { kind: 'leaf'; id: string; cwd: string };
export type ShellNode =
  | ShellLeafNode
  | { kind: 'split'; dir: 'row' | 'col'; ratio: number; a: ShellNode; b: ShellNode };

export function makeLeaf(cwd: string): ShellLeafNode {
  const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? (crypto as { randomUUID: () => string }).randomUUID()
    : Math.random().toString(36).slice(2);
  return { kind: 'leaf', id, cwd };
}

export function appendShell(root: ShellNode | null, cwd: string, dir: 'row' | 'col' = 'row'): ShellNode {
  const leaf = makeLeaf(cwd);
  if (!root) return leaf;
  return { kind: 'split', dir, ratio: 0.5, a: root, b: leaf };
}

function collectLeaves(node: ShellNode): ShellLeafNode[] {
  if (node.kind === 'leaf') return [node];
  return [...collectLeaves(node.a), ...collectLeaves(node.b)];
}

function closeLeaf(root: ShellNode, id: string): ShellNode | null {
  if (root.kind === 'leaf') return root.id === id ? null : root;
  const newA = closeLeaf(root.a, id);
  if (newA === null) return root.b;
  if (newA !== root.a) return { ...root, a: newA };
  const newB = closeLeaf(root.b, id);
  if (newB === null) return root.a;
  if (newB !== root.b) return { ...root, b: newB };
  return root;
}

function splitLeaf(root: ShellNode, id: string, dir: 'row' | 'col', cwd: string): ShellNode {
  if (root.kind === 'leaf') {
    if (root.id !== id) return root;
    return { kind: 'split', dir, ratio: 0.5, a: root, b: makeLeaf(cwd) };
  }
  const newA = splitLeaf(root.a, id, dir, cwd);
  if (newA !== root.a) return { ...root, a: newA };
  const newB = splitLeaf(root.b, id, dir, cwd);
  if (newB !== root.b) return { ...root, b: newB };
  return root;
}

type Path = ('a' | 'b')[];

function setRatioAtPath(root: ShellNode, path: Path, ratio: number): ShellNode {
  if (root.kind !== 'split') return root;
  if (path.length === 0) return { ...root, ratio };
  const [head, ...tail] = path;
  return head === 'a'
    ? { ...root, a: setRatioAtPath(root.a, tail, ratio) }
    : { ...root, b: setRatioAtPath(root.b, tail, ratio) };
}

interface Rect { x: number; y: number; w: number; h: number; }
interface DividerEntry { rect: Rect; parentRect: Rect; dir: 'row' | 'col'; path: Path; }

const GAP = 4;

function computeLayout(
  node: ShellNode,
  rect: Rect,
  path: Path,
): { leaves: Record<string, Rect>; dividers: DividerEntry[] } {
  if (node.kind === 'leaf') {
    return { leaves: { [node.id]: rect }, dividers: [] };
  }
  let aRect: Rect, dRect: Rect, bRect: Rect;
  if (node.dir === 'row') {
    const aw = Math.max(0, Math.round((rect.w - GAP) * node.ratio));
    const bw = Math.max(0, rect.w - aw - GAP);
    aRect = { x: rect.x, y: rect.y, w: aw, h: rect.h };
    dRect = { x: rect.x + aw, y: rect.y, w: GAP, h: rect.h };
    bRect = { x: rect.x + aw + GAP, y: rect.y, w: bw, h: rect.h };
  } else {
    const ah = Math.max(0, Math.round((rect.h - GAP) * node.ratio));
    const bh = Math.max(0, rect.h - ah - GAP);
    aRect = { x: rect.x, y: rect.y, w: rect.w, h: ah };
    dRect = { x: rect.x, y: rect.y + ah, w: rect.w, h: GAP };
    bRect = { x: rect.x, y: rect.y + ah + GAP, w: rect.w, h: bh };
  }
  const left = computeLayout(node.a, aRect, [...path, 'a']);
  const right = computeLayout(node.b, bRect, [...path, 'b']);
  return {
    leaves: { ...left.leaves, ...right.leaves },
    dividers: [
      ...left.dividers,
      { rect: dRect, parentRect: rect, dir: node.dir, path },
      ...right.dividers,
    ],
  };
}

interface Props {
  defaultCwd: string;
  root: ShellNode | null;
  setRoot: (next: ShellNode | null) => void;
}

export default function ShellArea({ defaultCwd, root, setRoot }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = root && size.w > 0 && size.h > 0
    ? computeLayout(root, { x: 0, y: 0, w: size.w, h: size.h }, [])
    : { leaves: {} as Record<string, Rect>, dividers: [] as DividerEntry[] };

  const leaves = root ? collectLeaves(root) : [];

  return (
    <div ref={containerRef} className="absolute inset-0 bg-bg">
      {layout.dividers.map((d) => (
        <Divider
          key={d.path.join('/') || 'root'}
          rect={d.rect}
          parentRect={d.parentRect}
          dir={d.dir}
          containerRef={containerRef}
          onResize={(ratio) => {
            if (root) setRoot(setRatioAtPath(root, d.path, ratio));
          }}
        />
      ))}

      {leaves.map((leaf) => {
        const rect = layout.leaves[leaf.id];
        if (!rect) return null;
        return (
          <div
            key={leaf.id}
            style={{
              position: 'absolute',
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
            }}
          >
            <ShellLeaf
              shellId={leaf.id}
              cwd={leaf.cwd}
              onUserClose={() => {
                api().killShell(leaf.id).catch(() => undefined);
                if (root) setRoot(closeLeaf(root, leaf.id));
              }}
              onPtyExit={() => { if (root) setRoot(closeLeaf(root, leaf.id)); }}
              onSplit={(dir) => { if (root) setRoot(splitLeaf(root, leaf.id, dir, defaultCwd)); }}
            />
          </div>
        );
      })}
    </div>
  );
}

interface DividerProps {
  rect: Rect;
  parentRect: Rect;
  dir: 'row' | 'col';
  containerRef: MutableRefObject<HTMLDivElement | null>;
  onResize: (ratio: number) => void;
}

function Divider({ rect, parentRect, dir, containerRef, onResize }: DividerProps) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      if (dir === 'row') {
        const x = ev.clientX - cRect.left - parentRect.x;
        const r = parentRect.w > 0 ? x / parentRect.w : 0.5;
        onResize(Math.max(0.1, Math.min(0.9, r)));
      } else {
        const y = ev.clientY - cRect.top - parentRect.y;
        const r = parentRect.h > 0 ? y / parentRect.h : 0.5;
        onResize(Math.max(0.1, Math.min(0.9, r)));
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = dir === 'row' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      onMouseDown={onMouseDown}
      style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      className={`bg-border hover:bg-accent ${dir === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'}`}
      title="Drag to resize"
    />
  );
}

interface LeafProps {
  shellId: string;
  cwd: string;
  onUserClose: () => void;
  onPtyExit: () => void;
  onSplit: (dir: 'row' | 'col') => void;
}

function ShellLeaf({ shellId, cwd, onUserClose, onPtyExit, onSplit }: LeafProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const label = cwd.split('/').filter(Boolean).pop() || cwd;

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    <div className="w-full h-full flex flex-col bg-bg border border-border min-w-0 min-h-0">
      <div className="shrink-0 flex items-center justify-between px-2 h-6 bg-panel border-b border-border text-[11px]">
        <span className="text-muted truncate">shell · {label}</span>
        <div className="relative flex items-center gap-1">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="px-1.5 text-muted hover:text-text leading-none"
            title="Shell options"
            aria-label="Shell options"
          >⋯</button>
          <button
            onClick={onUserClose}
            className="px-1.5 text-muted hover:text-text leading-none"
            title="Close shell"
            aria-label="Close shell"
          >×</button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={closeMenu} />
              <div className="absolute right-0 top-6 z-20 min-w-[140px] bg-panel border border-border rounded-md shadow-lg overflow-hidden text-[12px]">
                <button
                  onClick={() => { closeMenu(); onSplit('row'); }}
                  className="block w-full text-left px-3 py-1.5 text-text hover:bg-panel2"
                >Split right</button>
                <button
                  onClick={() => { closeMenu(); onSplit('col'); }}
                  className="block w-full text-left px-3 py-1.5 text-text hover:bg-panel2"
                >Split down</button>
                <div className="border-t border-border" />
                <button
                  onClick={() => { closeMenu(); onUserClose(); }}
                  className="block w-full text-left px-3 py-1.5 text-red-400 hover:bg-panel2"
                >Close</button>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 relative">
        <Terminal shellId={shellId} shellCwd={cwd} onExit={onPtyExit} autoFocus={false} />
      </div>
    </div>
  );
}
