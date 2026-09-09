import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import PinnedRow from '../components/PinnedRow';
import DelegatedChildRow from '../components/DelegatedChildRow';
import DividerRow from '../components/DividerRow';
import TodoRow from '../components/TodoRow';
import TodoChildRow from '../components/TodoChildRow';
import DirectoryCard from '../components/DirectoryCard';
import SpawnBar from '../components/SpawnBar';
import HistoryModal from '../components/HistoryModal';
import HistoryTimeline from '../components/HistoryTimeline';
import HelpModal from '../components/HelpModal';
import McpModal from '../components/McpModal';
import StatsView from '../components/StatsView';
import { api } from '../lib/ipc';
import { useUIState } from '../lib/ui-state';
import { BridgeHealth, Conversation, PinnedDivider, PinnedItemRef, PinnedTodo, TrackedDirectory } from '../../shared/types';
import { blockStepDropIndex, marqueeHits, moveRefsTo, refKey } from '../../shared/pinned-selection';

// Both touch the Electron-only `api()` at render time, so they must be
// client-only — this page is server-rendered by Next, where `api()` throws.
// FileEditor (CodeMirror / BlockNote) also only loads when a note is previewed.
const NotesPanel = dynamic(() => import('../components/NotesPanel'), { ssr: false });
const UsagePanel = dynamic(() => import('../components/UsagePanel'), { ssr: false });
const AccountsPanel = dynamic(() => import('../components/AccountsPanel'), { ssr: false });
const PerfLauncher = dynamic(() => import('../components/PerfPanel'), { ssr: false });
const FileEditor = dynamic(() => import('../components/FileEditor'), { ssr: false });

type PinnedItem =
  | { kind: 'conversation'; id: string; ref: PinnedItemRef; conv: Conversation }
  | { kind: 'divider'; id: string; ref: PinnedItemRef; divider: PinnedDivider }
  | { kind: 'todo'; id: string; ref: PinnedItemRef; todo: PinnedTodo };

export default function Home() {
  const router = useRouter();
  const [dirs, setDirs] = useState<TrackedDirectory[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  // Latest list, readable from IPC callbacks without re-subscribing them on
  // every change (the patch handler needs the current rows to merge into).
  const convsRef = useRef<Conversation[]>(convs);
  useEffect(() => { convsRef.current = convs; }, [convs]);
  const [dividers, setDividers] = useState<PinnedDivider[]>([]);
  const [todos, setTodos] = useState<PinnedTodo[]>([]);
  const [pinnedOrder, setPinnedOrder] = useState<PinnedItemRef[]>([]);
  const [selectedDirId, setSelectedDirId] = useUIState('selectedDirId');
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);
  const [keyboardNavActive, setKeyboardNavActive] = useState<boolean>(false);
  const [historyDirId, setHistoryDirId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  // Live delegation-bridge liveness, polled for the header health dot. When this
  // goes down, delegations silently degrade to unwatchable headless runs, so we
  // surface it at a glance rather than leaving it invisible.
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  // A delegated peer (sub-row) can be selected independently of its root row.
  // When set, the root's own selection highlight is suppressed so only one
  // element — root OR peer — shows the orange selection at a time.
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [view, setView] = useUIState('view');
  const [peerQuery, setPeerQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingRenameDividerId, setPendingRenameDividerId] = useState<string | null>(null);
  // A freshly added task opens its inline editor as soon as its row lands.
  const [pendingEditTodoId, setPendingEditTodoId] = useState<string | null>(null);
  const awaitingNewConvRef = useRef<Set<string> | null>(null);
  // After a row is finished it vanishes; this records which neighbour to
  // re-focus once the list has actually dropped the finished row, so focus
  // never gets parked on a separator. Keys are refKey() strings so the same
  // mechanism serves conversations and tasks — see markDone.
  const pendingDoneRef = useRef<{ doneKey: string; targetKey: string } | null>(null);
  const [pendingFocusConvId, setPendingFocusConvId] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  // Every row the current drag carries: the whole checked set when the grabbed
  // row is part of it, otherwise just that row.
  const [dragSet, setDragSet] = useState<Set<string> | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);
  // Multi-select, built by dragging a rubber band across the list. Keys are
  // refKey() strings, so conversations, tasks and separators all live in one set
  // and move as one block.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement | null>(null);
  // The gutter area a band may start in — the padding around the list.
  const bandAreaRef = useRef<HTMLElement | null>(null);
  // The band being dragged right now, in coordinates relative to the list box.
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // Tears down the in-flight band drag (its window listeners and visuals).
  const bandTeardownRef = useRef<(() => void) | null>(null);
  const [banding, setBanding] = useState(false);
  // A band that actually swept rows must not also fire the click that would
  // open a conversation, and must not let the row start an HTML5 drag.
  const suppressClickRef = useRef(false);
  const dragBlockedRef = useRef(false);
  // Key of the row whose inline title editor is open; that row's wrapper must
  // not be draggable, or click-dragging to select text starts a row drag.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [justAddedConvId, setJustAddedConvId] = useState<string | null>(null);
  // Global notes: the shared folder's absolute root (for the preview's relative
  // path display) and the note currently open in the quick-look modal.
  const [globalNotesRoot, setGlobalNotesRoot] = useState<string | null>(null);
  const [globalNoteFile, setGlobalNoteFile] = useState<string | null>(null);

  const refreshAll = async () => {
    // The todos calls are optional-chained: in dev the renderer hot-reloads
    // ahead of the Electron main, so a not-yet-restarted preload may predate
    // the todos API — degrade to "no tasks" instead of blanking the page.
    const [d, c, dv, td, po] = await Promise.all([
      api().listDirectories(),
      api().listConversations(),
      api().listDividers(),
      api().listTodos?.() ?? Promise.resolve([]),
      api().listPinnedOrder(),
    ]);
    setDirs(d);
    setConvs(c);
    setDividers(dv);
    setTodos(td);
    setPinnedOrder(po);
  };

  useEffect(() => { refreshAll(); }, []);

  // Poll the delegation-bridge liveness for the header health dot. Optional-
  // chained: in dev the renderer can hot-reload ahead of the Electron main, so a
  // not-yet-restarted preload may predate this IPC — treat that as "unknown"
  // (dot hidden) rather than crashing.
  useEffect(() => {
    let alive = true;
    const poll = () => {
      const getHealth = api().getBridgeHealth;
      if (typeof getHealth !== 'function') return;
      getHealth().then((h) => { if (alive) setBridgeHealth(h); }).catch(() => undefined);
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Resolve the shared global-notes root once, so the preview modal can show a
  // path relative to it. The panel itself resolves the same (idempotent) root
  // independently; this copy is only for display.
  useEffect(() => {
    const a = api();
    if (typeof a.globalNotesRoot !== 'function') return;
    a.globalNotesRoot().then((r) => setGlobalNotesRoot(r.root)).catch(() => undefined);
  }, []);

  // Esc closes the global-note quick-look (its editor flushes on unmount).
  useEffect(() => {
    if (!globalNoteFile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setGlobalNoteFile(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [globalNoteFile]);

  useEffect(() => {
    const a = api();
    const offC = a.onConversationsUpdated((next) => setConvs(next));
    // Incremental path: a daemon state change patches the few rows it touched
    // instead of replacing the whole list (which is all of history — ~2.9 MB —
    // and re-derives every memo below it). A patch naming a conversation we've
    // never seen means our list is structurally out of date, so fall back to a
    // full fetch rather than guessing where the new row belongs.
    const offP = a.onConversationsPatched?.((changed) => {
      if (changed.length === 0) return;
      const byId = new Map(changed.map((c) => [c.id, c]));
      const prev = convsRef.current;
      let hit = 0;
      const next = prev.map((c) => {
        const patched = byId.get(c.id);
        if (!patched) return c;
        hit++;
        return patched;
      });
      if (hit !== byId.size) {
        // Unknown id in the patch — our list is structurally stale. Resync.
        void a.listConversations().then(setConvs).catch(() => undefined);
        return;
      }
      setConvs(next);
    }) ?? (() => undefined);
    const offD = a.onDividersUpdated((next) => setDividers(next));
    const offT = a.onTodosUpdated?.((next) => setTodos(next)) ?? (() => undefined);
    const offO = a.onPinnedOrderUpdated((next) => setPinnedOrder(next));
    return () => { offC(); offP(); offD(); offT(); offO(); };
  }, []);

  const selectedDir = useMemo(() => dirs.find((d) => d.id === selectedDirId) ?? null, [dirs, selectedDirId]);
  const historyDir = useMemo(() => dirs.find((d) => d.id === historyDirId) ?? null, [dirs, historyDirId]);

  const convsByDir = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const c of convs) {
      const list = map.get(c.directoryId) ?? [];
      list.push(c);
      map.set(c.directoryId, list);
    }
    return map;
  }, [convs]);

  // Tracked Peers are ordered by their most recently *created* chat (newest
  // first), so spawning a conversation floats its peer to the front. Peers with
  // no chats yet fall back to when they were added. ISO timestamps compare
  // correctly as plain strings.
  const sortedDirs = useMemo(() => {
    const lastChatAt = (dirId: string): string => {
      let max = '';
      for (const c of convsByDir.get(dirId) ?? []) {
        if (c.createdAt > max) max = c.createdAt;
      }
      return max;
    };
    return [...dirs].sort((a, b) => {
      const ax = lastChatAt(a.id) || a.addedAt;
      const bx = lastChatAt(b.id) || b.addedAt;
      return ax < bx ? 1 : ax > bx ? -1 : 0; // descending — newest first
    });
  }, [dirs, convsByDir]);

  // Sidebar search — matches the last path segment (the folder's real name on
  // disk), case-insensitive, so typing "flow" finds ~/Desktop/AgentsFlow even
  // if its display name differs.
  const filteredDirs = useMemo(() => {
    const q = peerQuery.trim().toLowerCase();
    if (!q) return sortedDirs;
    return sortedDirs.filter((d) =>
      (d.path.split('/').filter(Boolean).pop() ?? d.path).toLowerCase().includes(q),
    );
  }, [sortedDirs, peerQuery]);

  // Delegated peer sessions, grouped under the root conversation that spawned
  // them, so they can be rendered as nested child rows.
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const c of convs) {
      if (!c.delegatedByConversationId) continue;
      const list = map.get(c.delegatedByConversationId) ?? [];
      list.push(c);
      map.set(c.delegatedByConversationId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return map;
  }, [convs]);

  // Peer display names for rows that only carry a directoryId (tasks). Falls
  // back to the raw id-less placeholder when the peer is no longer tracked.
  // Open tasks nested under each conversation, oldest first — the sub-rows the
  // "+" on a conversation adds. Keyed by conversation id.
  const todosByConv = useMemo(() => {
    const map = new Map<string, PinnedTodo[]>();
    for (const t of todos) {
      if (t.done || !t.conversationId) continue;
      const list = map.get(t.conversationId) ?? [];
      list.push(t);
      map.set(t.conversationId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return map;
  }, [todos]);

  const dirNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of dirs) m.set(d.id, d.displayName);
    return m;
  }, [dirs]);

  const pinnedItems = useMemo<PinnedItem[]>(() => {
    const convById = new Map(convs.filter((c) => c.pinned).map((c) => [c.id, c]));
    const divById = new Map(dividers.map((d) => [d.id, d]));
    // Tasks nested under a conversation render as that row's children, so they
    // must never surface as standalone rows here.
    const todoById = new Map(todos.filter((t) => !t.done && !t.conversationId).map((t) => [t.id, t]));
    const out: PinnedItem[] = [];
    const used = new Set<string>();
    for (const ref of pinnedOrder) {
      const key = refKey(ref);
      if (used.has(key)) continue;
      if (ref.kind === 'conversation') {
        const c = convById.get(ref.id);
        if (c) { out.push({ kind: 'conversation', id: c.id, ref, conv: c }); used.add(key); }
      } else if (ref.kind === 'todo') {
        const t = todoById.get(ref.id);
        if (t) { out.push({ kind: 'todo', id: t.id, ref, todo: t }); used.add(key); }
      } else {
        const d = divById.get(ref.id);
        if (d) { out.push({ kind: 'divider', id: d.id, ref, divider: d }); used.add(key); }
      }
    }
    // Append any pinned conv not in order (defensive — store usually backfills already).
    for (const c of convById.values()) {
      if (!used.has(`conversation:${c.id}`)) {
        out.push({ kind: 'conversation', id: c.id, ref: { kind: 'conversation', id: c.id }, conv: c });
      }
    }
    // Same defensive append for active tasks (covers the tick between the
    // todos:updated and pinnedOrder:updated broadcasts after adding one).
    for (const t of todoById.values()) {
      if (!used.has(`todo:${t.id}`)) {
        out.push({ kind: 'todo', id: t.id, ref: { kind: 'todo', id: t.id }, todo: t });
      }
    }
    return out;
  }, [convs, dividers, todos, pinnedOrder]);

  // Flat list of keyboard-selectable rows: each pinned item, with its delegated
  // peers interleaved right after their parent. Lets ⌘+↑/↓ step into sub-peers.
  type SelectableRow = { kind: 'item'; idx: number } | { kind: 'child'; id: string; parentIdx: number };
  const selectableRows = useMemo<SelectableRow[]>(() => {
    const rows: SelectableRow[] = [];
    pinnedItems.forEach((it, idx) => {
      rows.push({ kind: 'item', idx });
      if (it.kind === 'conversation') {
        for (const k of childrenByParent.get(it.id) ?? []) rows.push({ kind: 'child', id: k.id, parentIdx: idx });
      }
    });
    return rows;
  }, [pinnedItems, childrenByParent]);

  const historyConvs = useMemo(
    () => (historyDirId ? convs.filter((c) => c.directoryId === historyDirId) : []),
    [convs, historyDirId],
  );

  useEffect(() => {
    if (pinnedItems.length === 0) {
      if (focusedIdx !== -1) setFocusedIdx(-1);
      return;
    }
    if (focusedIdx < 0 || focusedIdx >= pinnedItems.length) {
      setFocusedIdx(0);
    }
  }, [pinnedItems.length, focusedIdx]);

  useEffect(() => {
    const raw = router.query.focus;
    const focusId = Array.isArray(raw) ? raw[0] : raw;
    if (!focusId) return;
    // On return from /session, pinnedItems is briefly empty until refreshAll
    // resolves. Wait for it to populate before we try to resolve the focus —
    // and only clear the URL hint after we've actually applied focus, so an
    // early miss doesn't wipe the hint before the data lands.
    if (pinnedItems.length === 0) return;
    const idx = pinnedItems.findIndex((it) => it.kind === 'conversation' && it.id === focusId);
    if (idx >= 0) {
      setFocusedIdx(idx);
      setSelectedChildId(null);
      router.replace({ pathname: '/' }, undefined, { shallow: true });
      return;
    }
    // Returning from a previewed sub-peer: re-select it under its parent.
    const childConv = convs.find((c) => c.id === focusId && c.delegatedByConversationId);
    if (childConv) {
      const pIdx = pinnedItems.findIndex((it) => it.kind === 'conversation' && it.id === childConv.delegatedByConversationId);
      if (pIdx >= 0) setFocusedIdx(pIdx);
      setSelectedChildId(focusId);
      router.replace({ pathname: '/' }, undefined, { shallow: true });
    }
  }, [router.query.focus, pinnedItems, convs, router]);

  const commitReorder = useCallback(async (nextOrder: PinnedItemRef[]) => {
    setPinnedOrder(nextOrder); // optimistic
    try { await api().reorderPinned(nextOrder); } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[agentsflow] reorderPinned failed', err);
    }
  }, []);

  // Rows leave the list on their own (marked done, unpinned elsewhere) — drop
  // their keys so a stale selection can never move a row that no longer exists.
  useEffect(() => {
    setSelectedKeys((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(pinnedItems.map((it) => refKey(it.ref)));
      const next = new Set<string>();
      prev.forEach((k) => { if (live.has(k)) next.add(k); });
      return next.size === prev.size ? prev : next;
    });
  }, [pinnedItems]);

  const clearSelection = useCallback(() => setSelectedKeys(new Set()), []);
  const selectionCount = selectedKeys.size;

  // Rubber-band selection. It starts ONLY in the gutters around the pinned
  // list — its left/right padding and the strip beneath it — never on a row:
  // pressing a row has always meant "drag this", and that stays true. Sweep the
  // band and every row it crosses highlights. Shift or ⌘ adds to the current
  // selection instead of replacing it.
  // The move/up listeners are attached HERE rather than from an effect — a click
  // fast enough to release before React commits would otherwise never see its
  // mouseup and leave the band armed.
  const handleBandMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    const area = bandAreaRef.current;
    const list = listRef.current;
    if (!target || !area || !list) return;
    // Anything inside a row belongs to that row (drag, open, rename), and the
    // header's own controls keep their behaviour.
    if (target.closest('[data-pinned-key]')) return;
    if (target.closest('input, textarea, [contenteditable="true"], button, a')) return;

    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const band = { x0: e.clientX, y0: e.clientY, base: additive ? new Set(selectedKeys) : new Set<string>(), moved: false };
    dragBlockedRef.current = true;
    setBanding(true);
    // Stops the text selection that would otherwise follow the pointer.
    e.preventDefault();

    const rowBoxes = () => Array.from(list.querySelectorAll<HTMLElement>('[data-pinned-key]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { key: el.dataset.pinnedKey as string, top: r.top, bottom: r.bottom };
    });

    // What the band has caught, kept in a plain variable so mouseup can read it
    // without waiting for a re-render.
    let hits = new Set<string>(band.base);

    const onMove = (ev: MouseEvent) => {
      if (!band.moved && Math.abs(ev.clientY - band.y0) + Math.abs(ev.clientX - band.x0) < 4) return;
      band.moved = true;
      const box = area.getBoundingClientRect();
      setMarquee({
        left: Math.min(band.x0, ev.clientX) - box.left,
        top: Math.min(band.y0, ev.clientY) - box.top,
        width: Math.abs(ev.clientX - band.x0),
        height: Math.abs(ev.clientY - band.y0),
      });
      hits = marqueeHits(rowBoxes(), band.y0, ev.clientY);
      band.base.forEach((k) => hits.add(k));
      setSelectedKeys(hits);
    };

    const onUp = () => {
      teardown();
      if (band.moved) {
        // Swallow the click this drag would otherwise produce, and park focus on
        // the first selected row so Shift+↑/↓ moves the block straight away.
        suppressClickRef.current = true;
        const first = pinnedItems.findIndex((it) => hits.has(refKey(it.ref)));
        if (first >= 0) { setFocusedIdx(first); setSelectedChildId(null); }
      } else {
        // A press in the gutter that never moved is just a click — it drops the
        // selection.
        clearSelection();
      }
    };

    const teardown = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      bandTeardownRef.current = null;
      dragBlockedRef.current = false;
      setBanding(false);
      setMarquee(null);
    };

    bandTeardownRef.current = teardown;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // A band left armed by an unmount (navigating into a session mid-drag) would
  // leak its window listeners.
  useEffect(() => () => bandTeardownRef.current?.(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (historyDirId) return;
      if (globalNoteFile) return; // the quick-look modal owns the keyboard
      if (view === 'stats') return;
      if (pinnedItems.length === 0) return;

      const target = e.target as HTMLElement | null;
      const inEditable = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      // ⌘+↑/↓/→ — navigation / open. Works even inside the spawn prompt.
      // Shift is deliberately excluded: ⇧⌘← / ⇧⌘→ are left for text selection,
      // so holding Shift never triggers navigation.
      if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          setKeyboardNavActive(true);
          // Step through the flat list (pinned items + their sub-peers).
          const cur = selectedChildId
            ? selectableRows.findIndex((r) => r.kind === 'child' && r.id === selectedChildId)
            : selectableRows.findIndex((r) => r.kind === 'item' && r.idx === focusedIdx);
          const base = cur < 0 ? 0 : cur;
          const nextIdx = e.key === 'ArrowDown'
            ? Math.min(selectableRows.length - 1, base + 1)
            : Math.max(0, base - 1);
          const r = selectableRows[nextIdx];
          if (!r) return;
          if (r.kind === 'item') { setFocusedIdx(r.idx); setSelectedChildId(null); }
          else { setFocusedIdx(r.parentIdx); setSelectedChildId(r.id); }
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (selectedChildId) {
            const child = convs.find((c) => c.id === selectedChildId);
            if (child?.sessionId) router.push({ pathname: '/session', query: { id: child.id } });
          } else if (focusedIdx >= 0 && focusedIdx < pinnedItems.length) {
            const item = pinnedItems[focusedIdx];
            if (item.kind === 'conversation' && item.conv.sessionId) {
              router.push({ pathname: '/session', query: { id: item.id } });
            } else if (item.kind === 'todo') {
              // Nothing to open — a task has no session; edit it instead.
              setPendingEditTodoId(item.id);
            }
          }
          return;
        }
      }

      // Esc — drop a multi-selection (the list itself has no other Esc use).
      // A modal open on top owns Escape first, so don't steal it from there.
      if (e.key === 'Escape' && !inEditable && !helpOpen && !mcpOpen && selectedKeys.size > 0) {
        e.preventDefault();
        clearSelection();
        return;
      }

      // Shift+↑/↓ — reorder. Moves the whole checked block when the focused row
      // is part of it, otherwise just the focused row. Don't fight
      // text-selection inside inputs.
      if (e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey && !inEditable) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          if (focusedIdx < 0 || focusedIdx >= pinnedItems.length) return;
          const order = pinnedItems.map((it) => it.ref);
          const focusedKey = refKey(order[focusedIdx]);
          const moving = selectedKeys.has(focusedKey) ? new Set(selectedKeys) : new Set([focusedKey]);
          const dropIdx = blockStepDropIndex(order.map(refKey), moving, e.key === 'ArrowUp' ? 'up' : 'down');
          if (dropIdx === null) return;
          const next = moveRefsTo(order, moving, dropIdx);
          if (!next) return;
          e.preventDefault();
          setKeyboardNavActive(true);
          const landed = next.findIndex((r) => refKey(r) === focusedKey);
          if (landed >= 0) setFocusedIdx(landed);
          commitReorder(next);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinnedItems, focusedIdx, selectedChildId, selectableRows, convs, router, historyDirId, commitReorder, view, globalNoteFile, selectedKeys, clearSelection, helpOpen, mcpOpen]);

  useEffect(() => {
    if (!keyboardNavActive) return;
    const onMove = () => setKeyboardNavActive(false);
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [keyboardNavActive]);

  const handleAddDirectory = async () => {
    const dir = await api().addDirectory();
    if (dir) {
      const all = await api().listDirectories();
      setDirs(all);
      setSelectedDirId(dir.id);
    }
  };

  // `directoryId` overrides the sidebar selection — the Performance monitor's
  // Ask composer picks its own target, and the modal covers the sidebar.
  const handleSpawn = async (prompt: string, attachments: string[] = [], model?: string, directoryId?: string) => {
    const dir = (directoryId ? dirs.find((d) => d.id === directoryId) : null) ?? selectedDir;
    if (!dir) return;
    // Snapshot pinned conv ids *before* the spawn so the effect below can focus whichever
    // new conv lands first — the optimistic broadcast usually arrives well before the
    // spawnAgent IPC resolves, and we want the focus to follow it without delay.
    awaitingNewConvRef.current = new Set(
      pinnedItems.filter((it) => it.kind === 'conversation').map((it) => it.id),
    );
    await api().spawnAgent({ directoryId: dir.id, prompt, attachments, model });
    const c = await api().listConversations();
    setConvs(c);
  };

  // Detect the newly-spawned conv as soon as it lands in pinnedItems.
  useEffect(() => {
    const expecting = awaitingNewConvRef.current;
    if (!expecting) return;
    for (let i = 0; i < pinnedItems.length; i++) {
      const it = pinnedItems[i];
      if (it.kind === 'conversation' && !expecting.has(it.id)) {
        setFocusedIdx(i);
        setPendingFocusConvId(it.id);
        setJustAddedConvId(it.id);
        awaitingNewConvRef.current = null;
        return;
      }
    }
  }, [pinnedItems]);

  // The conversations:updated and pinnedOrder:updated broadcasts can arrive in separate
  // ticks. While the former has fired but the latter hasn't, the new conv sits at the end
  // of pinnedItems via the defensive fallback in the useMemo above — focusing there would
  // strand the cursor on a stale row once pinnedOrder lands. Keep re-resolving focusedIdx
  // from the conv id until the conv is actually in pinnedOrder (its slot is then stable).
  useEffect(() => {
    if (!pendingFocusConvId) return;
    const idx = pinnedItems.findIndex(
      (it) => it.kind === 'conversation' && it.id === pendingFocusConvId,
    );
    if (idx < 0) return;
    setFocusedIdx(idx);
    if (pinnedOrder.some((r) => r.kind === 'conversation' && r.id === pendingFocusConvId)) {
      setPendingFocusConvId(null);
    }
  }, [pendingFocusConvId, pinnedItems, pinnedOrder]);

  // Re-aim focus after a row is finished. We wait until the finished row has
  // actually left pinnedItems so the target's index is resolved against the
  // post-removal list (never a stale one), then land on the chosen neighbour.
  useEffect(() => {
    const pending = pendingDoneRef.current;
    if (!pending) return;
    if (pinnedItems.some((it) => refKey(it.ref) === pending.doneKey)) return;
    const idx = pinnedItems.findIndex((it) => refKey(it.ref) === pending.targetKey);
    pendingDoneRef.current = null;
    if (idx >= 0) { setFocusedIdx(idx); setSelectedChildId(null); }
  }, [pinnedItems]);

  // Clear the "just added" highlight once the row-just-added animation has run.
  useEffect(() => {
    if (!justAddedConvId) return;
    const t = setTimeout(() => setJustAddedConvId(null), 1200);
    return () => clearTimeout(t);
  }, [justAddedConvId]);

  const attach = (c: Conversation) => {
    // eslint-disable-next-line no-console
    console.log('[agentsflow] attach()', { id: c.id, sessionId: c.sessionId });
    if (!c.sessionId) {
      // eslint-disable-next-line no-console
      console.warn('[agentsflow] attach aborted: no sessionId yet');
      return;
    }
    router.push({ pathname: '/session', query: { id: c.id } });
  };

  // Finish a row — unpin its conversation or mark its task done — and move
  // focus to a sensible neighbour. We prefer the nearest real row BEFORE the
  // finished one (the user's "step back up the list"), then fall back to the
  // nearest one AFTER it. Separators are skipped on both passes, so finishing
  // the last item in a separator-bounded group lands focus on the previous
  // item, not the separator. Only when nothing else remains does focus fall
  // back (via the bounds check) to whatever's left.
  const markDone = (idx: number) => {
    const item = pinnedItems[idx];
    if (!item || item.kind === 'divider') return;
    let target: PinnedItem | undefined;
    for (let j = idx - 1; j >= 0 && !target; j--) {
      if (pinnedItems[j].kind !== 'divider') target = pinnedItems[j];
    }
    for (let j = idx + 1; j < pinnedItems.length && !target; j++) {
      if (pinnedItems[j].kind !== 'divider') target = pinnedItems[j];
    }
    pendingDoneRef.current = target
      ? { doneKey: refKey(item.ref), targetKey: refKey(target.ref) }
      : null;
    if (item.kind === 'conversation') {
      api().setConversationPinned(item.id, false).then(refreshAll);
    } else {
      api().setTodoDone(item.id, true).then(refreshAll);
    }
  };

  const handleAddDivider = async () => {
    const afterRef = focusedIdx >= 0 && focusedIdx < pinnedItems.length
      ? pinnedItems[focusedIdx].ref
      : null;
    const divider = await api().addDivider(afterRef);
    setPendingRenameDividerId(divider.id);
    // Focus the newly added divider once it lands in pinnedOrder.
  };

  // Focus newly created divider after it appears in pinnedItems.
  useEffect(() => {
    if (!pendingRenameDividerId) return;
    const idx = pinnedItems.findIndex((it) => it.kind === 'divider' && it.id === pendingRenameDividerId);
    if (idx >= 0) setFocusedIdx(idx);
  }, [pendingRenameDividerId, pinnedItems]);

  // Add a task scoped to a specific peer — the "+" on that peer's sidebar card
  // names the scope explicitly. It lands right below the focused row (staying
  // in its section), else at the end of the first section — same placement as
  // a fresh spawn.
  const handleAddTodo = async (dir: TrackedDirectory) => {
    const afterRef = focusedIdx >= 0 && focusedIdx < pinnedItems.length
      ? pinnedItems[focusedIdx].ref
      : null;
    const todo = await api().addTodo(dir.id, afterRef);
    setPendingEditTodoId(todo.id);
  };

  // Add a task nested under a conversation — the "+" on that row. It inherits
  // the conversation's peer and lives as a child row, so it never takes a slot
  // in the flat pinned order.
  const handleAddConvTodo = async (conv: Conversation) => {
    const todo = await api().addTodo(conv.directoryId, null, conv.id);
    setPendingEditTodoId(todo.id);
    await refreshAll();
  };

  // Focus the newly created task once it lands, so its editor opens in place.
  useEffect(() => {
    if (!pendingEditTodoId) return;
    const idx = pinnedItems.findIndex((it) => it.kind === 'todo' && it.id === pendingEditTodoId);
    if (idx >= 0) { setFocusedIdx(idx); setSelectedChildId(null); }
  }, [pendingEditTodoId, pinnedItems]);

  const handleDragStart = (key: string) => (e: React.DragEvent) => {
    // A rubber band is being swept across this row — not a reorder drag.
    if (dragBlockedRef.current) { e.preventDefault(); return; }
    setDragKey(key);
    // Grabbing a selected row drags the whole selection; grabbing an unselected
    // one moves just it and leaves the selection alone.
    setDragSet(selectedKeys.has(key) ? new Set(selectedKeys) : new Set([key]));
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', key); } catch { /* some browsers throw on synthetic events */ }
    // The draggable element IS the whole unit (a conversation + its delegated
    // peer rows), so its own box is the right drag ghost.
    try { e.dataTransfer.setDragImage(e.currentTarget as HTMLElement, 24, 16); } catch { /* not supported */ }
  };

  const handleDragEnd = () => {
    setDragKey(null);
    setDragSet(null);
    setDropTargetIdx(null);
  };

  const handleRowDragOver = (idx: number) => (e: React.DragEvent) => {
    if (!dragKey) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    setDropTargetIdx(before ? idx : idx + 1);
  };

  const handleListDragLeave = (e: React.DragEvent) => {
    // Only clear when leaving the list container itself.
    if (e.currentTarget === e.target) setDropTargetIdx(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const moving = dragSet ?? (dragKey ? new Set([dragKey]) : null);
    const drop = dropTargetIdx;
    const grabbed = dragKey;
    setDragKey(null);
    setDragSet(null);
    setDropTargetIdx(null);
    if (!moving || drop === null) return;
    const next = moveRefsTo(pinnedItems.map((it) => it.ref), moving, drop);
    if (!next) return;
    // Keep focus on the row that was actually grabbed, wherever it landed.
    if (grabbed) {
      const idx = next.findIndex((r) => refKey(r) === grabbed);
      if (idx >= 0) setFocusedIdx(idx);
    }
    commitReorder(next);
  };

  const handleRemoveDirectory = async (dir: TrackedDirectory) => {
    const count = convsByDir.get(dir.id)?.length ?? 0;
    const tail = count > 0
      ? ` Its ${count} conversation${count === 1 ? '' : 's'} will be kept and restored if you track this path again.`
      : '';
    if (!window.confirm(`Remove "${dir.displayName}" from tracking?${tail}`)) return;
    await api().removeDirectory(dir.id);
    if (historyDirId === dir.id) setHistoryDirId(null);
    if (selectedDirId === dir.id) setSelectedDirId(null);
    await refreshAll();
  };

  return (
    <div className="h-screen flex flex-col">
      <header className="shrink-0 px-4 py-2.5 border-b border-border flex items-center justify-between" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        {view === 'stats' ? (
          <button
            onClick={() => setView('home')}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className="ml-24 px-2 py-1 rounded hover:bg-panel2 text-sm text-muted hover:text-text flex items-center gap-1"
            title="Back to home"
          >
            ← Back
          </button>
        ) : (
        <div className="flex items-center gap-2.5 pl-24">
          <svg viewBox="0 0 1024 1024" width="20" height="20" aria-hidden="true" className="shrink-0">
            <rect x="0" y="0" width="1024" height="1024" rx="232" ry="232" fill="#181b25" />
            <circle cx="282" cy="372" r="34" fill="#ff7847" />
            <circle cx="282" cy="512" r="34" fill="#ff7847" fillOpacity="0.78" />
            <circle cx="282" cy="652" r="34" fill="#ff7847" fillOpacity="0.52" />
            <rect x="350" y="340" width="394" height="64" rx="32" ry="32" fill="#ff7847" />
            <rect x="350" y="480" width="310" height="64" rx="32" ry="32" fill="#ff7847" fillOpacity="0.78" />
            <rect x="350" y="620" width="226" height="64" rx="32" ry="32" fill="#ff7847" fillOpacity="0.52" />
          </svg>
          <span className="font-semibold text-sm tracking-tight">Peers Flow</span>
          {bridgeHealth && (
            <button
              onClick={() => setMcpOpen(true)}
              title={
                bridgeHealth.healthy
                  ? 'Delegation bridge live — delegations spawn watchable sub-peer sessions. Click for details.'
                  : 'Delegation bridge DOWN — delegations run headless & unwatchable (no sub-peer row). Restart Peers Flow. Click for details.'
              }
              aria-label={bridgeHealth.healthy ? 'Delegation bridge live' : 'Delegation bridge down'}
              className="shrink-0 flex items-center"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  bridgeHealth.healthy ? 'bg-emerald-400/80' : 'bg-red-400 animate-pulse ring-2 ring-red-500/30'
                }`}
              />
            </button>
          )}
        </div>
        )}
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="shrink-0 w-6 h-6 rounded-md border border-border bg-panel hover:bg-panel2 hover:border-accent text-muted hover:text-accent flex flex-col items-center justify-center gap-[3px]"
              title="Menu"
              aria-label="Open menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className="block w-3 h-px bg-current" />
              <span className="block w-3 h-px bg-current" />
              <span className="block w-3 h-px bg-current" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div
                  role="menu"
                  className="absolute right-0 mt-1.5 z-50 w-40 rounded-lg border border-border bg-panel shadow-2xl py-1"
                >
                  {([
                    { key: 'home', label: 'Home view' },
                    { key: 'stats', label: 'Stats view' },
                  ] as const).map((opt) => (
                    <button
                      key={opt.key}
                      role="menuitemradio"
                      aria-checked={view === opt.key}
                      onClick={() => { setView(opt.key); setMenuOpen(false); }}
                      className={`w-full text-left px-3 py-1.5 text-sm flex items-center justify-between hover:bg-panel2 ${
                        view === opt.key ? 'text-accent' : 'text-text'
                      }`}
                    >
                      {opt.label}
                      {view === opt.key && <span className="text-accent">✓</span>}
                    </button>
                  ))}
                  <div className="my-1 border-t border-border" />
                  <button
                    role="menuitem"
                    onClick={() => { setMcpOpen(true); setMenuOpen(false); }}
                    className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 text-text hover:bg-panel2"
                    title="Sibling-agent awareness & delegation"
                  >
                    <span className="text-accent">⚡</span>
                    MCP server
                  </button>
                </div>
              </>
            )}
          </div>
          {/* Live performance pill — machine CPU + main-loop lag, coloured by
              severity. Click opens the full monitor (per-agent CPU, what each
              agent's tools are doing, who owns the heavy processes). */}
          <PerfLauncher dirs={dirs} targetDir={selectedDir} onSend={handleSpawn} />
          <button
            onClick={() => setHelpOpen(true)}
            className="shrink-0 w-6 h-6 rounded-full border border-border bg-panel hover:bg-panel2 hover:border-accent text-muted hover:text-accent text-[12px] font-semibold flex items-center justify-center"
            title="Shortcuts & info"
            aria-label="Open help"
          >ⓘ</button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        {view === 'stats' ? (
          <div className="h-full overflow-y-auto">
            <StatsView dirs={dirs} convs={convs} />
          </div>
        ) : (
        // Two independently scrolling panes: the Tracked Peers picker as a
        // compact left sidebar, conversations + history on the right.
        <div className="h-full flex">
        <aside className="w-72 shrink-0 border-r border-border flex flex-col min-h-0">
          <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4">
          {/* Sticky, color-marked zone header so "these are the peers" reads at a
              glance and stays labeled while the list scrolls. Orange marker ties
              it to the peer selection accent. */}
          <h2 className="sticky top-0 z-10 -mx-3 px-3 py-2.5 mb-1 bg-bg/95 backdrop-blur-sm border-b border-border/40 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <span className="w-1 h-4 rounded-full bg-accent shrink-0" aria-hidden="true" />
            Tracked Peers
          </h2>
          <input
            value={peerQuery}
            onChange={(e) => setPeerQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setPeerQuery('');
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Search peers…"
            aria-label="Search tracked peers by folder name"
            className="w-full mb-2 bg-panel border border-border rounded-md px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent placeholder:text-muted/70"
          />
          <button
            onClick={handleAddDirectory}
            className="w-full rounded-md border-2 border-dashed border-border bg-transparent hover:border-accent hover:bg-panel/40 transition-colors px-2.5 py-1.5 text-left mb-2"
          >
            <div className="text-sm font-medium text-text">+ Add directory</div>
            <div className="text-[11px] text-muted">track a new peer</div>
          </button>
          <div className="flex flex-col gap-1.5">
            {filteredDirs.length === 0 && peerQuery.trim() !== '' && (
              <div className="text-xs text-muted px-1 py-1.5">No peers match “{peerQuery.trim()}”.</div>
            )}
            {filteredDirs.map((d) => (
              <DirectoryCard
                key={d.id}
                dir={d}
                selected={d.id === selectedDirId}
                historyCount={convsByDir.get(d.id)?.length ?? 0}
                onSelect={() => setSelectedDirId(d.id)}
                onAddTask={() => handleAddTodo(d)}
                onViewHistory={() => setHistoryDirId(d.id)}
                onPreview={() => router.push({ pathname: '/preview', query: { dir: d.id } })}
                onRemove={() => handleRemoveDirectory(d)}
              />
            ))}
          </div>
          </div>
          {/* Bottom utility cluster — Usage + Global Notes as INSET CARDS on the
              darker app background, with real gaps, so they read as a separate
              docked layer rather than melting into the scrolling peer list. */}
          <div className="shrink-0 min-h-0 flex flex-col gap-2 px-2 py-2 border-t-2 border-border bg-bg shadow-[0_-10px_18px_-10px_rgba(0,0,0,0.7)]">
            {/* The switchable Anthropic account pool, directly above the meters
                it explains: when one account runs dry, click another and every
                session — running and new — continues on its tokens. */}
            <AccountsPanel />
            {/* Live plan-usage meters (Current session / All models / per-model
                weekly). Polls the same authenticated endpoint that backs Claude
                Code's /usage screen. */}
            <UsagePanel />
            {/* Global notes — shared across every peer. Collapsed by default;
                open/expanded state persists just like a peer's own notes.
                Clicking a note opens the quick-look modal. */}
            <NotesPanel
              variant="global"
              onFileOpen={(abs) => setGlobalNoteFile(abs)}
              openedFilePath={globalNoteFile}
            />
          </div>
        </aside>

        <div className="flex-1 min-w-0 overflow-y-auto pb-4">
        {/* The band is drawn from the gutters AROUND the list — its left/right
            padding and the strip below it. Pressing a row is always a drag. */}
        <section
          ref={bandAreaRef}
          className={`relative px-4 pt-4 pb-5 ${banding ? 'select-none' : ''}`}
          onMouseDown={handleBandMouseDown}
          onClickCapture={(e) => {
            // The click that ends a band sweep must not reach whatever the
            // pointer happened to be released over.
            if (!suppressClickRef.current) return;
            suppressClickRef.current = false;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {marquee && (
            <div
              data-testid="pinned-marquee"
              className="absolute z-20 pointer-events-none rounded-[3px] border border-accent bg-accent/15"
              style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}
            />
          )}
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs uppercase tracking-wider text-muted">Pinned conversations</h2>
            <div className="flex items-center gap-1.5">
              {selectionCount > 0 && (
                <div className="flex items-center gap-2 mr-1.5 rounded-md border border-accent/50 bg-accent/10 px-2 py-0.5">
                  <span className="text-[11px] font-semibold text-accent">{selectionCount} selected</span>
                  <button
                    onClick={clearSelection}
                    className="text-[10px] uppercase tracking-wider text-muted hover:text-text border border-border hover:border-accent rounded px-1.5 py-0.5"
                    title="Clear selection (Esc) · drag any selected row to move them all · Shift+↑/↓"
                  >Clear</button>
                </div>
              )}
              {/* Add task now lives on each peer's sidebar card (the "+"), so the
                  scope is picked at the source instead of relying on selection. */}
              <button
                onClick={handleAddDivider}
                className="text-[11px] text-muted hover:text-accent hover:border-accent border border-border bg-panel hover:bg-panel2 rounded px-2 py-0.5"
                title="Insert a labeled separator above the focused row"
              >+ Add separator</button>
            </div>
          </div>
          <div
            ref={listRef}
            className="rounded-lg border border-border bg-panel/50 overflow-hidden"
            onDragOver={(e) => { if (dragKey) e.preventDefault(); }}
            onDragLeave={handleListDragLeave}
            onDrop={handleDrop}
          >
            <div className="grid grid-cols-[16px_200px_minmax(0,1fr)_auto] gap-3 px-4 py-2 text-[10px] uppercase tracking-wider text-muted border-b border-border">
              <div></div>
              <div>Peer</div>
              <div>Title</div>
              <div></div>
            </div>
            {pinnedItems.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted text-center">
                No pinned conversations. Spawn one below — every new conversation is pinned by default; unpin keeps it in the directory's history.
              </div>
            ) : (
              pinnedItems.map((item, i) => {
                const key = refKey(item.ref);
                const moving = dragKey !== null && (dragSet?.has(key) ?? dragKey === key);
                const showInsertBefore = dropTargetIdx === i && dragKey !== null && !moving;
                const showInsertAfter = dropTargetIdx === i + 1 && i === pinnedItems.length - 1 && dragKey !== null && !moving;
                const kids = item.kind === 'conversation' ? (childrenByParent.get(item.id) ?? []) : [];
                const tasks = item.kind === 'conversation' ? (todosByConv.get(item.id) ?? []) : [];
                const hasKids = kids.length > 0 || tasks.length > 0;
                const focused = i === focusedIdx;
                const rowSelected = selectedKeys.has(key);
                const beingDragged = moving;
                // A conversation + its delegated peers form one DRAGGABLE unit, but
                // each row SELECTS and HOVERS independently (so a peer can be
                // previewed on its own). The wrapper only owns drag + the closing
                // bottom border; the grip lives on the parent row, never the peer.
                const unitCls = `relative ${hasKids ? 'border-b border-b-border' : ''} ${beingDragged ? 'opacity-60' : ''}`;
                return (
                  <div key={key} data-pinned-key={key} onDragOver={handleRowDragOver(i)}>
                    {showInsertBefore && <div className="h-0.5 bg-accent" />}
                    {item.kind === 'conversation' ? (
                      <div
                        className={unitCls}
                        draggable={editingKey !== key}
                        onDragStart={handleDragStart(key)}
                        onDragEnd={handleDragEnd}
                      >
                        <PinnedRow
                          conv={item.conv}
                          focused={i === focusedIdx && !selectedChildId}
                          selected={rowSelected}
                          suppressHover={keyboardNavActive}
                          hideBottomBorder={hasKids}
                          justAdded={item.id === justAddedConvId}
                          onFocus={() => { setFocusedIdx(i); setSelectedChildId(null); }}
                          onAttach={() => attach(item.conv)}
                          onSaveTitle={(t) => api().updateConversationTitle(item.id, t).then(refreshAll)}
                          onMarkDone={() => markDone(i)}
                          onAddTask={() => handleAddConvTodo(item.conv)}
                          taskCount={tasks.length}
                          onEditingChange={(ed) => setEditingKey((cur) => (ed ? key : cur === key ? null : cur))}
                          draggable={false}
                        />
                        {hasKids && (
                          // Sub-rows span the FULL width (so hover/selection isn't
                          // clipped on the left); only their content is indented.
                          // Delegated peers first, then the tasks the user parked
                          // on this conversation.
                          <div className="relative">
                            {kids.map((child) => (
                              <DelegatedChildRow
                                key={child.id}
                                conv={child}
                                selected={selectedChildId === child.id}
                                onAttach={() => { setSelectedChildId(child.id); attach(child); }}
                              />
                            ))}
                            {tasks.map((t) => (
                              <TodoChildRow
                                key={t.id}
                                todo={t}
                                startInEdit={pendingEditTodoId === t.id}
                                onEditHandled={() => setPendingEditTodoId(null)}
                                onSaveText={(text) => api().updateTodoText(t.id, text).then(refreshAll)}
                                onToggleDone={() => api().setTodoDone(t.id, true).then(refreshAll)}
                                onRemove={() => api().removeTodo(t.id).then(refreshAll)}
                                onEditingChange={(ed) => setEditingKey((cur) => (ed ? key : cur === key ? null : cur))}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    ) : item.kind === 'todo' ? (
                      <TodoRow
                        todo={item.todo}
                        peerName={dirNameById.get(item.todo.directoryId) ?? '?'}
                        focused={focused && !selectedChildId}
                        selected={rowSelected}
                        suppressHover={keyboardNavActive}
                        startInEdit={pendingEditTodoId === item.id}
                        onEditHandled={() => setPendingEditTodoId(null)}
                        onFocus={() => { setFocusedIdx(i); setSelectedChildId(null); }}
                        onSaveText={(t) => api().updateTodoText(item.id, t).then(refreshAll)}
                        onToggleDone={() => markDone(i)}
                        onRemove={() => api().removeTodo(item.id).then(refreshAll)}
                        onEditingChange={(ed) => setEditingKey((cur) => (ed ? key : cur === key ? null : cur))}
                        draggable={editingKey !== key}
                        onDragStart={handleDragStart(key)}
                        onDragEnd={handleDragEnd}
                      />
                    ) : (
                      <DividerRow
                        divider={item.divider}
                        focused={focused}
                        selected={rowSelected}
                        suppressHover={keyboardNavActive}
                        startInRename={pendingRenameDividerId === item.id}
                        onRenameHandled={() => setPendingRenameDividerId(null)}
                        onFocus={() => setFocusedIdx(i)}
                        onSaveTitle={(t) => api().renameDivider(item.id, t)}
                        onRemove={() => api().removeDivider(item.id)}
                        draggable
                        onDragStart={handleDragStart(key)}
                        onDragEnd={handleDragEnd}
                      />
                    )}
                    {showInsertAfter && <div className="h-0.5 bg-accent" />}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <HistoryTimeline
          conversations={convs}
          todos={todos}
          dirs={sortedDirs}
          onAttach={(c) => attach(c)}
          onTogglePin={(c) => api().setConversationPinned(c.id, !c.pinned).then(refreshAll)}
          onRemove={(c) => {
            if (!window.confirm(`Stop and remove "${c.title || 'this conversation'}" permanently?`)) return;
            api().removeAgent(c.id).then(refreshAll);
          }}
          onRestoreTodo={(t) => api().setTodoDone(t.id, false).then(refreshAll)}
          onRemoveTodo={(t) => {
            if (!window.confirm(`Remove the task "${t.text || 'untitled'}" permanently?`)) return;
            api().removeTodo(t.id).then(refreshAll);
          }}
        />

        </div>
        </div>
        )}
      </main>

      {view !== 'stats' && <SpawnBar targetDir={selectedDir} onSend={handleSpawn} />}

      {globalNoteFile && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-bg/80 backdrop-blur-sm p-6"
          onMouseDown={() => setGlobalNoteFile(null)}
        >
          <div
            className="w-[min(1100px,92vw)] h-[88vh] rounded-lg border border-border bg-bg shadow-2xl overflow-hidden flex flex-col"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-panel/60">
              <span className="text-[10px] uppercase tracking-wider text-muted shrink-0">Global note</span>
              <span className="flex-1" />
              <button
                onClick={() => setGlobalNoteFile(null)}
                className="text-muted hover:text-text text-sm px-2 py-0.5 rounded hover:bg-panel2"
                title="Close (Esc)"
                aria-label="Close preview"
              >Close ✕</button>
            </div>
            <div className="flex-1 min-h-0">
              <FileEditor filePath={globalNoteFile} baseDir={globalNotesRoot ?? undefined} autoFocus />
            </div>
          </div>
        </div>
      )}

      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}

      {mcpOpen && <McpModal onClose={() => setMcpOpen(false)} />}

      {historyDir && (
        <HistoryModal
          dir={historyDir}
          conversations={historyConvs}
          onClose={() => setHistoryDirId(null)}
          onAttach={(c) => { setHistoryDirId(null); attach(c); }}
          onTogglePin={(c) => api().setConversationPinned(c.id, !c.pinned).then(refreshAll)}
          onRemove={(c) => {
            if (!window.confirm(`Stop and remove "${c.title || 'this conversation'}" permanently?`)) return;
            api().removeAgent(c.id).then(refreshAll);
          }}
        />
      )}
    </div>
  );
}
