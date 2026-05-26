import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/ipc';
import { FileEntry, GitEntryStatus, GitStatusResult } from '../../shared/types';

type Mode = 'changes' | 'files';

interface Props {
  dirPath: string;
  conversationId: string;
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

function FileRow({ node, depth }: { node: TreeFile; depth: number }) {
  const style = node.status ? STATUS_STYLE[node.status] : null;
  const muted = node.isIgnored ? 'opacity-50' : '';
  return (
    <div
      className={`group flex items-center gap-2 pr-2 py-0.5 hover:bg-panel2 cursor-default ${muted}`}
      style={{ paddingLeft: 8 + depth * 14 }}
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

function DirRow({ node, depth, expanded, onToggle }: { node: TreeDir; depth: number; expanded: boolean; onToggle: () => void }) {
  const muted = node.isIgnored ? 'opacity-50' : '';
  return (
    <div
      onClick={onToggle}
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

function TreeView({ root, expanded, setExpanded }: { root: TreeDir; expanded: Set<string>; setExpanded: (s: Set<string>) => void }) {
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
            <DirRow node={c} depth={depth} expanded={isOpen} onToggle={toggle} />
            {isOpen && renderNodes(c.children, depth + 1)}
          </div>
        );
      }
      return <FileRow key={c.path} node={c} depth={depth} />;
    });

  if (root.children.length === 0) {
    return <div className="px-3 py-4 text-xs text-muted italic">No files to show.</div>;
  }
  return <div className="select-none">{renderNodes(root.children, 0)}</div>;
}

export default function FileTreeSidebar({ dirPath, conversationId }: Props) {
  const [mode, setMode] = useState<Mode>('changes');
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
          setStatus(s);
        } else {
          setStatus({ isRepo: false, entries: [] });
        }
        if (mode === 'files') {
          if (typeof a.listFiles !== 'function') {
            setFiles([]);
            return;
          }
          const f = await a.listFiles(dirPath);
          setFiles(f);
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
  useEffect(() => {
    const t = setInterval(() => { refresh(); }, 4000);
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
          onClick={refresh}
          className="ml-auto text-muted hover:text-text px-1.5 py-1 rounded hover:bg-panel2"
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
        {tree && <TreeView root={tree} expanded={expanded} setExpanded={setExpanded} />}
      </div>
    </div>
  );
}
