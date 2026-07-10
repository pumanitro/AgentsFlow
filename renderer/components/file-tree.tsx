import { useEffect, useState } from 'react';
import { api } from '../lib/ipc';
import { GitEntryStatus } from '../../shared/types';

// Shared file-tree primitives used by both the project sidebar (FileTreeSidebar)
// and the per-peer Notes panel (NotesPanel). Kept in their own module so the two
// can reuse the tree builder, row rendering, and expand-state persistence without
// importing each other (which would be a circular dependency).

export interface TreeFile {
  kind: 'file';
  name: string;
  path: string;
  status?: GitEntryStatus;
  isIgnored?: boolean;
}
export interface TreeDir {
  kind: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
  changedCount?: number;
  totalCount?: number;
  isIgnored?: boolean;
}
export type TreeNode = TreeDir | TreeFile;

export function buildTree(items: { path: string; status?: GitEntryStatus; isIgnored?: boolean }[]): TreeDir {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [] };
  const ensureDir = (segments: string[]): TreeDir => {
    let cur = root;
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      let next = cur.children.find((c) => c.kind === 'dir' && c.name === seg) as TreeDir | undefined;
      if (!next) {
        next = { kind: 'dir', name: seg, path: acc, children: [] };
        cur.children.push(next);
      }
      cur = next;
    }
    return cur;
  };
  for (const item of items) {
    const parts = item.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    const fileName = parts[parts.length - 1];
    const dirSegments = parts.slice(0, -1);
    const parent = dirSegments.length > 0 ? ensureDir(dirSegments) : root;
    parent.children.push({
      kind: 'file',
      name: fileName,
      path: item.path,
      status: item.status,
      isIgnored: item.isIgnored,
    });
  }
  const sortRec = (n: TreeDir) => {
    n.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of n.children) if (c.kind === 'dir') sortRec(c);
  };
  sortRec(root);
  const annotate = (n: TreeDir) => {
    let changed = 0;
    let total = 0;
    let allIgnored = n.children.length > 0;
    for (const c of n.children) {
      if (c.kind === 'dir') {
        annotate(c);
        changed += c.changedCount ?? 0;
        total += c.totalCount ?? 0;
        if (!c.isIgnored) allIgnored = false;
      } else {
        if (c.status && c.status !== 'unknown') changed++;
        total++;
        if (!c.isIgnored) allIgnored = false;
      }
    }
    n.changedCount = changed;
    n.totalCount = total;
    n.isIgnored = allIgnored;
  };
  annotate(root);
  return root;
}

export function collectDirPaths(root: TreeDir): string[] {
  const out: string[] = [];
  const walk = (n: TreeDir) => {
    for (const c of n.children) {
      if (c.kind === 'dir') {
        out.push(c.path);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

// Prune the tree to just the files matching `predicate`, keeping the ancestor
// directories needed to reach them. Used by the sidebar's filename filter.
// Directory node metadata (changedCount/totalCount) is copied as-is; callers
// that need accurate filtered totals should use countFiles on the result.
export function filterTree(root: TreeDir, predicate: (node: TreeFile) => boolean): TreeDir {
  const rec = (n: TreeDir): TreeDir | null => {
    const kept: TreeNode[] = [];
    for (const c of n.children) {
      if (c.kind === 'dir') {
        const f = rec(c);
        if (f) kept.push(f);
      } else if (predicate(c)) {
        kept.push(c);
      }
    }
    if (kept.length === 0) return null;
    return { ...n, children: kept };
  };
  return rec(root) ?? { ...root, children: [] };
}

export function countFiles(root: TreeDir): number {
  let n = 0;
  const walk = (d: TreeDir) => {
    for (const c of d.children) {
      if (c.kind === 'dir') walk(c);
      else n++;
    }
  };
  walk(root);
  return n;
}

export function flattenSingleChildDirs(root: TreeDir): TreeDir {
  // Collapse a/b/c into "a/b/c" if each level only has a single dir child.
  const rec = (n: TreeDir): TreeDir => {
    while (n.children.length === 1 && n.children[0].kind === 'dir') {
      const child = n.children[0] as TreeDir;
      n = { ...n, name: n.name ? `${n.name}/${child.name}` : child.name, path: child.path, children: child.children, changedCount: child.changedCount, totalCount: child.totalCount };
    }
    const collapsedChildren: TreeNode[] = n.children.map((c) => (c.kind === 'dir' ? rec(c) : c));
    return { ...n, children: collapsedChildren };
  };
  return rec(root);
}

const EXT_COLOR: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6',
  js: '#f1c40f', jsx: '#f1c40f', mjs: '#f1c40f', cjs: '#f1c40f',
  json: '#cbd5e1',
  css: '#3b82f6', scss: '#ec4899', sass: '#ec4899', less: '#3b82f6',
  html: '#f97316',
  md: '#a8b2c5',
  yml: '#a78bfa', yaml: '#a78bfa', toml: '#a78bfa',
  py: '#3776ab',
  rb: '#cc342d',
  go: '#00add8',
  rs: '#dea584',
  java: '#b07219', kt: '#b07219',
  sh: '#89e051', bash: '#89e051', zsh: '#89e051',
  sql: '#e38c00',
  txt: '#94a3b8',
  png: '#9333ea', jpg: '#9333ea', jpeg: '#9333ea', gif: '#9333ea', svg: '#9333ea', webp: '#9333ea',
  lock: '#64748b',
};

export function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tif', 'tiff']);
export function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(fileExt(name));
}

export function FileIcon({ name }: { name: string }) {
  const ext = fileExt(name);
  const color = EXT_COLOR[ext] ?? '#64748b';
  return (
    <span
      className="inline-block w-4 h-4 rounded-sm text-[8px] font-bold flex items-center justify-center text-bg shrink-0"
      style={{ backgroundColor: color }}
      title={ext || 'file'}
    >
      {ext ? ext.slice(0, 2).toUpperCase() : '·'}
    </span>
  );
}

export function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 text-muted">
      {open ? (
        <path d="M1.5 3.5h4l1.5 1.5h7v1H6.83l-.5-.5H2.5v7h11v-5h1v5.5a.5.5 0 01-.5.5h-12a.5.5 0 01-.5-.5v-9z" />
      ) : (
        <path d="M1.5 3.5h4l1.5 1.5h7a.5.5 0 01.5.5v7.5a.5.5 0 01-.5.5h-12a.5.5 0 01-.5-.5v-9z" />
      )}
    </svg>
  );
}

const STATUS_STYLE: Record<GitEntryStatus, { fg: string; label: string }> = {
  untracked: { fg: 'text-err', label: 'U' },
  added: { fg: 'text-ok', label: 'A' },
  modified: { fg: 'text-warn', label: 'M' },
  deleted: { fg: 'text-err line-through', label: 'D' },
  renamed: { fg: 'text-accent', label: 'R' },
  unknown: { fg: 'text-muted', label: '' },
};

function FileRow({ node, depth, absPath, onOpen, isOpen, onContextMenu }: { node: TreeFile; depth: number; absPath: string; onOpen?: () => void; isOpen?: boolean; onContextMenu?: (e: React.MouseEvent) => void }) {
  const style = node.status ? STATUS_STYLE[node.status] : null;
  const muted = node.isIgnored ? 'opacity-50' : '';
  const active = isOpen ? 'bg-panel2 border-l-2 border-l-accent' : 'border-l-2 border-l-transparent';
  const handleDragStart = (e: React.DragEvent) => {
    // Hand off to Electron's native drag-and-drop so external apps
    // (Chrome, Finder, editors) receive the real file path. The web drag
    // would only carry text and most targets ignore it.
    e.preventDefault();
    const a = api();
    if (typeof a.startFileDrag === 'function') {
      a.startFileDrag(absPath).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[agentsflow] startFileDrag failed', absPath, err);
      });
    }
  };
  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      className={`group flex items-center gap-2 pr-2 py-0.5 hover:bg-panel2 ${onOpen ? 'cursor-pointer' : 'cursor-default'} ${muted} ${active}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      title={node.path + (node.isIgnored ? ' (ignored)' : '')}
    >
      <FileIcon name={node.name} />
      <span className={`truncate text-[13px] flex-1 ${style?.fg ?? 'text-text/85'}`}>{node.name}</span>
      {style?.label && (
        <span className={`text-[10px] font-mono font-bold shrink-0 ${style.fg}`}>{style.label}</span>
      )}
    </div>
  );
}

function DirRow({ node, depth, expanded, onToggle, onContextMenu }: { node: TreeDir; depth: number; expanded: boolean; onToggle: () => void; onContextMenu?: (e: React.MouseEvent) => void }) {
  const muted = node.isIgnored ? 'opacity-50' : '';
  return (
    <div
      onClick={onToggle}
      onContextMenu={onContextMenu}
      className={`flex items-center gap-1.5 pr-2 py-0.5 hover:bg-panel2 cursor-pointer ${muted}`}
      style={{ paddingLeft: 4 + depth * 14 }}
      title={node.path + (node.isIgnored ? ' (ignored)' : '')}
    >
      <span className="text-muted text-[10px] w-3 shrink-0">{expanded ? '▼' : '▶'}</span>
      <FolderIcon open={expanded} />
      <span className="truncate text-[13px] text-text font-medium flex-1">{node.name}</span>
      {node.changedCount !== undefined && node.changedCount > 0 && (
        <span className="text-[10px] text-accent font-mono shrink-0">{node.changedCount}</span>
      )}
    </div>
  );
}

export function TreeView({ root, expanded, setExpanded, onFileOpen, dirPath, openedFilePath, onContextMenu, emptyLabel }: { root: TreeDir; expanded: Set<string>; setExpanded: (s: Set<string>) => void; onFileOpen?: (absPath: string) => void; dirPath: string; openedFilePath?: string | null; onContextMenu?: (e: React.MouseEvent, node: TreeNode) => void; emptyLabel?: string }) {
  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((c) => {
      if (c.kind === 'dir') {
        const isOpen = expanded.has(c.path);
        const toggle = () => {
          const n = new Set(expanded);
          if (n.has(c.path)) n.delete(c.path); else n.add(c.path);
          setExpanded(n);
        };
        return (
          <div key={c.path || c.name}>
            <DirRow
              node={c}
              depth={depth}
              expanded={isOpen}
              onToggle={toggle}
              onContextMenu={onContextMenu ? (e) => onContextMenu(e, c) : undefined}
            />
            {isOpen && renderNodes(c.children, depth + 1)}
          </div>
        );
      }
      const absPath = `${dirPath}/${c.path}`;
      return (
        <FileRow
          key={c.path}
          node={c}
          depth={depth}
          absPath={absPath}
          onOpen={onFileOpen ? () => onFileOpen(absPath) : undefined}
          isOpen={openedFilePath === absPath}
          onContextMenu={onContextMenu ? (e) => onContextMenu(e, c) : undefined}
        />
      );
    });

  if (root.children.length === 0) {
    return <div className="px-3 py-4 text-xs text-muted italic">{emptyLabel ?? 'No files to show.'}</div>;
  }
  return <div className="select-none">{renderNodes(root.children, 0)}</div>;
}

// ---- expand-state persistence ----------------------------------------------

export function saveExpanded(key: string, set: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify(Array.from(set))); } catch {}
}

export function useExpanded(key: string): { state: Set<string>; setState: (s: Set<string>) => void; loaded: boolean; wasNew: boolean } {
  const [loaded, setLoaded] = useState(false);
  const [wasNew, setWasNew] = useState(false);
  const [state, setStateRaw] = useState<Set<string>>(new Set());
  useEffect(() => {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null;
    setWasNew(raw === null);
    setStateRaw(raw ? new Set(JSON.parse(raw) as string[]) : new Set());
    setLoaded(true);
  }, [key]);
  const setState = (s: Set<string>) => {
    setStateRaw(s);
    saveExpanded(key, s);
    setWasNew(false);
  };
  return { state, setState, loaded, wasNew };
}
