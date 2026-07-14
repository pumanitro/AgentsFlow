/**
 * Peers bridge — the transport between the standalone MCP server (a child of the
 * root `claude`) and the Electron main process.
 *
 * The MCP server runs as a plain Node child and cannot touch the store, poller,
 * or window broadcasts that live in main. So for anything that needs the app, it
 * connects to this unix-domain socket and asks main to do it, then waits for the
 * result. Two request types are routed by `type`:
 *
 *   • delegate  — spawn a *tracked, attachable* peer session and run a goal.
 *   • open_file — bring a file up in the app's file view ("Preview") so the user
 *                 can see it. Used by the `open_file` tool.
 *
 * Protocol: newline-delimited JSON, one request per connection.
 *   → { type, id, rootConversationId, ... }
 *   ← { type: 'result', id, envelope }
 */
import * as net from 'net';
import * as fs from 'fs';
import type { BridgeHealth } from '../shared/types';

export interface DelegateRequest {
  type?: 'delegate';
  id: string;
  rootConversationId: string;
  directory: string;
  goal: string;
  deliverable: string;
  timeoutMs: number;
}

export interface OpenFileRequest {
  type: 'open_file';
  id: string;
  rootConversationId: string;
  // Which peer to open the file in (name / path / id). May be empty, in which
  // case main falls back to the requesting conversation's own directory.
  directory: string;
  // Absolute, or relative to the resolved peer's directory.
  file: string;
  // Optional 1-based line to scroll to.
  line?: number | null;
}

export type BridgeEnvelope = Record<string, unknown>;

export interface BridgeHandlers {
  onDelegate: (req: DelegateRequest) => Promise<BridgeEnvelope>;
  onOpenFile: (req: OpenFileRequest) => Promise<BridgeEnvelope>;
}

/** Handle to a running bridge: query its liveness or shut it down. */
export interface PeersBridge {
  /** A fresh snapshot of the bridge's reachability, for the UI health dot. */
  health: () => BridgeHealth;
  /** Stop the watchdog, close the server, and remove the socket file. */
  stop: () => void;
}

// How often the watchdog re-checks the socket. The socket can be silently
// disabled if something deletes the file out from under a live listener (a
// bound-but-unlinked socket stays "listening" yet is unreachable — ENOENT on
// connect). A cheap periodic check turns "dead until restart" into "self-heals
// within one tick".
const WATCHDOG_INTERVAL_MS = 10_000;

export function startPeersBridge(
  socketPath: string,
  handlers: BridgeHandlers,
): PeersBridge {
  let server: net.Server | null = null;
  let stopped = false;

  const makeServer = (): net.Server => {
    const s = net.createServer((sock) => {
      let buffer = '';
      let handled = false;
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        buffer += chunk;
        const nl = buffer.indexOf('\n');
        if (nl < 0 || handled) return;
        handled = true;
        const line = buffer.slice(0, nl).trim();
        let req: (DelegateRequest | OpenFileRequest) & { id?: string } | null = null;
        try {
          req = JSON.parse(line) as DelegateRequest | OpenFileRequest;
        } catch {
          sock.end(`${JSON.stringify({ type: 'result', id: '', envelope: { status: 'failure', error: 'bad request json' } })}\n`);
          return;
        }
        const reply = (envelope: BridgeEnvelope) => {
          try { sock.end(`${JSON.stringify({ type: 'result', id: req!.id, envelope })}\n`); } catch { /* socket gone */ }
        };
        // Route by request type. Anything without an explicit type is a delegate
        // (the original, pre-open_file protocol).
        const run = req.type === 'open_file'
          ? handlers.onOpenFile(req as OpenFileRequest)
          : handlers.onDelegate(req as DelegateRequest);
        run
          .then(reply)
          .catch((e) => reply({ status: 'failure', error: `bridge error: ${(e as Error).message}` }));
      });
      sock.on('error', () => { /* client vanished mid-flight; nothing to do */ });
    });
    s.on('error', (err) => {
      // EADDRINUSE / permission errors land here; the watchdog will retry a bind.
      console.error('[peersflow] bridge server error', err);
    });
    return s;
  };

  const bind = (): void => {
    if (stopped) return;
    // A stale socket file (a previous run, or one left behind) makes listen()
    // fail with EADDRINUSE, so clear it first, then bind a fresh one.
    try { fs.unlinkSync(socketPath); } catch { /* not present */ }
    server = makeServer();
    server.listen(socketPath, () => {
      console.log('[peersflow] bridge listening at', socketPath);
    });
  };

  bind();

  // Watchdog: if the socket file vanished or the server dropped out of the
  // listening state, rebind so the bridge recovers on its own instead of
  // silently forcing every delegate onto the unwatchable headless fallback.
  const watchdog = setInterval(() => {
    if (stopped) return;
    const fileOk = fs.existsSync(socketPath);
    const listening = !!server?.listening;
    if (!fileOk || !listening) {
      console.error(`[peersflow] bridge unhealthy (socketFile=${fileOk} listening=${listening}) — rebinding`);
      try { server?.close(); } catch { /* ignore */ }
      bind();
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();

  return {
    health: (): BridgeHealth => {
      const listening = !stopped && !!server?.listening;
      const socketFileExists = !stopped && fs.existsSync(socketPath);
      return { socketPath, listening, socketFileExists, healthy: listening && socketFileExists };
    },
    stop: (): void => {
      stopped = true;
      clearInterval(watchdog);
      try { server?.close(); } catch { /* ignore */ }
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
    },
  };
}
