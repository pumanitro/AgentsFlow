import { useEffect, useMemo, useRef, useState } from 'react';
import { Conversation, TrackedDirectory } from '../../shared/types';
import { statusDotClass } from '../lib/status';

interface Props {
  conversations: Conversation[];
  // The currently-tracked peers, already in the order the Tracked Peers list
  // shows them — the peer filter chips mirror this set and order exactly.
  dirs: TrackedDirectory[];
  onAttach: (c: Conversation) => void;
  onTogglePin: (c: Conversation) => void;
  onRemove: (c: Conversation) => void;
}

// How many rows to reveal per infinite-scroll page. The full (already-loaded)
// history is kept in memory, but we only ever render this many at a time and
// grow the window as the user scrolls, so opening the panel never paints
// hundreds of rows at once.
const PAGE = 25;

// The timestamp a conversation entered the history: the pin→unpin moment when
// it was marked done, falling back to its creation time for legacy rows that
// predate `unpinnedAt`.
function doneTs(c: Conversation): number {
  const iso = c.unpinnedAt || c.createdAt;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// The clock time a conversation was finished, e.g. "2:43 PM". Shown in its own
// aligned column so the gaps between chats on a given day are easy to scan.
function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Shared chip styling for the peer filter: a strongly highlighted accent fill
// when selected, a quiet bordered pill otherwise.
function chipClass(active: boolean): string {
  return `text-[11px] leading-none px-2 py-1 rounded-md border transition-colors ${
    active
      ? 'bg-accent text-bg border-accent font-semibold'
      : 'text-muted border-border hover:text-text hover:bg-panel2'
  }`;
}

// Day-aligned timeline headers: Today · Yesterday · then the full date for
// every earlier day ("Tuesday, June 2", with the year once it differs from
// the current one).
function bucketOf(ts: number, now: number): string {
  const diffDays = Math.round((dayStart(now) - dayStart(ts)) / 86_400_000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Date(ts).toLocaleDateString(
    undefined,
    sameYear
      ? { weekday: 'long', month: 'long', day: 'numeric' }
      : { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' },
  );
}

export default function HistoryTimeline({ conversations, dirs, onAttach, onTogglePin, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE);
  // Peers selected in the filter. Empty = no filter, i.e. show every peer.
  const [selectedDirIds, setSelectedDirIds] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const dirNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of dirs) m.set(d.id, d.displayName);
    return m;
  }, [dirs]);

  // Newest-first list of everything that's been marked done (unpinned).
  const history = useMemo(
    () => conversations.filter((c) => !c.pinned).sort((a, b) => doneTs(b) - doneTs(a)),
    [conversations],
  );

  // How many history entries each peer (keyed by directoryId) contributes.
  const countByDir = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of history) m.set(c.directoryId, (m.get(c.directoryId) ?? 0) + 1);
    return m;
  }, [history]);

  // Filter chips: the currently-tracked peers that actually have something in
  // history, in the same order as the Tracked Peers list (`dirs` arrives
  // pre-sorted). Deriving from the tracked `dirs` — rather than from the history
  // rows themselves — means peers that are no longer tracked, plus the stale
  // duplicate ids left behind when a path is removed and re-added under a fresh
  // id, never show up as chips: we only ever offer peers still being tracked.
  const peerOptions = useMemo(
    () =>
      dirs
        .map((d) => ({ id: d.id, name: d.displayName, count: countByDir.get(d.id) ?? 0 }))
        .filter((p) => p.count > 0),
    [dirs, countByDir],
  );

  // History narrowed to the selected peers. An empty selection means "all".
  const filtered = useMemo(
    () => (selectedDirIds.size === 0 ? history : history.filter((c) => selectedDirIds.has(c.directoryId))),
    [history, selectedDirIds],
  );

  const togglePeer = (id: string) =>
    setSelectedDirIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Re-stamp "now" each time the panel is opened so relative times are fresh
  // without re-rendering on a timer while it sits closed.
  const now = useMemo(() => Date.now(), [open]);

  // Reset the scroll window every time the panel is (re)opened or the filter
  // changes, so a new selection always starts from the top.
  useEffect(() => {
    if (open) setVisibleCount(PAGE);
  }, [open, selectedDirIds]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  // Infinite scroll: grow the window when the sentinel scrolls into view.
  useEffect(() => {
    if (!open || !hasMore) return;
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((n) => Math.min(filtered.length, n + PAGE));
        }
      },
      { root, rootMargin: '200px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [open, hasMore, filtered.length, visibleCount]);

  let lastBucket: string | null = null;

  return (
    <section className="px-4 pt-6">
      <div className="flex justify-end">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted hover:text-text"
        aria-expanded={open}
        title={open ? 'Hide history' : 'Show history of finished conversations'}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          <path d="M5 3l6 5-6 5V3z" />
        </svg>
        <span>History</span>
        {history.length > 0 && (
          <span className="text-[10px] tabular-nums text-subtle normal-case tracking-normal">
            {history.length}
          </span>
        )}
      </button>
      </div>

      {open && peerOptions.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] uppercase tracking-wider text-subtle">Peers</span>
          <button
            onClick={() => setSelectedDirIds(new Set())}
            className={chipClass(selectedDirIds.size === 0)}
            title="Show every peer"
          >
            All
          </button>
          {peerOptions.map((p) => {
            const active = selectedDirIds.has(p.id);
            return (
              <button
                key={p.id}
                onClick={() => togglePeer(p.id)}
                className={chipClass(active)}
                title={active ? `Hide ${p.name}` : `Show ${p.name}`}
              >
                {p.name}
                <span className={`ml-1.5 text-[9px] tabular-nums ${active ? 'text-bg/80' : 'text-subtle'}`}>
                  {p.count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {open && (
        <div
          ref={scrollRef}
          className="mt-2 rounded-lg border border-border bg-panel/50 overflow-y-auto max-h-[60vh]"
        >
          {history.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted">
              Nothing here yet. Conversations you mark done move into history.
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted">
              No history for the selected peers.
            </div>
          ) : (
            <>
              {visible.map((c) => {
                const ts = doneTs(c);
                const bucket = bucketOf(ts, now);
                const showHeader = bucket !== lastBucket;
                lastBucket = bucket;
                const dirName = dirNameById.get(c.directoryId);
                return (
                  <div key={c.id}>
                    {showHeader && (
                      <div className="sticky top-0 z-10 px-4 py-1.5 text-[10px] uppercase tracking-wider text-subtle bg-panel border-b border-border">
                        {bucket}
                      </div>
                    )}
                    <div className="group grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5 border-b border-border hover:bg-panel2">
                      <span className={`inline-block w-2 h-2 rounded-full mt-1.5 ${statusDotClass(c)}`} />
                      <div className="w-24 shrink-0 min-w-0">
                        {(c.displayName || dirName) && (
                          <div className="truncate text-[10px] uppercase tracking-wider text-subtle">
                            {c.displayName || dirName}
                          </div>
                        )}
                        <div className="text-[11px] text-muted tabular-nums mt-0.5">
                          {timeOfDay(ts)}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-text">
                          {c.title || <span className="text-muted italic">untitled</span>}
                        </div>
                        <div className="truncate text-xs text-muted mt-0.5">
                          {c.description || c.lastPrompt || <span className="italic">—</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onTogglePin(c)}
                          className="text-xs px-2 py-1 rounded text-muted hover:text-accent hover:bg-panel flex items-center gap-1"
                          title="Restore to pinned conversations"
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 100 10 5 5 0 000-10zM2 8a6 6 0 1112 0A6 6 0 012 8zm7-3v3h2v1H8V5h1z" /></svg>
                          Restore
                        </button>
                        <button
                          onClick={() => onAttach(c)}
                          disabled={!c.sessionId}
                          className="text-xs px-2 py-1 rounded text-muted hover:text-text hover:bg-panel disabled:opacity-40 disabled:cursor-not-allowed"
                          title={c.sessionId ? 'Attach terminal' : 'Session is still starting…'}
                        >open →</button>
                        <button
                          onClick={() => onRemove(c)}
                          className="text-xs px-2 py-1 rounded text-muted hover:text-err hover:bg-panel"
                          title="Stop & remove forever"
                        >✕</button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {hasMore && (
                <div ref={sentinelRef} className="px-4 py-4 text-center text-[11px] text-subtle">
                  Loading more…
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
