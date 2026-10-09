// The bridge is the only way an MCP server (local or on a remote peer's host via
// a forwarded socket) reaches the app. A misrouted type would e.g. run a
// `list_peers` as a delegate and spawn an agent, so routing is pinned here
// against a real socket.

import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { startPeersBridge, type BridgeHandlers, type PeersBridge } from './delegation-bridge';

// macOS caps unix socket paths at ~104 bytes; keep it short.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfb-'));
const sock = path.join(dir, 'b.sock');

function ask(line: string): Promise<{ type: string; id: string; envelope: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(`${line}\n`));
    c.on('data', (d: string) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        c.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    c.on('error', reject);
  });
}

async function waitListening(b: PeersBridge): Promise<void> {
  for (let i = 0; i < 100 && !b.health().listening; i++) await new Promise((r) => setTimeout(r, 10));
}

describe('delegation bridge with every handler', () => {
  const seen: string[] = [];
  const handlers: BridgeHandlers = {
    onDelegate: async (r) => { seen.push(`delegate:${r.directory}`); return { status: 'success', via: 'delegate' }; },
    onOpenFile: async (r) => { seen.push(`open_file:${r.file}`); return { status: 'success', via: 'open_file' }; },
    onListPeers: async (r) => { seen.push(`list_peers:${r.rootConversationId}`); return { status: 'success', markdown: '# peers' }; },
    onWhoami: async (r) => { seen.push(`whoami:${r.rootConversationId}`); return { status: 'success', host: 'patryk@h', remote: true }; },
    onAddRemotePeer: async (r) => { seen.push(`add_remote_peer:${r.user}@${r.host}:${r.path}`); return { status: 'success', peer: { displayName: 'pf-peer' } }; },
  };
  let bridge: PeersBridge;
  before(async () => { bridge = startPeersBridge(sock, handlers); await waitListening(bridge); });
  after(() => { bridge.stop(); });

  test('health() reports a live socket', () => {
    assert.deepEqual(bridge.health(), { socketPath: sock, listening: true, socketFileExists: true, healthy: true });
  });

  test('delegate (explicit type)', async () => {
    const r = await ask(JSON.stringify({ type: 'delegate', id: 'd1', rootConversationId: 'c', directory: 'arrow', goal: 'g', deliverable: '', timeoutMs: 1 }));
    assert.deepEqual(r, { type: 'result', id: 'd1', envelope: { status: 'success', via: 'delegate' } });
  });

  test('untyped request is still a delegate (pre-open_file protocol)', async () => {
    const r = await ask(JSON.stringify({ id: 'd2', rootConversationId: 'c', directory: 'legacy', goal: 'g', deliverable: '', timeoutMs: 1 }));
    assert.equal(r.envelope.via, 'delegate');
  });

  test('open_file', async () => {
    const r = await ask(JSON.stringify({ type: 'open_file', id: 'o1', rootConversationId: 'c', directory: '', file: 'README.md' }));
    assert.deepEqual(r, { type: 'result', id: 'o1', envelope: { status: 'success', via: 'open_file' } });
  });

  test('list_peers', async () => {
    const r = await ask(JSON.stringify({ type: 'list_peers', id: 'l1', rootConversationId: 'conv-9' }));
    assert.deepEqual(r, { type: 'result', id: 'l1', envelope: { status: 'success', markdown: '# peers' } });
  });

  test('whoami', async () => {
    const r = await ask(JSON.stringify({ type: 'whoami', id: 'w1', rootConversationId: 'conv-9' }));
    assert.deepEqual(r, { type: 'result', id: 'w1', envelope: { status: 'success', host: 'patryk@h', remote: true } });
  });

  test('add_remote_peer', async () => {
    const r = await ask(JSON.stringify({ type: 'add_remote_peer', id: 'a1', rootConversationId: 'conv-9', user: 'patryk', host: 'h', path: '/p' }));
    assert.deepEqual(r, { type: 'result', id: 'a1', envelope: { status: 'success', peer: { displayName: 'pf-peer' } } });
  });

  test('malformed line gets a failure envelope', async () => {
    const r = await ask('{not json');
    assert.deepEqual(r, { type: 'result', id: '', envelope: { status: 'failure', error: 'bad request json' } });
  });

  test('a throwing handler becomes a failure envelope', async () => {
    const orig = handlers.onOpenFile;
    handlers.onOpenFile = async () => { throw new Error('boom'); };
    try {
      const r = await ask(JSON.stringify({ type: 'open_file', id: 'o2', rootConversationId: 'c', directory: '', file: 'x' }));
      assert.deepEqual(r.envelope, { status: 'failure', error: 'bridge error: boom' });
    } finally {
      handlers.onOpenFile = orig;
    }
  });

  test('every request reached exactly its handler', () => {
    assert.deepEqual(seen, ['delegate:arrow', 'delegate:legacy', 'open_file:README.md', 'list_peers:conv-9', 'whoami:conv-9', 'add_remote_peer:patryk@h:/p']);
  });
});

describe('delegation bridge without the optional handlers', () => {
  const sock2 = path.join(dir, 'c.sock');
  let delegated = 0;
  let bridge: PeersBridge;
  before(async () => {
    bridge = startPeersBridge(sock2, {
      onDelegate: async () => { delegated++; return { status: 'success' }; },
      onOpenFile: async () => ({ status: 'success' }),
    });
    await waitListening(bridge);
  });

  const askOn = (line: string) => new Promise<{ envelope: Record<string, unknown> }>((resolve, reject) => {
    const c = net.connect(sock2);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(`${line}\n`));
    c.on('data', (d: string) => { buf += d; if (buf.includes('\n')) { c.end(); resolve(JSON.parse(buf.slice(0, buf.indexOf('\n')))); } });
    c.on('error', reject);
  });

  test('list_peers / whoami answer "not supported" and never fall through to delegate', async () => {
    const l = await askOn(JSON.stringify({ type: 'list_peers', id: 'l', rootConversationId: 'c' }));
    const w = await askOn(JSON.stringify({ type: 'whoami', id: 'w', rootConversationId: 'c' }));
    assert.deepEqual(l.envelope, { status: 'failure', error: 'list_peers not supported by this Peers Flow' });
    assert.deepEqual(w.envelope, { status: 'failure', error: 'whoami not supported by this Peers Flow' });
    const a = await askOn(JSON.stringify({ type: 'add_remote_peer', id: 'a', rootConversationId: 'c', user: 'u', host: 'h', path: '/p' }));
    assert.deepEqual(a.envelope, { status: 'failure', error: 'add_remote_peer not supported by this Peers Flow' });
    assert.equal(delegated, 0);
  });

  test('stop() removes the socket file and reports unhealthy', () => {
    assert.ok(fs.existsSync(sock2));
    bridge.stop();
    assert.equal(fs.existsSync(sock2), false);
    assert.equal(bridge.health().healthy, false);
  });
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
