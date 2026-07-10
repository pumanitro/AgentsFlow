import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/ipc';
import { useUIState } from '../lib/ui-state';
import { FileEntry, GitEntryStatus, GitStatusResult } from '../../shared/types';
import SearchModal from './SearchModal';
import NotesPanel from './NotesPanel';
import {
  TreeFile,
  TreeNode,
  buildTree,
  collectDirPaths,
  countFiles,
  filterTree,
  flattenSingleChildDirs,
  isImageFile,
  TreeView,
  useExpanded,
} from './file-tree';

// Build a predicate that matches a tree file against the user's filter query.
// The query is treated as a case-insensitive regex; if it isn't valid regex
// (e.g. a half-typed "foo(") we fall back to a plain substring match so the
// bar stays usable while typing. Matched against both the basename and the
// full relative path so "components/Terminal" and "\.tsx$" both work.
function buildNameMatcher(query: string): (node: TreeFile) => boolean {
  let re: RegExp | null = null;
  try {
    re = new RegExp(query, 'i');
  } catch {
    re = null;
  }
  const lower = query.toLowerCase();
  return (node) => {
    if (re) return re.test(node.name) || re.test(node.path);
    return node.name.toLowerCase().includes(lower) || node.path.toLowerCase().includes(lower);
  };
}

interface Props {
  dirPath: string;
  conversationId: string;
  onFileOpen?: (absolutePath: string, line?: number) => void;
  openedFilePath?: string | null;
  // When set, the Changes/Files toggle uses local state seeded to this mode
  // instead of the shared global preference — lets the preview default to
  // Files without changing what the session view shows.
  initialMode?: 'changes' | 'files';
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

export default function FileTreeSidebar({ dirPath, conversationId, onFileOpen, openedFilePath, initialMode }: Props) {
  const globalMode = useUIState('sidebarMode');
  const localMode = useState<'changes' | 'files'>(initialMode ?? 'changes');
  const [mode, setMode] = initialMode ? localMode : globalMode;
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const changesStore = useExpanded(`agentsflow:tree:${conversationId}:changes`);
  const filesStore = useExpanded(`agentsflow:tree:${conversationId}:files`);
  const expandedChanges = changesStore.state;
  const expandedFiles = filesStore.state;
  const setExpandedChanges = changesStore.setState;
  const setExpandedFiles = filesStore.setState;
  const [loading, setLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Filename filter: a regex typed into the bar above the tree that prunes it
  // to matching files. Distinct from the magnifier (Find-in-files / content
  // search) — this one never leaves the sidebar.
  const [filter, setFilter] = useState('');

  // Shift+F opens Find-in-Files. We suppress the plain combo while the user is
  // typing into a text field (inputs, the file editor, or the terminal's hidden
  // textarea) so it never eats a real keystroke; ⌘/Ctrl+Shift+F always works,
  // even from those contexts, matching the usual IDE binding.
  useEffect(() => {
    const isEditable = (el: EventTarget | null): boolean => {
      const node = el as HTMLElement | null;
      if (!node || !node.tagName) return false;
      const tag = node.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || node.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyF' || e.altKey) return;
      const withMeta = e.metaKey || e.ctrlKey;
      if (withMeta && e.shiftKey) {
        e.preventDefault();
        setSearchOpen(true);
      } else if (!withMeta && e.shiftKey && !isEditable(e.target)) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  const filterQuery = filter.trim();
  const filteredTree = useMemo(() => {
    if (!filterQuery || !tree) return tree;
    return filterTree(tree, buildNameMatcher(filterQuery));
  }, [tree, filterQuery]);
  const matchCount = filterQuery && filteredTree ? countFiles(filteredTree) : null;

  // While a filter is active we show everything expanded so matches are
  // visible, but keep it in a separate set so the user's persisted expand
  // state (and their manual collapses within the filtered view) aren't lost.
  // Re-expands whenever the query changes.
  const [filterExpanded, setFilterExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (filterQuery && filteredTree) setFilterExpanded(new Set(collectDirPaths(filteredTree)));
  }, [filterQuery, filteredTree]);

  const displayTree = filterQuery ? filteredTree : tree;
  const displayExpanded = filterQuery ? filterExpanded : expanded;
  const displaySetExpanded = filterQuery ? setFilterExpanded : setExpanded;

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
  const [creating, setCreating] = useState<{ parentRel: string; value: string; error?: string; busy?: boolean } | null>(null);
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

  const startCreate = (parentRel: string) => {
    setMenu(null);
    setCreating({ parentRel, value: 'untitled.md' });
  };

  const submitCreate = async () => {
    if (!creating) return;
    let name = creating.value.trim();
    if (!name) { setCreating(null); return; }
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      setCreating({ ...creating, error: 'Invalid name. No path separators.' });
      return;
    }
    if (!name.includes('.')) name = `${name}.md`;
    const a = api();
    if (typeof a.createFile !== 'function') {
      setCreating(null);
      setToast({ kind: 'err', text: 'Restart the app to enable this (preload needs to refresh).' });
      return;
    }
    const fullPath = creating.parentRel
      ? `${dirPath}/${creating.parentRel}/${name}`
      : `${dirPath}/${name}`;
    setCreating({ ...creating, busy: true, error: undefined });
    try {
      await a.createFile(fullPath);
      setCreating(null);
      if (creating.parentRel) {
        const next = new Set(expanded);
        let acc = '';
        for (const seg of creating.parentRel.split('/')) {
          acc = acc ? `${acc}/${seg}` : seg;
          next.add(acc);
        }
        setExpanded(next);
      }
      await refresh();
      onFileOpen?.(fullPath);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[agentsflow] create file failed', err);
      setCreating({ ...creating, busy: false, error: (err as Error)?.message ?? String(err) });
    }
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

  const revealInFinder = async (node: TreeNode) => {
    setMenu(null);
    const fullPath = `${dirPath}/${node.path}`;
    const a = api();
    if (typeof a.revealInFinder !== 'function') {
      setToast({ kind: 'err', text: 'Restart the app to enable this (preload needs to refresh).' });
      return;
    }
    try {
      const res = await a.revealInFinder(fullPath);
      if (!res.ok) setToast({ kind: 'err', text: `Reveal failed: ${res.error}` });
    } catch (err) {
      setToast({ kind: 'err', text: `Reveal failed: ${(err as Error)?.message ?? String(err)}` });
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
          onClick={() => setSearchOpen(true)}
          className="ml-auto text-muted hover:text-text px-1.5 py-1 rounded hover:bg-panel2"
          title="Find in files (Shift+F)"
          aria-label="Find in files"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 L14 14" strokeLinecap="round" />
          </svg>
        </button>
        <button
          onClick={toggleExpandAll}
          disabled={!tree || tree.children.length === 0}
          className="text-muted hover:text-text px-1.5 py-1 rounded hover:bg-panel2 disabled:opacity-40 disabled:cursor-not-allowed"
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
      <div className="shrink-0 px-2 py-1.5 border-b border-border">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-panel2 px-2 py-1 focus-within:border-accent">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-muted shrink-0" aria-hidden>
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 L14 14" strokeLinecap="round" />
          </svg>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setFilter(''); e.currentTarget.blur(); }
            }}
            placeholder="Filter files by name (regex)…"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="flex-1 min-w-0 bg-transparent text-[12px] text-text placeholder:text-muted outline-none"
            aria-label="Filter files by name"
          />
          {filterQuery && (
            <>
              <span className="text-[10px] text-muted tabular-nums shrink-0" title={`${matchCount} match${matchCount === 1 ? '' : 'es'}`}>{matchCount}</span>
              <button
                onClick={() => setFilter('')}
                className="text-muted hover:text-text shrink-0 leading-none text-[14px]"
                title="Clear filter"
                aria-label="Clear filter"
              >×</button>
            </>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1 text-text/90">
        {typeof api().gitStatus !== 'function' && (
          <div className="px-3 py-4 text-xs text-muted italic">
            Restart the app to load the sidebar (preload needs to refresh after pulling new code).
          </div>
        )}
        {mode === 'changes' && status && !status.isRepo && typeof api().gitStatus === 'function' && (
          <div className="px-3 py-4 text-xs text-muted italic">Not a git repository.</div>
        )}
        {displayTree && (
          <TreeView
            root={displayTree}
            expanded={displayExpanded}
            setExpanded={displaySetExpanded}
            dirPath={dirPath}
            onFileOpen={onFileOpen}
            openedFilePath={openedFilePath}
            onContextMenu={openContextMenu}
            emptyLabel={filterQuery ? `No files match /${filterQuery}/` : undefined}
          />
        )}
      </div>
      <NotesPanel dirPath={dirPath} onFileOpen={onFileOpen} openedFilePath={openedFilePath} />
      {menu && (
        <div
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-panel2 shadow-lg py-1 text-text"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div className="px-3 py-1 text-[11px] text-muted truncate border-b border-border">{menu.node.path}</div>
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-panel"
            onClick={() => revealInFinder(menu.node)}
          >Reveal in Finder</button>
          {menu.node.kind === 'file' && isImageFile(menu.node.name) && (
            <button
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-panel"
              onClick={() => copyImage(menu.node)}
            >Copy image</button>
          )}
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-panel"
            onClick={() => startCreate(
              menu.node.kind === 'dir'
                ? menu.node.path
                : menu.node.path.includes('/') ? menu.node.path.slice(0, menu.node.path.lastIndexOf('/')) : '',
            )}
          >New file…</button>
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
      {creating && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm"
          onClick={() => !creating.busy && setCreating(null)}
        >
          <div
            className="bg-panel border border-border rounded-md p-4 w-[420px] max-w-[90vw] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-text mb-1">New file</div>
            <div className="text-[11px] text-muted mb-3 truncate">in {creating.parentRel || './'}</div>
            <input
              autoFocus
              value={creating.value}
              onFocus={(e) => {
                // Pre-select the basename so typing replaces "untitled" but keeps ".md".
                const dot = e.target.value.lastIndexOf('.');
                e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
              }}
              onChange={(e) => setCreating({ ...creating, value: e.target.value, error: undefined })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCreate();
                if (e.key === 'Escape') setCreating(null);
              }}
              className="w-full bg-panel2 border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
            <div className="text-[11px] text-muted mt-2">Names without an extension get .md added.</div>
            {creating.error && (
              <div className="text-[11px] text-err mt-2">{creating.error}</div>
            )}
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setCreating(null)}
                disabled={creating.busy}
                className="px-3 py-1.5 rounded-md text-sm text-muted hover:text-text hover:bg-panel2 disabled:opacity-40"
              >Cancel</button>
              <button
                onClick={submitCreate}
                disabled={creating.busy || !creating.value.trim()}
                className="px-3 py-1.5 rounded-md bg-accent text-bg font-medium text-sm disabled:opacity-40 hover:bg-accent2"
              >{creating.busy ? 'Creating…' : 'Create'}</button>
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
      {searchOpen && (
        <SearchModal
          dirPath={dirPath}
          onOpen={(abs, line) => onFileOpen?.(abs, line)}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}
