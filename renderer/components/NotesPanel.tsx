import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import { FileEntry } from '../../shared/types';
import {
  TreeNode,
  TreeView,
  buildTree,
  collectDirPaths,
  flattenSingleChildDirs,
  isImageFile,
  useExpanded,
} from './file-tree';

interface Props {
  // The peer's project directory. Used only to resolve the peer's private notes
  // folder (stored under Peers Flow's app-data, NOT inside this directory) and to
  // key the panel's persisted open/expanded state per peer.
  dirPath: string;
  onFileOpen?: (absolutePath: string, line?: number) => void;
  openedFilePath?: string | null;
}

// A persisted boolean keyed in localStorage. Starts at `fallback` to avoid an
// SSR/first-paint flash, then hydrates on mount.
function usePersistedBool(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [value, setRaw] = useState(fallback);
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) setRaw(raw === '1');
      else setRaw(fallback);
    } catch { /* ignore */ }
  }, [key, fallback]);
  const set = useCallback((v: boolean) => {
    setRaw(v);
    try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore */ }
  }, [key]);
  return [value, set];
}

export default function NotesPanel({ dirPath, onFileOpen, openedFilePath }: Props) {
  // Persisted per peer (the directory path), so the open/closed state and the
  // note files are shared across every agent rooted in this peer and its preview.
  const [open, setOpen] = usePersistedBool(`agentsflow:notes:open:${dirPath}`, false);
  const [root, setRoot] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const expandedStore = useExpanded(`agentsflow:notes:expanded:${dirPath}`);
  const expanded = expandedStore.state;
  const setExpanded = expandedStore.setState;

  // Resolve (and create) the peer's notes folder. Reset listing when the peer
  // changes so a stale tree never bleeds across peers.
  useEffect(() => {
    let cancelled = false;
    setRoot(null);
    setFiles(null);
    const a = api();
    if (typeof a.notesRoot !== 'function') return;
    a.notesRoot(dirPath)
      .then((r) => { if (!cancelled) setRoot(r.root); })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[agentsflow] notesRoot failed', dirPath, err);
      });
    return () => { cancelled = true; };
  }, [dirPath]);

  const refresh = useCallback(async () => {
    if (!root) return;
    const a = api();
    if (typeof a.listNotes !== 'function') { setFiles([]); return; }
    try {
      const f = await a.listNotes(root);
      setFiles(f);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[agentsflow] listNotes failed', root, err);
      setFiles([]);
    }
  }, [root]);

  // List as soon as the notes folder is known — even while collapsed — so the
  // header's count badge is always populated, not just once the panel is opened.
  useEffect(() => { if (root) refresh(); }, [root, refresh]);

  // Live-update the count (and the tree, when open) whenever the folder changes.
  useEffect(() => {
    if (!root) return;
    const a = api();
    if (typeof a.watchFiles !== 'function' || typeof a.onFilesUpdated !== 'function') return;
    let cancelled = false;
    a.watchFiles(root).catch(() => undefined);
    const off = a.onFilesUpdated((p) => { if (!cancelled && p === root) refresh(); });
    return () => {
      cancelled = true;
      off();
      a.unwatchFiles?.(root).catch(() => undefined);
    };
  }, [root, refresh]);

  const tree = useMemo(() => {
    if (!files) return null;
    return flattenSingleChildDirs(buildTree(files.map((f) => ({ path: f.path }))));
  }, [files]);

  // First time we see this peer's notes, expand any folders so freshly created
  // sub-notes are visible. Later visits respect whatever the user toggled.
  useEffect(() => {
    if (!tree || !expandedStore.loaded || !expandedStore.wasNew) return;
    setExpanded(new Set(collectDirPaths(tree)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, expandedStore.loaded]);

  // ---- context menu + mutations (all rooted at the notes folder) ----
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const [creating, setCreating] = useState<{ parentRel: string; value: string; error?: string; busy?: boolean } | null>(null);
  const [renaming, setRenaming] = useState<{ node: TreeNode; value: string; error?: string; busy?: boolean } | null>(null);
  const [removing, setRemoving] = useState<{ node: TreeNode; error?: string; busy?: boolean } | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const openContextMenu = (e: React.MouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const startCreate = (parentRel: string) => {
    setMenu(null);
    setCreating({ parentRel, value: 'untitled.md' });
  };

  const submitCreate = async () => {
    if (!creating || !root) return;
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
    const fullPath = creating.parentRel ? `${root}/${creating.parentRel}/${name}` : `${root}/${name}`;
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
      setCreating({ ...creating, busy: false, error: (err as Error)?.message ?? String(err) });
    }
  };

  const startRename = (node: TreeNode) => {
    setMenu(null);
    setRenaming({ node, value: node.name });
  };

  const submitRename = async () => {
    if (!renaming || !root) return;
    const { node, value } = renaming;
    const newName = value.trim();
    if (!newName || newName === node.name) { setRenaming(null); return; }
    if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
      setRenaming({ ...renaming, error: 'Invalid name. No path separators.' });
      return;
    }
    const oldFullPath = `${root}/${node.path}`;
    const parentRel = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    const newFullPath = parentRel ? `${root}/${parentRel}/${newName}` : `${root}/${newName}`;
    setRenaming({ ...renaming, busy: true, error: undefined });
    try {
      await api().renamePath(oldFullPath, newFullPath);
      setRenaming(null);
      await refresh();
    } catch (err) {
      setRenaming({ ...renaming, busy: false, error: (err as Error)?.message ?? String(err) });
    }
  };

  const startRemove = (node: TreeNode) => {
    setMenu(null);
    setRemoving({ node });
  };

  const submitRemove = async () => {
    if (!removing || !root) return;
    setRemoving({ ...removing, busy: true, error: undefined });
    try {
      await api().removePath(`${root}/${removing.node.path}`);
      setRemoving(null);
      await refresh();
    } catch (err) {
      setRemoving({ ...removing, busy: false, error: (err as Error)?.message ?? String(err) });
    }
  };

  const revealInFinder = async (node: TreeNode) => {
    setMenu(null);
    if (!root) return;
    const a = api();
    if (typeof a.revealInFinder !== 'function') return;
    try {
      const res = await a.revealInFinder(`${root}/${node.path}`);
      if (!res.ok) setToast({ kind: 'err', text: `Reveal failed: ${res.error}` });
    } catch (err) {
      setToast({ kind: 'err', text: `Reveal failed: ${(err as Error)?.message ?? String(err)}` });
    }
  };

  const copyImage = async (node: TreeNode) => {
    setMenu(null);
    if (!root || node.kind !== 'file') return;
    const a = api();
    if (typeof a.copyImageToClipboard !== 'function') return;
    try {
      const res = await a.copyImageToClipboard(`${root}/${node.path}`);
      setToast(res.ok
        ? { kind: 'ok', text: `Copied ${node.name} — paste it anywhere.` }
        : { kind: 'err', text: `Copy failed: ${res.error}` });
    } catch (err) {
      setToast({ kind: 'err', text: `Copy failed: ${(err as Error)?.message ?? String(err)}` });
    }
  };

  const count = files?.length ?? 0;
  const unavailable = typeof api().notesRoot !== 'function';

  return (
    <div
      className="shrink-0 border-t border-border bg-panel flex flex-col min-h-0"
      style={open ? { maxHeight: '25%' } : undefined}
    >
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 hover:bg-panel2">
        <button
          onClick={() => setOpen(!open)}
          onContextMenu={(e) => openContextMenu(e, null)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          title={open ? 'Hide notes' : 'Show notes — this peer’s private notes'}
        >
          <span className="text-muted text-[10px] w-3 shrink-0">{open ? '▼' : '▶'}</span>
          <span className="text-[11px] uppercase tracking-wider text-text font-semibold">Notes</span>
          {count > 0 && <span className="text-[10px] text-accent font-mono shrink-0">{count}</span>}
        </button>
        <button
          onClick={() => { if (!open) setOpen(true); startCreate(''); }}
          disabled={unavailable}
          className="shrink-0 text-muted hover:text-text px-1.5 py-0.5 rounded hover:bg-panel disabled:opacity-40"
          title="New note"
          aria-label="New note"
        >+</button>
      </div>

      {open && (
        <div
          className="flex-1 min-h-0 overflow-y-auto border-t border-border/60 py-1 text-text/90"
          onContextMenu={(e) => openContextMenu(e, null)}
        >
          {unavailable ? (
            <div className="px-3 py-3 text-xs text-muted italic">
              Restart the app to enable Notes (preload needs to refresh).
            </div>
          ) : !tree ? (
            <div className="px-3 py-3 text-xs text-muted italic">Loading…</div>
          ) : (
            <TreeView
              root={tree}
              expanded={expanded}
              setExpanded={setExpanded}
              dirPath={root ?? ''}
              onFileOpen={onFileOpen}
              openedFilePath={openedFilePath}
              onContextMenu={openContextMenu}
              emptyLabel="No notes yet — use ＋ or right-click to create one."
            />
          )}
        </div>
      )}

      {menu && (
        <div
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-panel2 shadow-lg py-1 text-text"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          {menu.node && (
            <div className="px-3 py-1 text-[11px] text-muted truncate border-b border-border">{menu.node.path}</div>
          )}
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-panel"
            onClick={() => startCreate(
              !menu.node
                ? ''
                : menu.node.kind === 'dir'
                  ? menu.node.path
                  : menu.node.path.includes('/') ? menu.node.path.slice(0, menu.node.path.lastIndexOf('/')) : '',
            )}
          >New note…</button>
          {menu.node && (
            <>
              <button
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-panel"
                onClick={() => revealInFinder(menu.node!)}
              >Reveal in Finder</button>
              {menu.node.kind === 'file' && isImageFile(menu.node.name) && (
                <button
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-panel"
                  onClick={() => copyImage(menu.node!)}
                >Copy image</button>
              )}
              <button
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-panel"
                onClick={() => startRename(menu.node!)}
              >Rename…</button>
              <button
                className="w-full text-left px-3 py-1.5 text-sm text-err hover:bg-panel"
                onClick={() => startRemove(menu.node!)}
              >Delete</button>
            </>
          )}
        </div>
      )}

      {creating && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm"
          onClick={() => !creating.busy && setCreating(null)}
        >
          <div className="bg-panel border border-border rounded-md p-4 w-[420px] max-w-[90vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium text-text mb-1">New note</div>
            <div className="text-[11px] text-muted mb-3 truncate">in notes/{creating.parentRel || ''}</div>
            <input
              autoFocus
              value={creating.value}
              onFocus={(e) => {
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
            {creating.error && <div className="text-[11px] text-err mt-2">{creating.error}</div>}
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setCreating(null)} disabled={creating.busy} className="px-3 py-1.5 rounded-md text-sm text-muted hover:text-text hover:bg-panel2 disabled:opacity-40">Cancel</button>
              <button onClick={submitCreate} disabled={creating.busy || !creating.value.trim()} className="px-3 py-1.5 rounded-md bg-accent text-bg font-medium text-sm disabled:opacity-40 hover:bg-accent2">{creating.busy ? 'Creating…' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}

      {renaming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm"
          onClick={() => !renaming.busy && setRenaming(null)}
        >
          <div className="bg-panel border border-border rounded-md p-4 w-[420px] max-w-[90vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium text-text mb-1">Rename {renaming.node.kind === 'dir' ? 'folder' : 'note'}</div>
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
            {renaming.error && <div className="text-[11px] text-err mt-2">{renaming.error}</div>}
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setRenaming(null)} disabled={renaming.busy} className="px-3 py-1.5 rounded-md text-sm text-muted hover:text-text hover:bg-panel2 disabled:opacity-40">Cancel</button>
              <button onClick={submitRename} disabled={renaming.busy || !renaming.value.trim()} className="px-3 py-1.5 rounded-md bg-accent text-bg font-medium text-sm disabled:opacity-40 hover:bg-accent2">{renaming.busy ? 'Renaming…' : 'Rename'}</button>
            </div>
          </div>
        </div>
      )}

      {removing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm"
          onClick={() => !removing.busy && setRemoving(null)}
        >
          <div className="bg-panel border border-border rounded-md p-4 w-[420px] max-w-[90vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium text-text mb-1">Delete {removing.node.kind === 'dir' ? 'folder' : 'note'}?</div>
            <div className="text-[11px] text-muted mb-3 truncate">{removing.node.path}</div>
            <div className="text-xs text-text/85">This cannot be undone.</div>
            {removing.error && <div className="text-[11px] text-err mt-2">{removing.error}</div>}
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setRemoving(null)} disabled={removing.busy} className="px-3 py-1.5 rounded-md text-sm text-muted hover:text-text hover:bg-panel2 disabled:opacity-40">Cancel</button>
              <button onClick={submitRemove} disabled={removing.busy} className="px-3 py-1.5 rounded-md bg-err text-bg font-medium text-sm disabled:opacity-40 hover:opacity-90">{removing.busy ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] px-3 py-1.5 rounded-md text-sm shadow-lg border ${toast.kind === 'ok' ? 'bg-panel2 border-accent text-text' : 'bg-panel2 border-err text-err'}`}>{toast.text}</div>
      )}
    </div>
  );
}
