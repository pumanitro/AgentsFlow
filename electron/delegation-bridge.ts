/**
 * Delegation bridge — the transport between the standalone MCP server (a child
 * of the root `claude`) and the Electron main process.
 *
 * When a peer-aware session calls the `delegate` tool, the MCP server can't
 * itself create a *tracked, attachable* Peers Flow session (that needs the
 * store, poller, and broadcasts that live in main). So it connects to this
 * unix-domain socket and asks main to do it, then waits for the result.
 *
 * Protocol: newline-delimited JSON, one request per connection.
 *   → { type: 'delegate', id, rootConversationId, directory, goal, deliverable, timeoutMs }
 *   ← { type: 'result', id, envelope }
 */
import * as net from 'net';
import * as fs from 'fs';

export interface DelegateRequest {
  id: string;
  rootConversationId: string;
  directory: string;
  goal: string;
  deliverable: string;
  timeoutMs: number;
}

export type DelegateEnvelope = Record<string, unknown>;

export function startDelegationBridge(
  socketPath: string,
  onDelegate: (req: DelegateRequest) => Promise<DelegateEnvelope>,
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
      let req: DelegateRequest | null = null;
      try {
        req = JSON.parse(line) as DelegateRequest;
      } catch {
        sock.end(`${JSON.stringify({ type: 'result', id: '', envelope: { status: 'failure', error: 'bad request json' } })}\n`);
        return;
      }
      const reply = (envelope: DelegateEnvelope) => {
        try { sock.end(`${JSON.stringify({ type: 'result', id: req!.id, envelope })}\n`); } catch { /* socket gone */ }
      };
      onDelegate(req)
        .then(reply)
        .catch((e) => reply({ status: 'failure', error: `bridge error: ${(e as Error).message}` }));
    });
    sock.on('error', () => { /* client vanished mid-flight; nothing to do */ });
  });

  server.on('error', (err) => {
    console.error('[peersflow] delegation bridge server error', err);
  });
  server.listen(socketPath, () => {
    console.log('[peersflow] delegation bridge listening at', socketPath);
  });

  return () => {
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  };
}
