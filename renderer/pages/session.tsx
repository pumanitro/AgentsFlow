import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/ipc';
import { Conversation } from '../../shared/types';
import { statusDotClass } from '../lib/status';

const Terminal = dynamic(() => import('../components/Terminal'), { ssr: false });
const FileTreeSidebar = dynamic(() => import('../components/FileTreeSidebar'), { ssr: false });

export default function SessionPage() {
  const router = useRouter();
  const idParam = router.query.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  const [conv, setConv] = useState<Conversation | null>(null);

  useEffect(() => {
    if (!id) return;
    api().listConversations().then((cs) => {
      setConv(cs.find((c) => c.id === id) ?? null);
    });
    const off = api().onConversationsUpdated((cs) => {
      setConv(cs.find((c) => c.id === id) ?? null);
    });
    return off;
  }, [id]);

  const goBack = useCallback(() => {
    router.push({ pathname: '/', query: id ? { focus: String(id) } : undefined });
  }, [router, id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && (e.metaKey || e.altKey)) {
        e.preventDefault();
        goBack();
      } else if (e.key === 'Escape' && e.shiftKey) {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack]);

  if (!id) return null;

  return (
    <div className="h-screen flex flex-col">
      <header
        className="shrink-0 px-4 py-2.5 border-b border-border flex items-center gap-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <button
          onClick={goBack}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="ml-24 px-2 py-1 rounded hover:bg-panel2 text-sm text-muted hover:text-text flex items-center gap-1"
          title="Back to list (⌘←  or  Shift+Esc)"
        >
          ← Back
        </button>
        <div className="min-w-0 flex items-center gap-2">
          {conv && (
            <span
              className={`shrink-0 inline-block w-2 h-2 rounded-full ${statusDotClass(conv)}`}
              title={conv.state || conv.status || 'idle'}
            />
          )}
          <span className="text-sm font-medium text-text shrink-0">{conv?.displayName ?? '…'}</span>
          {(conv?.title || conv?.description) && (
            <>
              <span className="text-muted text-xs">·</span>
              <span className="text-sm text-text/85 truncate min-w-0">{conv?.title || conv?.description}</span>
            </>
          )}
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {conv?.directoryPath && (
          <aside className="w-72 shrink-0 border-r border-border min-h-0 overflow-hidden">
            <FileTreeSidebar dirPath={conv.directoryPath} conversationId={conv.id} />
          </aside>
        )}
        <div className="relative flex-1 bg-bg min-w-0">
          {conv?.sessionId ? (
            <Terminal conversationId={String(id)} onExit={goBack} />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">
              {conv ? 'Session not ready yet…' : 'Loading…'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
