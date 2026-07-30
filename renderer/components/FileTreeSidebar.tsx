import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import { useDirectoryNumber, useDirectoryString, useUIState } from '../lib/ui-state';
import { BranchList, FileEntry, GitEntryStatus, GitStatusResult, WorktreeInfo } from '../../shared/types';
import SearchModal from './SearchModal';
import NotesPanel from './NotesPanel';
import UsagePanel from './UsagePanel';
import AccountsPanel from './AccountsPanel';
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

// Worktree list sizing. The list used to be a hard 224px strip; a repo with 20
// trees spends its life scrolling inside it, so the ceiling is now dragged by
// the user — up to half the sidebar, which is as far as it can go before the
// file tree it sits next to stops being usable.
const MIN_WT_HEIGHT = 64;
const DEFAULT_WT_HEIGHT = 224;
const MAX_WT_HEIGHT_RATIO = 0.5;

interface Props {
  dirPath: string;
  conversationId: string;
  // The worktree this conversation is working in, if any (Conversation
  // .worktreePath). Seeds the Changes-mode selection when the chat is opened,
  // so the panel shows the tree the chat is actually changing rather than the
  // peer's own. A manual pick afterwards stands until the chat changes.
  worktreePath?: string | null;
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

// Skip re-render when a worktree refresh returns the same list (the heartbeat
// and watcher bursts re-fetch often, but the list rarely actually changes).
function worktreesEqual(a: WorktreeInfo[], b: WorktreeInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.path !== y.path || x.changedCount !== y.changedCount || x.published !== y.published
      || x.unpublished !== y.unpublished || x.behind !== y.behind || x.refBranch !== y.refBranch
      || x.branch !== y.branch || x.isCurrent !== y.isCurrent) {
      return false;
    }
  }
  return true;
}

export default function FileTreeSidebar({ dirPath, conversationId, worktreePath, onFileOpen, openedFilePath, initialMode }: Props) {
  const globalMode = useUIState('sidebarMode');
  const localMode = useState<'changes' | 'files'>(initialMode ?? 'changes');
  const [mode, setMode] = initialMode ? localMode : globalMode;
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  // Worktrees for this repo + which one the Changes tree is currently showing.
  // `selectedWorktree === null` means the peer's own (current) working tree —
  // i.e. today's default behaviour. Selection only applies in Changes mode.
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(null);
  // Reference branch the worktree rows are measured against. Persisted per repo
  // (a release branch name is meaningless in another project); null means "use
  // the repo default", which the main process resolves to the primary working
  // tree's branch. Branch list is fetched lazily, only when the picker opens.
  const [refBranch, setRefBranch] = useDirectoryString(dirPath, 'worktreeRef');
  const [branches, setBranches] = useState<BranchList>({ local: [], remote: [] });
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const [refFilter, setRefFilter] = useState('');
  const [showPublished, setShowPublished] = useState(false);
  // How tall the worktree list may grow, and whether it sits above the file
  // tree or below it. Both are per-repo (like the reference branch): a repo
  // with 20 worktrees wants a different shape than one with two.
  const [wtHeight, setWtHeight] = useDirectoryNumber(dirPath, 'worktreeHeight', DEFAULT_WT_HEIGHT);
  const [wtPlacement, setWtPlacement] = useDirectoryString(dirPath, 'worktreePlacement');
  const wtAtBottom = wtPlacement === 'bottom';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const wtListRef = useRef<HTMLDivElement | null>(null);
  // The "half the sidebar" ceiling is measured, not assumed — the pane is
  // resizable in both directions, so a height picked while the window was tall
  // has to give way when it shrinks.
  const [paneHeight, setPaneHeight] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setPaneHeight(el.getBoundingClientRect().height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const activeDir = mode === 'changes' && selectedWorktree ? selectedWorktree : dirPath;
  // Follow the conversation: opening a chat selects the worktree that chat is
  // working in, and switching peers clears the selection. Guarded on the inputs
  // themselves rather than firing every render, so a manual pick inside the same
  // chat isn't immediately overwritten — only a genuine change to the chat, the
  // peer, or where that chat now lives re-seeds it.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    const key = [dirPath, conversationId, worktreePath ?? ''].join('|');
    if (seededFor.current === key) return;
    seededFor.current = key;
    setSelectedWorktree(worktreePath ?? null);
  }, [dirPath, conversationId, worktreePath]);
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
        // Always fetch git status so Files mode can color files too. Reads the
        // active worktree (the peer itself unless another worktree is selected).
        if (typeof a.gitStatus === 'function') {
          const s = await a.gitStatus(activeDir);
          setStatus((prev) => (statusEquals(prev, s) ? prev : s));
        } else {
          setStatus((prev) => (prev && !prev.isRepo && prev.entries.length === 0 ? prev : { isRepo: false, entries: [] }));
        }
        // Worktree overview is Changes-mode only. Silently skipped on an older
        // preload that predates the handler.
        if (mode === 'changes' && typeof a.listWorktrees === 'function') {
          try {
            const wts = await a.listWorktrees(dirPath, refBranch ?? undefined);
            setWorktrees((prev) => (worktreesEqual(prev, wts) ? prev : wts));
          } catch { /* leave last-known list in place */ }
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
    [mode, dirPath, activeDir, refBranch],
  );

  useEffect(() => { refresh(); }, [refresh]);

  // Branch list backs the reference picker only, so it is fetched when that
  // opens rather than on every sidebar refresh.
  useEffect(() => {
    if (!refPickerOpen) return;
    let cancelled = false;
    (async () => {
      const a = api();
      if (typeof a.listBranches !== 'function') return;
      try {
        const bs = await a.listBranches(dirPath);
        if (!cancelled) setBranches(bs);
      } catch { /* leave the last-known list in place */ }
    })();
    return () => { cancelled = true; };
  }, [refPickerOpen, dirPath]);

  // Close the picker on outside click / Escape.
  useEffect(() => {
    if (!refPickerOpen) return;
    const close = () => setRefPickerOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [refPickerOpen]);

  // If the selected worktree disappears (removed, or the repo changed), fall
  // back to the current working tree so the view never points at nothing.
  //
  // The empty check is load-bearing, not defensive: `worktrees` starts [] and is
  // filled by an async refresh, so without it this effect fires on mount and
  // discards the selection seeded from the conversation before the list it would
  // validate against has arrived. A repo always reports at least its own working
  // tree, so [] means "not loaded yet" (or not a repo) — either way there is
  // nothing to prune against, and pruning then is always wrong.
  useEffect(() => {
    if (worktrees.length === 0) return;
    if (selectedWorktree && !worktrees.some((w) => w.path === selectedWorktree)) {
      setSelectedWorktree(null);
    }
  }, [worktrees, selectedWorktree]);

  // Debounced refresh for the bursty file-watcher path. A single write often
  // produces several rapid `onFilesUpdated` events (macOS atomic write = tmp +
  // rename, plus editor/build tools touching many files), and each one used to
  // fire an immediate `git status` + `ls-files`. Collapse a burst into one call
  // on the trailing edge; `refreshRef` keeps the timer pointed at the latest
  // `refresh` closure so a mid-burst mode/dir change is still honored.
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback((delayMs = 120) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      refreshRef.current();
    }, delayMs);
  }, []);
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

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
      if (p === dirPath) scheduleRefresh();
    });
    return () => {
      cancelled = true;
      off();
      a.unwatchFiles?.(dirPath).catch(() => undefined);
    };
    // `scheduleRefresh` is stable and reads the latest `refresh` via a ref, so
    // the watcher re-subscribes only when the directory actually changes — not
    // on every mode toggle, which used to churn watch/unwatch needlessly.
  }, [dirPath, scheduleRefresh]);

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
  const [removingWt, setRemovingWt] = useState<{ wt: WorktreeInfo; error?: string; busy?: boolean; canForce?: boolean } | null>(null);
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
      ? `${activeDir}/${creating.parentRel}/${name}`
      : `${activeDir}/${name}`;
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
    const fullPath = `${activeDir}/${node.path}`;
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
    const fullPath = `${activeDir}/${node.path}`;
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
    const oldFullPath = `${activeDir}/${node.path}`;
    const parentRel = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    const newFullPath = parentRel ? `${activeDir}/${parentRel}/${newName}` : `${activeDir}/${newName}`;
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
    const fullPath = `${activeDir}/${removing.node.path}`;
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

  const submitRemoveWt = async (force = false) => {
    if (!removingWt) return;
    const a = api();
    if (typeof a.removeWorktree !== 'function') {
      setRemovingWt({ ...removingWt, error: 'Restart the app to enable this (preload needs to refresh).' });
      return;
    }
    setRemovingWt({ ...removingWt, busy: true, error: undefined });
    try {
      const res = await a.removeWorktree(dirPath, removingWt.wt.path, force);
      if (!res.ok) {
        // A worktree with local changes needs --force; surface that as a second step.
        const canForce = !force && /modified|untracked|contains|use --force|locked/i.test(res.error);
        setRemovingWt({ ...removingWt, busy: false, error: res.error, canForce });
        return;
      }
      if (selectedWorktree === removingWt.wt.path) setSelectedWorktree(null);
      setRemovingWt(null);
      await refresh();
    } catch (err) {
      setRemovingWt({ ...removingWt, busy: false, error: (err as Error)?.message ?? String(err) });
    }
  };

  const summary = status && mode === 'changes'
    ? `${status.entries.length} change${status.entries.length === 1 ? '' : 's'}${status.branch ? ` · ${status.branch}` : ''}`
    : files && mode === 'files'
      ? `${files.length} file${files.length === 1 ? '' : 's'}`
      : '';

  // Which worktree row is highlighted: an explicit selection, else the peer's
  // own (current) tree. The section only shows in Changes mode for repos that
  // actually have a linked worktree.
  const currentWtPath = worktrees.find((w) => w.isCurrent)?.path ?? null;
  const effectiveSelected = selectedWorktree ?? currentWtPath;
  const showWorktrees = mode === 'changes' && worktrees.length > 1;

  // Ceiling for the list: whatever the user dragged to, never more than half
  // the pane. Before the first measurement we honour the stored value as-is so
  // a tall list doesn't visibly snap down and back on mount.
  const wtListMax = paneHeight > 0
    ? Math.max(MIN_WT_HEIGHT, Math.min(wtHeight, Math.round(paneHeight * MAX_WT_HEIGHT_RATIO)))
    : wtHeight;

  const startWtResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    // Start from what is actually on screen, not from the stored ceiling: with
    // few worktrees the list is shorter than its ceiling, and dragging should
    // pick up where the divider visibly is.
    const startH = wtListRef.current?.getBoundingClientRect().height ?? DEFAULT_WT_HEIGHT;
    const pane = rootRef.current?.getBoundingClientRect().height ?? 0;
    const maxH = pane > 0 ? Math.max(MIN_WT_HEIGHT, Math.round(pane * MAX_WT_HEIGHT_RATIO)) : startH;
    const onMove = (ev: MouseEvent) => {
      // The handle sits on whichever side faces the file tree, so the gesture
      // inverts when the list is parked at the bottom: there, dragging up grows it.
      const delta = wtAtBottom ? startY - ev.clientY : ev.clientY - startY;
      setWtHeight(Math.round(Math.max(MIN_WT_HEIGHT, Math.min(maxH, startH + delta))));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [setWtHeight, wtAtBottom]);

  // What the rows were *actually* measured against, straight from the data
  // rather than from `refBranch` — the two diverge when a pinned branch has
  // since been deleted and the main process fell back to the repo default.
  const resolvedRef = worktrees[0]?.refBranch ?? refBranch ?? '';
  const defaultRef = worktrees.find((w) => w.isMain)?.branch ?? '';
  const visibleBranches = useMemo(() => {
    const q = refFilter.trim().toLowerCase();
    const match = (bs: string[]) => (q ? bs.filter((b) => b.toLowerCase().includes(q)) : bs);
    return { local: match(branches.local), remote: match(branches.remote) };
  }, [branches, refFilter]);
  const noBranchMatches = visibleBranches.local.length === 0 && visibleBranches.remote.length === 0;

  // One rule for the whole panel: a worktree needs attention if it holds
  // anything the reference does not have. That is deliberately broader than
  // "unmerged commits" — uncommitted edits are not commits at all, so git can
  // never call them merged, yet they are just as much work that has not
  // landed. Reporting only the commits let a tree with 69 uncommitted files
  // wear a "merged" badge, which is what made this panel lie.
  const needsAction = (w: WorktreeInfo) => !w.published || w.dirty;
  const actionTrees = useMemo(() => worktrees.filter(needsAction), [worktrees]);
  const doneTrees = useMemo(() => worktrees.filter((w) => !needsAction(w)), [worktrees]);

  const renderWorktreeRow = (wt: WorktreeInfo) => {
    const selected = effectiveSelected === wt.path;
    const label = (wt.isMain ? wt.branch : wt.branch.replace(/^worktree-/, '')) || '(detached)';
    const removable = !wt.isMain && !wt.isCurrent;
    const act = needsAction(wt);
    // Spell the tooltip out in full: the row itself is two compact numbers, so
    // this is where "why does this need me?" gets answered in words.
    const reasons: string[] = [];
    if (wt.unpublished > 0) {
      // `unpublished < ahead` means some commits reached the ref by rebase or
      // cherry-pick — worth saying, since the raw ahead count is what you would
      // otherwise compute by hand and be misled by.
      const reworked = wt.ahead > wt.unpublished ? ` (${wt.ahead - wt.unpublished} more already landed rebased)` : '';
      reasons.push(`${wt.unpublished} commit${wt.unpublished === 1 ? '' : 's'} not in ${resolvedRef}${reworked}`);
    }
    if (wt.dirty) reasons.push(`${wt.changedCount} uncommitted file${wt.changedCount === 1 ? '' : 's'}`);
    const dotTitle = !resolvedRef
      ? 'No reference branch to compare against'
      : act
        ? `Needs action — ${reasons.join(' · ')}`
        : `Nothing outstanding — every commit is in ${resolvedRef} and the tree is clean`
          + `${wt.behind ? ` (${wt.behind} commit${wt.behind === 1 ? '' : 's'} behind it)` : ''}`;
    return (
      <div
        key={wt.path}
        onClick={() => setSelectedWorktree(wt.isCurrent ? null : wt.path)}
        title={wt.path}
        className={`group w-full flex items-center gap-2 px-3 py-1 cursor-pointer ${selected ? 'bg-accent/25 text-text font-medium' : 'text-text/90 hover:bg-panel2'}`}
      >
        {/* One indicator for the whole row: lit means this worktree is holding
            something the reference does not have. */}
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${act ? 'bg-info animate-pulse' : 'bg-ok/40'}`}
          title={dotTitle}
          aria-hidden
        />
        <span className={`flex-1 min-w-0 truncate text-[12px] ${act ? '' : 'text-text/50'}`}>{label}</span>
        {wt.isMain && <span className="text-[9px] uppercase tracking-wider text-muted shrink-0">main</span>}
        <span className="text-[10px] font-mono shrink-0 flex items-center gap-1.5" title={dotTitle}>
          {!resolvedRef && <span className="text-muted/70">—</span>}
          {/* Two counts, never combined into one number: commits and loose
              files are different units and merging them would be nonsense. */}
          {wt.unpublished > 0 && (
            <span className="text-info" title={`${wt.unpublished} commit(s) not in ${resolvedRef}`}>↑{wt.unpublished}</span>
          )}
          {wt.dirty && (
            <span className="text-accent" title={`${wt.changedCount} uncommitted file(s)`}>{wt.changedCount}</span>
          )}
          {resolvedRef && !act && <span className="text-muted">done</span>}
        </span>
        {removable && (
          <button
            onClick={(e) => { e.stopPropagation(); setRemovingWt({ wt }); }}
            title="Remove worktree"
            aria-label={`Remove worktree ${label}`}
            className="shrink-0 text-muted hover:text-err leading-none text-[13px] px-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100"
          >✕</button>
        )}
      </div>
    );
  };

  // Drag divider between the worktree list and the file tree. Doubles as the
  // border between the two sections, so it always sits on the tree-facing side.
  const wtResizer = (
    <div
      onMouseDown={startWtResize}
      onDoubleClick={() => setWtHeight(DEFAULT_WT_HEIGHT)}
      role="separator"
      aria-orientation="horizontal"
      title="Drag to resize the worktree list · double-click to reset"
      className="shrink-0 h-1 bg-subtle/70 hover:bg-accent cursor-row-resize"
    />
  );

  const worktreeSection = !showWorktrees ? null : (
    <div className="shrink-0 flex flex-col min-h-0">
      {wtAtBottom && wtResizer}
      <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted flex items-center gap-1.5">
        <span>Worktrees</span>
        <span className="text-muted/70">{worktrees.length}</span>
        <span className="flex-1" />
        <button
          onClick={() => setWtPlacement(wtAtBottom ? null : 'bottom')}
          title={wtAtBottom
            ? 'Move the worktree list back above the file tree'
            : 'Move the worktree list below the file tree'}
          aria-label={wtAtBottom ? 'Move worktree list to the top' : 'Move worktree list to the bottom'}
          className="shrink-0 px-1.5 py-0.5 rounded border border-border text-muted hover:text-text hover:border-accent text-[11px] leading-none"
        >{wtAtBottom ? '↑' : '↓'}</button>
        <div className="relative normal-case tracking-normal" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => { setRefFilter(''); setRefPickerOpen((v) => !v); }}
            title={resolvedRef
              ? `Comparing every worktree against "${resolvedRef}" — click to change`
              : 'No reference branch: the primary working tree is detached. Click to pin one.'}
            className="flex items-center gap-1 max-w-[130px] px-1.5 py-0.5 rounded border border-border hover:border-accent hover:text-text text-[10px] font-mono"
          >
            <span className="text-muted/70 shrink-0">vs</span>
            <span className="truncate">{resolvedRef || 'none'}</span>
            <span className="text-muted/70 shrink-0">▾</span>
          </button>
          {refPickerOpen && (
            // Parked at the bottom of the pane, a downward menu would fall off
            // the panel — flip it above the button instead.
            <div className={`absolute right-0 z-30 w-56 rounded-md border border-border bg-panel shadow-lg overflow-hidden ${wtAtBottom ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
              <input
                autoFocus
                value={refFilter}
                onChange={(e) => setRefFilter(e.target.value)}
                placeholder="Filter branches…"
                className="w-full px-2 py-1.5 text-[11px] bg-panel2 border-b border-border outline-none placeholder:text-muted/60"
              />
              <div className="max-h-56 overflow-y-auto py-0.5">
                <button
                  onClick={() => { setRefBranch(null); setRefPickerOpen(false); }}
                  className={`w-full text-left px-2 py-1 text-[11px] hover:bg-panel2 ${refBranch === null ? 'text-accent' : 'text-text/80'}`}
                >Repo default{defaultRef ? ` (${defaultRef})` : ''}</button>
                {([['Local', visibleBranches.local], ['Remote', visibleBranches.remote]] as const).map(
                  ([heading, list]) => (list.length === 0 ? null : (
                    <div key={heading}>
                      <div className="px-2 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider text-muted/70">{heading}</div>
                      {list.map((b) => (
                        <button
                          key={b}
                          onClick={() => { setRefBranch(b); setRefPickerOpen(false); }}
                          className={`w-full text-left px-2 py-1 text-[11px] font-mono truncate hover:bg-panel2 ${refBranch === b ? 'text-accent' : 'text-text/80'}`}
                          title={b}
                        >{b}</button>
                      ))}
                    </div>
                  )),
                )}
                {noBranchMatches && (
                  <div className="px-2 py-1.5 text-[11px] text-muted">No matching branches</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <div ref={wtListRef} className="overflow-y-auto pb-1" style={{ maxHeight: wtListMax }}>
        {actionTrees.length > 0 && (
          <div className="px-3 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-muted/80">
            Needs action · {actionTrees.length}
          </div>
        )}
        {actionTrees.map(renderWorktreeRow)}
        {doneTrees.length > 0 && (
          <button
            onClick={() => setShowPublished((v) => !v)}
            className="w-full flex items-center gap-1 px-3 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider text-muted/80 hover:text-text"
            title={`Fully in ${resolvedRef || 'the reference'} with a clean working tree`}
          >
            <span className="shrink-0">{showPublished ? '▾' : '▸'}</span>
            <span>Done · {doneTrees.length}</span>
          </button>
        )}
        {showPublished && doneTrees.map(renderWorktreeRow)}
      </div>
      {!wtAtBottom && wtResizer}
    </div>
  );

  return (
    <div ref={rootRef} className="h-full flex flex-col bg-panel">
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
      {!wtAtBottom && worktreeSection}
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
            dirPath={activeDir}
            onFileOpen={onFileOpen}
            openedFilePath={openedFilePath}
            onContextMenu={openContextMenu}
            emptyLabel={filterQuery ? `No files match /${filterQuery}/` : undefined}
          />
        )}
      </div>
      {wtAtBottom && worktreeSection}
      {/* Same docked utility-cluster treatment as the home sidebar: Usage above
          Notes, both inset on the darker background behind a strong divider, so
          the two views share one design language. Usage matters most while a
          chat is burning through the limits, so it follows you in here rather
          than living only on the home screen. */}
      <div className="shrink-0 min-h-0 flex flex-col gap-2 px-2 py-2 border-t-2 border-border bg-bg shadow-[0_-10px_18px_-10px_rgba(0,0,0,0.7)]">
        <AccountsPanel />
        <UsagePanel />
        <NotesPanel dirPath={dirPath} onFileOpen={onFileOpen} openedFilePath={openedFilePath} />
      </div>
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
      {removingWt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm"
          onClick={() => !removingWt.busy && setRemovingWt(null)}
        >
          <div
            className="bg-panel border border-border rounded-md p-4 w-[440px] max-w-[90vw] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-text mb-1">Remove worktree?</div>
            <div className="text-[11px] text-muted mb-3 truncate" title={removingWt.wt.path}>{removingWt.wt.path}</div>
            <div className="text-xs text-text/85">
              Runs <span className="font-mono text-text">git worktree remove</span>. The branch{' '}
              <span className="font-mono text-text">{removingWt.wt.branch}</span> stays in the repo — only the folder is deleted.
            </div>
            {removingWt.wt.changedCount > 0 && !removingWt.error && (
              <div className="text-[11px] text-err mt-2">
                Heads up: {removingWt.wt.changedCount} uncommitted change{removingWt.wt.changedCount === 1 ? '' : 's'} here — a plain remove will be refused.
              </div>
            )}
            {removingWt.error && (
              <div className="text-[11px] text-err mt-2 break-words">{removingWt.error}</div>
            )}
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setRemovingWt(null)}
                disabled={removingWt.busy}
                className="px-3 py-1.5 rounded-md text-sm text-muted hover:text-text hover:bg-panel2 disabled:opacity-40"
              >Cancel</button>
              {removingWt.canForce ? (
                <button
                  onClick={() => submitRemoveWt(true)}
                  disabled={removingWt.busy}
                  className="px-3 py-1.5 rounded-md bg-err text-bg font-medium text-sm disabled:opacity-40 hover:opacity-90"
                >{removingWt.busy ? 'Removing…' : 'Force remove'}</button>
              ) : (
                <button
                  onClick={() => submitRemoveWt(false)}
                  disabled={removingWt.busy}
                  className="px-3 py-1.5 rounded-md bg-err text-bg font-medium text-sm disabled:opacity-40 hover:opacity-90"
                >{removingWt.busy ? 'Removing…' : 'Remove'}</button>
              )}
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
