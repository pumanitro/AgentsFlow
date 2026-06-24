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

export function startPeersBridge(
  socketPath: string,
  handlers: BridgeHandlers,
): () => void {
  // A stale socket file from a previous run would make listen() fail with EADDRINUSE.
  try { fs.unlinkSync(socketPath); } catch { /* not present */ }

  const server = net.createServer((sock) => {
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

  server.on('error', (err) => {
    console.error('[peersflow] bridge server error', err);
  });
  server.listen(socketPath, () => {
    console.log('[peersflow] bridge listening at', socketPath);
  });

  return () => {
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  };
}
