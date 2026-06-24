import '../styles/globals.css';
import 'xterm/css/xterm.css';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/ariakit/style.css';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import type { AppProps } from 'next/app';
import { api } from '../lib/ipc';
import { saveUIState } from '../lib/ui-state';

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  // Bumped on every open request. Re-opening the SAME file (e.g. after the user
  // toggled the pane back to Chat, or closed it) would otherwise produce an
  // identical URL — a no-op that leaves the file hidden. The token forces a fresh
  // URL each time so the file view always re-triggers.
  const openSeqRef = useRef(0);

  // App-wide handler for "open this file in Peers Flow" requests coming from the
  // `open_file` MCP tool (via the main process). Mounted here so it works from
  // whatever page the user is on: navigate to the file view and open the file.
  useEffect(() => {
    const off = api().onOpenFile(({ directoryId, conversationId, filePath, line }) => {
      saveUIState({ selectedDirId: directoryId });
      const t = String((openSeqRef.current += 1));
      const lineQuery = typeof line === 'number' && line > 0 ? { line: String(line) } : {};
      if (conversationId) {
        // The file belongs to this conversation's directory → open it in that
        // session's file pane, which keeps the Chat/File toggle for going back.
        router.push({
          pathname: '/session',
          query: { id: conversationId, file: filePath, t, ...lineQuery },
        });
      } else {
        router.push({
          pathname: '/preview',
          query: { dir: directoryId, file: filePath, t, ...lineQuery },
        });
      }
    });
    return () => { off(); };
  }, [router]);

  return <Component {...pageProps} />;
}
