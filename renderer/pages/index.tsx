import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import PinnedRow from '../components/PinnedRow';
import DelegatedChildRow from '../components/DelegatedChildRow';
import DividerRow from '../components/DividerRow';
import DirectoryCard from '../components/DirectoryCard';
import SpawnBar from '../components/SpawnBar';
import HistoryModal from '../components/HistoryModal';
import HistoryTimeline from '../components/HistoryTimeline';
import HelpModal from '../components/HelpModal';
import McpModal from '../components/McpModal';
import StatsView from '../components/StatsView';
import { api } from '../lib/ipc';
import { useUIState } from '../lib/ui-state';
import { Conversation, PinnedDivider, PinnedItemRef, TrackedDirectory } from '../../shared/types';

type PinnedItem =
  | { kind: 'conversation'; id: string; ref: PinnedItemRef; conv: Conversation }
  | { kind: 'divider'; id: string; ref: PinnedItemRef; divider: PinnedDivider };

function refKey(r: PinnedItemRef): string {
  return `${r.kind}:${r.id}`;
}

export default function Home() {
  const router = useRouter();
  const [dirs, setDirs] = useState<TrackedDirectory[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [dividers, setDividers] = useState<PinnedDivider[]>([]);
  const [pinnedOrder, setPinnedOrder] = useState<PinnedItemRef[]>([]);
  const [selectedDirId, setSelectedDirId] = useUIState('selectedDirId');
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);
  const [keyboardNavActive, setKeyboardNavActive] = useState<boolean>(false);
  const [historyDirId, setHistoryDirId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  // A delegated peer (sub-row) can be selected independently of its root row.
  // When set, the root's own selection highlight is suppressed so only one
  // element — root OR peer — shows the orange selection at a time.
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [view, setView] = useUIState('view');
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingRenameDividerId, setPendingRenameDividerId] = useState<string | null>(null);
  const awaitingNewConvRef = useRef<Set<string> | null>(null);
  // After a task is finished its row vanishes; this records which neighbour to
  // re-focus once the list has actually dropped the finished row, so focus
  // never gets parked on a separator. { doneId, targetId } — see markDone.
  const pendingDoneRef = useRef<{ doneId: string; targetId: string } | null>(null);
  const [pendingFocusConvId, setPendingFocusConvId] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);
  const [justAddedConvId, setJustAddedConvId] = useState<string | null>(null);

  const refreshAll = async () => {
    const [d, c, dv, po] = await Promise.all([
      api().listDirectories(),
      api().listConversations(),
      api().listDividers(),
      api().listPinnedOrder(),
    ]);
    setDirs(d);
    setConvs(c);
    setDividers(dv);
    setPinnedOrder(po);
  };

  useEffect(() => { refreshAll(); }, []);

  useEffect(() => {
    const offC = api().onConversationsUpdated((next) => setConvs(next));
    const offD = api().onDividersUpdated((next) => setDividers(next));
    const offO = api().onPinnedOrderUpdated((next) => setPinnedOrder(next));
    return () => { offC(); offD(); offO(); };
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

  const pinnedItems = useMemo<PinnedItem[]>(() => {
    const convById = new Map(convs.filter((c) => c.pinned).map((c) => [c.id, c]));
    const divById = new Map(dividers.map((d) => [d.id, d]));
    const out: PinnedItem[] = [];
    const used = new Set<string>();
    for (const ref of pinnedOrder) {
      const key = refKey(ref);
      if (used.has(key)) continue;
      if (ref.kind === 'conversation') {
        const c = convById.get(ref.id);
        if (c) { out.push({ kind: 'conversation', id: c.id, ref, conv: c }); used.add(key); }
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
    return out;
  }, [convs, dividers, pinnedOrder]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (historyDirId) return;
      if (view === 'stats') return;
      if (pinnedItems.length === 0) return;

      const target = e.target as HTMLElement | null;
      const inEditable = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      // ⌘+↑/↓/→ — navigation / open. Works even inside the spawn prompt.
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
            }
          }
          return;
        }
      }

      // Shift+↑/↓ — reorder focused row. Don't fight text-selection inside inputs.
      if (e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey && !inEditable) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          if (focusedIdx < 0 || focusedIdx >= pinnedItems.length) return;
          const delta = e.key === 'ArrowUp' ? -1 : 1;
          const nextIdx = focusedIdx + delta;
          if (nextIdx < 0 || nextIdx >= pinnedItems.length) return;
          e.preventDefault();
          setKeyboardNavActive(true);
          const next = pinnedItems.map((it) => it.ref);
          [next[focusedIdx], next[nextIdx]] = [next[nextIdx], next[focusedIdx]];
          setFocusedIdx(nextIdx);
          commitReorder(next);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinnedItems, focusedIdx, selectedChildId, selectableRows, convs, router, historyDirId, commitReorder, view]);

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

  const handleSpawn = async (prompt: string, attachments: string[] = []) => {
    if (!selectedDir) return;
    // Snapshot pinned conv ids *before* the spawn so the effect below can focus whichever
    // new conv lands first — the optimistic broadcast usually arrives well before the
    // spawnAgent IPC resolves, and we want the focus to follow it without delay.
    awaitingNewConvRef.current = new Set(
      pinnedItems.filter((it) => it.kind === 'conversation').map((it) => it.id),
    );
    await api().spawnAgent({ directoryId: selectedDir.id, prompt, attachments });
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

  // Re-aim focus after a task is finished. We wait until the finished row has
  // actually left pinnedItems so the target's index is resolved against the
  // post-removal list (never a stale one), then land on the chosen neighbour.
  useEffect(() => {
    const pending = pendingDoneRef.current;
    if (!pending) return;
    if (pinnedItems.some((it) => it.kind === 'conversation' && it.id === pending.doneId)) return;
    const idx = pinnedItems.findIndex((it) => it.kind === 'conversation' && it.id === pending.targetId);
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

  // Finish a task: unpin its conversation and move focus to a sensible
  // neighbour. We prefer the nearest real conversation BEFORE the finished one
  // (the user's "step back up the list"), then fall back to the nearest one
  // AFTER it. Separators are skipped on both passes, so finishing the last item
  // in a separator-bounded group lands focus on the previous item, not the
  // separator. Only when nothing else remains does focus fall back (via the
  // bounds check) to whatever's left.
  const markDone = (idx: number) => {
    const item = pinnedItems[idx];
    if (!item || item.kind !== 'conversation') return;
    let target: PinnedItem | undefined;
    for (let j = idx - 1; j >= 0 && !target; j--) {
      if (pinnedItems[j].kind === 'conversation') target = pinnedItems[j];
    }
    for (let j = idx + 1; j < pinnedItems.length && !target; j++) {
      if (pinnedItems[j].kind === 'conversation') target = pinnedItems[j];
    }
    pendingDoneRef.current = target ? { doneId: item.id, targetId: target.id } : null;
    api().setConversationPinned(item.id, false).then(refreshAll);
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

  const handleDragStart = (key: string) => (e: React.DragEvent) => {
    setDragKey(key);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', key); } catch { /* some browsers throw on synthetic events */ }
    // The draggable element IS the whole unit (a conversation + its delegated
    // peer rows), so its own box is the right drag ghost.
    try { e.dataTransfer.setDragImage(e.currentTarget as HTMLElement, 24, 16); } catch { /* not supported */ }
  };

  const handleDragEnd = () => {
    setDragKey(null);
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
    if (!dragKey || dropTargetIdx === null) {
      setDragKey(null);
      setDropTargetIdx(null);
      return;
    }
    const fromIdx = pinnedItems.findIndex((it) => refKey(it.ref) === dragKey);
    if (fromIdx < 0) {
      setDragKey(null);
      setDropTargetIdx(null);
      return;
    }
    let toIdx = dropTargetIdx;
    if (toIdx > fromIdx) toIdx -= 1; // splice math: removing item shifts later indices left
    if (toIdx === fromIdx) {
      setDragKey(null);
      setDropTargetIdx(null);
      return;
    }
    const next = pinnedItems.map((it) => it.ref);
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    setFocusedIdx(toIdx);
    setDragKey(null);
    setDropTargetIdx(null);
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
          <button
            onClick={() => setHelpOpen(true)}
            className="shrink-0 w-6 h-6 rounded-full border border-border bg-panel hover:bg-panel2 hover:border-accent text-muted hover:text-accent text-[12px] font-semibold flex items-center justify-center"
            title="Shortcuts & info"
            aria-label="Open help"
          >ⓘ</button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        {view === 'stats' ? (
          <StatsView dirs={dirs} convs={convs} />
        ) : (
        <>
        <section className="px-4 pt-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs uppercase tracking-wider text-muted">Pinned conversations</h2>
            <button
              onClick={handleAddDivider}
              className="text-[11px] text-muted hover:text-accent hover:border-accent border border-border bg-panel hover:bg-panel2 rounded px-2 py-0.5"
              title="Insert a labeled separator above the focused row"
            >+ Add separator</button>
          </div>
          <div
            className="rounded-lg border border-border bg-panel/50 overflow-hidden"
            onDragOver={(e) => { if (dragKey) e.preventDefault(); }}
            onDragLeave={handleListDragLeave}
            onDrop={handleDrop}
          >
            <div className="grid grid-cols-[16px_200px_minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 px-4 py-2 text-[10px] uppercase tracking-wider text-muted border-b border-border">
              <div></div>
              <div>Peer</div>
              <div>Title</div>
              <div>Description</div>
              <div></div>
            </div>
            {pinnedItems.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted text-center">
                No pinned conversations. Spawn one below — every new conversation is pinned by default; unpin keeps it in the directory's history.
              </div>
            ) : (
              pinnedItems.map((item, i) => {
                const key = refKey(item.ref);
                const showInsertBefore = dropTargetIdx === i && dragKey !== null && dragKey !== key;
                const showInsertAfter = dropTargetIdx === i + 1 && i === pinnedItems.length - 1 && dragKey !== null && dragKey !== key;
                const kids = item.kind === 'conversation' ? (childrenByParent.get(item.id) ?? []) : [];
                const hasKids = kids.length > 0;
                const focused = i === focusedIdx;
                const beingDragged = dragKey === key;
                // A conversation + its delegated peers form one DRAGGABLE unit, but
                // each row SELECTS and HOVERS independently (so a peer can be
                // previewed on its own). The wrapper only owns drag + the closing
                // bottom border; the grip lives on the parent row, never the peer.
                const unitCls = `relative ${hasKids ? 'border-b border-b-border' : ''} ${beingDragged ? 'opacity-60' : ''}`;
                return (
                  <div key={key} onDragOver={handleRowDragOver(i)}>
                    {showInsertBefore && <div className="h-0.5 bg-accent" />}
                    {item.kind === 'conversation' ? (
                      <div
                        className={unitCls}
                        draggable
                        onDragStart={handleDragStart(key)}
                        onDragEnd={handleDragEnd}
                      >
                        <PinnedRow
                          conv={item.conv}
                          focused={i === focusedIdx && !selectedChildId}
                          suppressHover={keyboardNavActive}
                          hideBottomBorder={hasKids}
                          justAdded={item.id === justAddedConvId}
                          onFocus={() => { setFocusedIdx(i); setSelectedChildId(null); }}
                          onAttach={() => attach(item.conv)}
                          onSaveTitle={(t) => api().updateConversationTitle(item.id, t).then(refreshAll)}
                          onMarkDone={() => markDone(i)}
                          draggable={false}
                        />
                        {hasKids && (
                          // Peer rows span the FULL width (so hover/selection isn't
                          // clipped on the left); only their content is indented.
                          <div className="relative">
                            {kids.map((child) => (
                              <DelegatedChildRow
                                key={child.id}
                                conv={child}
                                selected={selectedChildId === child.id}
                                onAttach={() => { setSelectedChildId(child.id); attach(child); }}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <DividerRow
                        divider={item.divider}
                        focused={focused}
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
          dirs={dirs}
          onAttach={(c) => attach(c)}
          onTogglePin={(c) => api().setConversationPinned(c.id, !c.pinned).then(refreshAll)}
          onRemove={(c) => {
            if (!window.confirm(`Stop and remove "${c.title || 'this conversation'}" permanently?`)) return;
            api().removeAgent(c.id).then(refreshAll);
          }}
        />

        <section className="px-4 pt-6 pb-4">
          <h2 className="text-xs uppercase tracking-wider text-muted mb-2">Tracked Peers</h2>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {sortedDirs.map((d) => (
              <DirectoryCard
                key={d.id}
                dir={d}
                selected={d.id === selectedDirId}
                historyCount={convsByDir.get(d.id)?.length ?? 0}
                onSelect={() => setSelectedDirId(d.id)}
                onViewHistory={() => setHistoryDirId(d.id)}
                onPreview={() => router.push({ pathname: '/preview', query: { dir: d.id } })}
                onRemove={() => handleRemoveDirectory(d)}
              />
            ))}
            <button
              onClick={handleAddDirectory}
              className="rounded-lg border-2 border-dashed border-border bg-transparent hover:border-accent hover:bg-panel/40 transition-colors px-4 py-3 text-left"
            >
              <div className="font-medium text-text">+ Add directory</div>
              <div className="text-xs text-muted mt-0.5">track a new peer</div>
            </button>
          </div>
        </section>
        </>
        )}
      </main>

      {view !== 'stats' && <SpawnBar targetDir={selectedDir} onSend={handleSpawn} />}

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
