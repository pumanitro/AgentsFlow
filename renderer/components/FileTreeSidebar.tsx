import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/ipc';
import { useUIState } from '../lib/ui-state';
import { FileEntry, GitEntryStatus, GitStatusResult } from '../../shared/types';

interface Props {
  dirPath: string;
  conversationId: string;
  onFileOpen?: (absolutePath: string) => void;
  openedFilePath?: string | null;
}

function loadExpanded(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch { return new Set(); }
}
function saveExpanded(key: string, set: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify(Array.from(set))); } catch {}
}
function useExpanded(key: string): { state: Set<string>; setState: (s: Set<string>) => void; loaded: boolean; wasNew: boolean } {
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

interface TreeFile {
  kind: 'file';
  name: string;
  path: string;
  status?: GitEntryStatus;
  isIgnored?: boolean;
}
interface TreeDir {
  kind: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
  changedCount?: number;
  totalCount?: number;
  isIgnored?: boolean;
}
type TreeNode = TreeDir | TreeFile;

function buildTree(items: { path: string; status?: GitEntryStatus; isIgnored?: boolean }[]): TreeDir {
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

function collectDirPaths(root: TreeDir): string[] {
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

function flattenSingleChildDirs(root: TreeDir): TreeDir {
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

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tif', 'tiff']);
function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(fileExt(name));
}

// Order-sensitive equality on the fields we render — lets refresh skip
// setState (and the downstream tree rebuild + render) when the watcher
// fires but nothing visible actually changed.
function statusEquals(a: GitStatusResult | null, b: GitStatusResult | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.isRepo !== b.isRepo || a.branch !== b.branch) return false;
  if (a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i++) {
    const x = a.entries[i];
    const y = b.entries[i];
    if (x.path !== y.path || x.status !== y.status) return false;
  }
  return true;
}

function filesEquals(a: FileEntry[] | null, b: FileEntry[] | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].isIgnored !== b[i].isIgnored) return false;
  }
  return true;
}

function FileIcon({ name }: { name: string }) {
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

function FolderIcon({ open }: { open: boolean }) {
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

function TreeView({ root, expanded, setExpanded, onFileOpen, dirPath, openedFilePath, onContextMenu }: { root: TreeDir; expanded: Set<string>; setExpanded: (s: Set<string>) => void; onFileOpen?: (absPath: string) => void; dirPath: string; openedFilePath?: string | null; onContextMenu?: (e: React.MouseEvent, node: TreeNode) => void }) {
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
    return <div className="px-3 py-4 text-xs text-muted italic">No files to show.</div>;
  }
  return <div className="select-none">{renderNodes(root.children, 0)}</div>;
}

export default function FileTreeSidebar({ dirPath, conversationId, onFileOpen, openedFilePath }: Props) {
  const [mode, setMode] = useUIState('sidebarMode');
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const changesStore = useExpanded(`agentsflow:tree:${conversationId}:changes`);
  const filesStore = useExpanded(`agentsflow:tree:${conversationId}:files`);
  const expandedChanges = changesStore.state;
  const expandedFiles = filesStore.state;
  const setExpandedChanges = changesStore.setState;
  const setExpandedFiles = filesStore.setState;
  const [loading, setLoading] = useState(false);

  const refresh = useMemo(
    () => async () => {
      setLoading(true);
      try {
        const a = api();
        // Always fetch git status so Files mode can color files too.
        if (typeof a.gitStatus === 'function') {
          const s = await a.gitStatus(dirPath);
          setStatus((prev) => (statusEquals(prev, s) ? prev : s));
        } else {
          setStatus((prev) => (prev && !prev.isRepo && prev.entries.length === 0 ? prev : { isRepo: false, entries: [] }));
        }
        if (mode === 'files') {
          if (typeof a.listFiles !== 'function') {
            setFiles((prev) => (prev && prev.length === 0 ? prev : []));
            return;
          }
          const f = await a.listFiles(dirPath);
          setFiles((prev) => (filesEquals(prev, f) ? prev : f));
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[agentsflow] sidebar refresh failed', err);
      } finally {
        setLoading(false);
      }
    },
    [mode, dirPath],
  );

  useEffect(() => { refresh(); }, [refresh]);

  // Push-based refresh: subscribe to filesystem events for this directory.
  // Replaces the old 4 s polling interval — updates fire ~150 ms after the
  // last write, regardless of who made it (user, Claude agent, build tool).
  useEffect(() => {
    const a = api();
    if (typeof a.watchFiles !== 'function' || typeof a.onFilesUpdated !== 'function') return;
    let cancelled = false;
    a.watchFiles(dirPath).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[agentsflow] watchFiles failed', dirPath, err);
    });
    const off = a.onFilesUpdated((p) => {
      if (cancelled) return;
      if (p === dirPath) refresh();
    });
    return () => {
      cancelled = true;
      off();
      a.unwatchFiles?.(dirPath).catch(() => undefined);
    };
  }, [dirPath, refresh]);

  // Slow heartbeat backstop: filesystem events can be dropped on network
  // volumes (SMB, NFS, some sync clients). A 30 s tick guarantees we
  // reconcile even when the watcher misses something.
  useEffect(() => {
    const t = setInterval(() => { refresh(); }, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const tree = useMemo(() => {
    if (mode === 'changes') {
      if (!status) return null;
      const items = status.entries.map((e) => ({ path: e.path, status: e.status }));
      return flattenSingleChildDirs(buildTree(items));
    }
    if (!files) return null;
    const statusByPath = new Map<string, GitEntryStatus>();
    for (const e of status?.entries ?? []) statusByPath.set(e.path, e.status);
    const items = files.map((f) => ({
      path: f.path,
      isIgnored: f.isIgnored,
      status: statusByPath.get(f.path),
    }));
    return flattenSingleChildDirs(buildTree(items));
  }, [mode, status, files]);

  // Auto-expand sensible defaults the first time we see this conversation in this mode.
  // Subsequent visits respect whatever the user toggled (even if everything is collapsed).
  useEffect(() => {
    if (!tree) return;
    if (mode === 'changes' && changesStore.loaded && changesStore.wasNew) {
      const next = new Set<string>();
      tree.children.forEach((c) => { if (c.kind === 'dir' && (c.changedCount ?? 0) > 0) next.add(c.path); });
      setExpandedChanges(next);
    }
    if (mode === 'files' && filesStore.loaded && filesStore.wasNew) {
      const next = new Set<string>();
      tree.children.forEach((c) => { if (c.kind === 'dir' && !c.isIgnored) next.add(c.path); });
      setExpandedFiles(next);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, status, files, changesStore.loaded, filesStore.loaded]);

  const expanded = mode === 'changes' ? expandedChanges : expandedFiles;
  const setExpanded = mode === 'changes' ? setExpandedChanges : setExpandedFiles;

  const toggleExpandAll = () => {
    if (!tree) return;
    if (expanded.size > 0) {
      setExpanded(new Set());
    } else {
      setExpanded(new Set(collectDirPaths(tree)));
    }
  };

  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const openContextMenu = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const [renaming, setRenaming] = useState<{ node: TreeNode; value: string; error?: string; busy?: boolean } | null>(null);
  const [removing, setRemoving] = useState<{ node: TreeNode; error?: string; busy?: boolean } | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const startRename = (node: TreeNode) => {
    setMenu(null);
    setRenaming({ node, value: node.name });
  };

  const startRemove = (node: TreeNode) => {
    setMenu(null);
    setRemoving({ node });
  };

  const copyImage = async (node: TreeNode) => {
    setMenu(null);
    if (node.kind !== 'file') return;
    const fullPath = `${dirPath}/${node.path}`;
    const a = api();
    if (typeof a.copyImageToClipboard !== 'function') {
      setToast({ kind: 'err', text: 'Restart the app to enable copy (preload needs to refresh).' });
      return;
    }
    try {
      const res = await a.copyImageToClipboard(fullPath);
      if (res.ok) {
        setToast({ kind: 'ok', text: `Copied ${node.name} — paste it anywhere.` });
      } else {
        setToast({ kind: 'err', text: `Copy failed: ${res.error}` });
      }
    } catch (err) {
      setToast({ kind: 'err', text: `Copy failed: ${(err as Error)?.message ?? String(err)}` });
    }
  };

  const submitRename = async () => {
    if (!renaming) return;
    const { node, value } = renaming;
    const newName = value.trim();
    if (!newName || newName === node.name) { setRenaming(null); return; }
    if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
      setRenaming({ ...renaming, error: 'Invalid name. No path separators.' });
      return;
    }
    const oldFullPath = `${dirPath}/${node.path}`;
    const parentRel = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    const newFullPath = parentRel ? `${dirPath}/${parentRel}/${newName}` : `${dirPath}/${newName}`;
    setRenaming({ ...renaming, busy: true, error: undefined });
    try {
      await api().renamePath(oldFullPath, newFullPath);
      setRenaming(null);
      await refresh();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[agentsflow] rename failed', err);
      setRenaming({ ...renaming, busy: false, error: (err as Error)?.message ?? String(err) });
    }
  };

  const submitRemove = async () => {
    if (!removing) return;
    const fullPath = `${dirPath}/${removing.node.path}`;
    setRemoving({ ...removing, busy: true, error: undefined });
    try {
      await api().removePath(fullPath);
      setRemoving(null);
      await refresh();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[agentsflow] remove failed', err);
      setRemoving({ ...removing, busy: false, error: (err as Error)?.message ?? String(err) });
    }
  };

  const summary = status && mode === 'changes'
    ? `${status.entries.length} change${status.entries.length === 1 ? '' : 's'}${status.branch ? ` · ${status.branch}` : ''}`
    : files && mode === 'files'
      ? `${files.length} file${files.length === 1 ? '' : 's'}`
      : '';

  return (
    <div className="h-full flex flex-col bg-panel">
      <div className="shrink-0 px-2 py-2 border-b border-border flex items-center gap-1">
        <div className="flex rounded-md border border-border overflow-hidden">
          <button
            onClick={() => setMode('changes')}
            className={`px-2 py-1 text-[11px] uppercase tracking-wider ${mode === 'changes' ? 'bg-accent text-bg font-semibold' : 'text-muted hover:text-text hover:bg-panel2'}`}
          >Changes</button>
          <button
            onClick={() => setMode('files')}
            className={`px-2 py-1 text-[11px] uppercase tracking-wider ${mode === 'files' ? 'bg-accent text-bg font-semibold' : 'text-muted hover:text-text hover:bg-panel2'}`}
          >Files</button>
        </div>
        <button
          onClick={toggleExpandAll}
          disabled={!tree || tree.children.length === 0}
          className="ml-auto text-muted hover:text-text px-1.5 py-1 rounded hover:bg-panel2 disabled:opacity-40 disabled:cursor-not-allowed"
          title={expanded.size > 0 ? 'Collapse all' : 'Expand all'}
          aria-label={expanded.size > 0 ? 'Collapse all' : 'Expand all'}
        >
          {expanded.size > 0 ? (
            // anything open → next click collapses (chevrons fold toward center line)
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M4 2 L8 6 L12 2" />
              <path d="M2 8 L14 8" />
              <path d="M4 14 L8 10 L12 14" />
            </svg>
          ) : (
            // nothing open → next click expands (chevrons unfold away from center line)
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M4 6 L8 2 L12 6" />
              <path d="M2 8 L14 8" />
              <path d="M4 10 L8 14 L12 10" />
            </svg>
          )}
        </button>
        <button
          onClick={refresh}
          className="text-muted hover:text-text px-1.5 py-1 rounded hover:bg-panel2"
          title="Refresh"
        >{loading ? '…' : '↻'}</button>
      </div>
      {summary && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-muted border-b border-border">{summary}</div>
      )}
      <div className="flex-1 overflow-y-auto py-1 text-text/90">
        {typeof api().gitStatus !== 'function' && (
          <div className="px-3 py-4 text-xs text-muted italic">
            Restart the app to load the sidebar (preload needs to refresh after pulling new code).
          </div>
        )}
        {mode === 'changes' && status && !status.isRepo && typeof api().gitStatus === 'function' && (
          <div className="px-3 py-4 text-xs text-muted italic">Not a git repository.</div>
        )}
        {tree && (
          <TreeView
            root={tree}
            expanded={expanded}
            setExpanded={setExpanded}
            dirPath={dirPath}
            onFileOpen={onFileOpen}
            openedFilePath={openedFilePath}
            onContextMenu={openContextMenu}
          />
        )}
      </div>
      {menu && (
        <div
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-panel2 shadow-lg py-1 text-text"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div className="px-3 py-1 text-[11px] text-muted truncate border-b border-border">{menu.node.path}</div>
          {menu.node.kind === 'file' && isImageFile(menu.node.name) && (
            <button
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-panel"
              onClick={() => copyImage(menu.node)}
            >Copy image</button>
          )}
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-panel"
            onClick={() => startRename(menu.node)}
          >Rename…</button>
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-err hover:bg-panel"
            onClick={() => startRemove(menu.node)}
          >Delete</button>
        </div>
      )}
      {renaming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm"
          onClick={() => !renaming.busy && setRenaming(null)}
        >
          <div
            className="bg-panel border border-border rounded-md p-4 w-[420px] max-w-[90vw] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-text mb-1">Rename {renaming.node.kind === 'dir' ? 'directory' : 'file'}</div>
            <div className="text-[11px] text-muted mb-3 truncate">{renaming.node.path}</div>
            <input
              autoFocus
              value={renaming.value}
              onChange={(e) => setRenaming({ ...renaming, value: e.target.value, error: undefined })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRename();
                if (e.key === 'Escape') setRenaming(null);
              }}
              className="w-full bg-panel2 border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
            {renaming.error && (
              <div className="text-[11px] text-err mt-2">{renaming.error}</div>
            )}
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setRenaming(null)}
                disabled={renaming.busy}
                className="px-3 py-1.5 rounded-md text-sm text-muted hover:text-text hover:bg-panel2 disabled:opacity-40"
              >Cancel</button>
              <button
                onClick={submitRename}
                disabled={renaming.busy || !renaming.value.trim()}
                className="px-3 py-1.5 rounded-md bg-accent text-bg font-medium text-sm disabled:opacity-40 hover:bg-accent2"
              >{renaming.busy ? 'Renaming…' : 'Rename'}</button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div
          className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] px-3 py-1.5 rounded-md text-sm shadow-lg border ${toast.kind === 'ok' ? 'bg-panel2 border-accent text-text' : 'bg-panel2 border-err text-err'}`}
        >{toast.text}</div>
      )}
      {removing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm"
          onClick={() => !removing.busy && setRemoving(null)}
        >
          <div
            className="bg-panel border border-border rounded-md p-4 w-[420px] max-w-[90vw] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-text mb-1">Delete {removing.node.kind === 'dir' ? 'directory' : 'file'}?</div>
            <div className="text-[11px] text-muted mb-3 truncate">{removing.node.path}</div>
            <div className="text-xs text-text/85">This cannot be undone.</div>
            {removing.error && (
              <div className="text-[11px] text-err mt-2">{removing.error}</div>
            )}
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setRemoving(null)}
                disabled={removing.busy}
                className="px-3 py-1.5 rounded-md text-sm text-muted hover:text-text hover:bg-panel2 disabled:opacity-40"
              >Cancel</button>
              <button
                onClick={submitRemove}
                disabled={removing.busy}
                className="px-3 py-1.5 rounded-md bg-err text-bg font-medium text-sm disabled:opacity-40 hover:opacity-90"
              >{removing.busy ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
