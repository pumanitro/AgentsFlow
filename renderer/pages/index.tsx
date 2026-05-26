import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import PinnedRow from '../components/PinnedRow';
import DirectoryCard from '../components/DirectoryCard';
import SpawnBar from '../components/SpawnBar';
import HistoryModal from '../components/HistoryModal';
import HelpModal from '../components/HelpModal';
import { api } from '../lib/ipc';
import { Conversation, TrackedDirectory } from '../../shared/types';

export default function Home() {
  const router = useRouter();
  const [dirs, setDirs] = useState<TrackedDirectory[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [selectedDirId, setSelectedDirId] = useState<string | null>(null);
  const [focusedConvIdx, setFocusedConvIdx] = useState<number>(-1);
  const [historyDirId, setHistoryDirId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const refreshAll = async () => {
    const [d, c] = await Promise.all([api().listDirectories(), api().listConversations()]);
    setDirs(d);
    setConvs(c);
  };

  useEffect(() => { refreshAll(); }, []);

  useEffect(() => {
    const off = api().onConversationsUpdated((next) => setConvs(next));
    return off;
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

  const pinnedConvs = useMemo(
    () => convs.filter((c) => c.pinned).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [convs],
  );
  const historyConvs = useMemo(
    () => (historyDirId ? convs.filter((c) => c.directoryId === historyDirId) : []),
    [convs, historyDirId],
  );

  useEffect(() => {
    if (pinnedConvs.length === 0) {
      if (focusedConvIdx !== -1) setFocusedConvIdx(-1);
      return;
    }
    if (focusedConvIdx < 0 || focusedConvIdx >= pinnedConvs.length) {
      setFocusedConvIdx(0);
    }
  }, [pinnedConvs.length, focusedConvIdx]);

  useEffect(() => {
    const raw = router.query.focus;
    const focusId = Array.isArray(raw) ? raw[0] : raw;
    if (!focusId) return;
    const idx = pinnedConvs.findIndex((c) => c.id === focusId);
    if (idx >= 0) setFocusedConvIdx(idx);
    router.replace({ pathname: '/' }, undefined, { shallow: true });
  }, [router.query.focus, pinnedConvs, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (historyDirId) return;
      if (pinnedConvs.length === 0) return;

      if (e.key === 'ArrowDown' && !e.metaKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        setFocusedConvIdx((i) => Math.min(pinnedConvs.length - 1, Math.max(0, i + 1)));
      } else if (e.key === 'ArrowUp' && !e.metaKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        setFocusedConvIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'ArrowRight' && (e.metaKey || e.altKey)) {
        if (focusedConvIdx >= 0 && focusedConvIdx < pinnedConvs.length) {
          e.preventDefault();
          const c = pinnedConvs[focusedConvIdx];
          if (c.sessionId) router.push({ pathname: '/session', query: { id: c.id } });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinnedConvs, focusedConvIdx, router, historyDirId]);

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
    await api().spawnAgent({ directoryId: selectedDir.id, prompt, attachments });
    const c = await api().listConversations();
    setConvs(c);
  };

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

  const handleRemoveDirectory = async (dir: TrackedDirectory) => {
    const count = convsByDir.get(dir.id)?.length ?? 0;
    const msg = count > 0
      ? `Remove "${dir.displayName}"? This will stop and discard ${count} conversation${count === 1 ? '' : 's'} from this directory.`
      : `Remove "${dir.displayName}" from tracking?`;
    if (!window.confirm(msg)) return;
    await api().removeDirectoryWithHistory(dir.id);
    if (historyDirId === dir.id) setHistoryDirId(null);
    if (selectedDirId === dir.id) setSelectedDirId(null);
    await refreshAll();
  };

  return (
    <div className="h-screen flex flex-col">
      <header className="shrink-0 px-4 py-2.5 border-b border-border flex items-center justify-between" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="flex items-center gap-2 pl-24">
          <div className="w-2 h-2 rounded-full bg-accent" />
          <span className="font-semibold text-sm">AgentsFlow</span>
        </div>
        <button
          onClick={() => setHelpOpen(true)}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="shrink-0 w-6 h-6 rounded-full border border-border bg-panel hover:bg-panel2 hover:border-accent text-muted hover:text-accent text-[12px] font-semibold flex items-center justify-center"
          title="Shortcuts & info"
          aria-label="Open help"
        >ⓘ</button>
      </header>

      <main className="flex-1 overflow-y-auto">
        <section className="px-4 pt-4">
          <h2 className="text-xs uppercase tracking-wider text-muted mb-2">Pinned conversations</h2>
          <div className="rounded-lg border border-border bg-panel/50 overflow-hidden">
            <div className="grid grid-cols-[200px_minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 px-4 py-2 text-[10px] uppercase tracking-wider text-muted border-b border-border">
              <div>Agent</div>
              <div>Title</div>
              <div>Description</div>
              <div></div>
            </div>
            {pinnedConvs.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted text-center">
                No pinned conversations. Spawn one below — every new conversation is pinned by default; unpin keeps it in the directory's history.
              </div>
            ) : (
              pinnedConvs.map((c, i) => (
                <PinnedRow
                  key={c.id}
                  conv={c}
                  focused={i === focusedConvIdx}
                  onFocus={() => setFocusedConvIdx(i)}
                  onAttach={() => attach(c)}
                  onSaveTitle={(t) => api().updateConversationTitle(c.id, t, true).then(refreshAll)}
                  onResetTitle={() => api().updateConversationTitle(c.id, c.description || '', false).then(refreshAll)}
                  onMarkDone={() => api().setConversationPinned(c.id, false).then(refreshAll)}
                />
              ))
            )}
          </div>
        </section>

        <section className="px-4 pt-6 pb-4">
          <h2 className="text-xs uppercase tracking-wider text-muted mb-2">Tracked directories</h2>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {dirs.map((d) => (
              <DirectoryCard
                key={d.id}
                dir={d}
                selected={d.id === selectedDirId}
                historyCount={convsByDir.get(d.id)?.length ?? 0}
                onSelect={() => setSelectedDirId(d.id)}
                onViewHistory={() => setHistoryDirId(d.id)}
                onRemove={() => handleRemoveDirectory(d)}
              />
            ))}
            <button
              onClick={handleAddDirectory}
              className="rounded-lg border-2 border-dashed border-border bg-transparent hover:border-accent hover:bg-panel/40 transition-colors px-4 py-3 text-left"
            >
              <div className="font-medium text-text">+ Add directory</div>
              <div className="text-xs text-muted mt-0.5">track a new project</div>
            </button>
          </div>
        </section>
      </main>

      <SpawnBar targetDir={selectedDir} onSend={handleSpawn} />

      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}

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
