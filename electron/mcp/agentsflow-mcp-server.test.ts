// End-to-end over stdio against the COMPILED server, the same file RemoteHosts
// ships to a remote peer's host. The config there has no PEERSFLOW_STORE_PATH
// and a forwarded bridge socket, so this reproduces that environment with a
// fake bridge on a temp socket and checks list_peers / whoami go over it.

import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

// __dirname at runtime is dist/electron/electron/mcp, next to the compiled server.
const SERVER = path.join(__dirname, 'agentsflow-mcp-server.js');

interface Rpc { id?: number; result?: Record<string, unknown>; error?: unknown }

/** Minimal JSON-RPC client over a child's stdio. stdout must be protocol-only. */
class Client {
  private buf = '';
  private waiters = new Map<number, (m: Rpc) => void>();
  readonly nonProtocol: string[] = [];
  private next = 1;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        let m: Rpc & { jsonrpc?: string };
        try { m = JSON.parse(line); } catch { this.nonProtocol.push(line); continue; }
        if (m.jsonrpc !== '2.0') { this.nonProtocol.push(line); continue; }
        if (typeof m.id === 'number') this.waiters.get(m.id)?.(m);
      }
    });
  }
  call(method: string, params: Record<string, unknown> = {}): Promise<Rpc> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
      this.waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
}

function startServer(env: Record<string, string>): Client {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PEERSFLOW_STORE_PATH: '', PEERSFLOW_ROOT_CONVERSATION_ID: 'conv-1', PEERSFLOW_ROOT_DIR: '/remote/pf-peer', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume(); // logs live on stderr; drain so the child never blocks
  return new Client(child);
}

function textOf(r: Rpc): { text: string; isError: boolean } {
  const res = r.result as { content: { type: string; text: string }[]; isError: boolean };
  return { text: res.content[0].text, isError: res.isError };
}

describe('MCP server on a remote host (bridge, no store)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-'));
  const sock = path.join(dir, 'b.sock');
  const received: Record<string, unknown>[] = [];
  const WHOAMI = { status: 'success', conversationId: 'conv-1', sessionId: 's-1', daemonShort: 'abc', directory: 'studio', directoryPath: '/Users/patryk/pf-peer', host: 'patryk@studio', hostname: 'Theos-Mac-Studio', remote: true, title: 't' };
  let server: net.Server;
  let client: Client;

  before(async () => {
    server = net.createServer((c) => {
      let buf = '';
      c.setEncoding('utf8');
      c.on('data', (d: string) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl)) as { type: string; id: string };
        received.push(req);
        const envelope = req.type === 'list_peers' ? { status: 'success', markdown: '# Peers Flow — peer registry\n\nfrom the bridge' } : req.type === 'whoami' ? WHOAMI : req.type === 'add_remote_peer' ? { status: 'success', peer: { displayName: 'studio' } } : { status: 'failure', error: 'unexpected' };
        c.end(`${JSON.stringify({ type: 'result', id: req.id, envelope })}\n`);
      });
    });
    await new Promise<void>((r) => server.listen(sock, r));
    client = startServer({ PEERSFLOW_BRIDGE_SOCK: sock, PEERSFLOW_REMOTE: '1' });
  });

  after(async () => {
    client.child.kill('SIGKILL');
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('initialize', async () => {
    const r = await client.call('initialize', { protocolVersion: '2025-06-18' });
    assert.equal((r.result!.serverInfo as { name: string }).name, 'peersflow');
  });

  test('tools/list includes whoami and add_remote_peer', async () => {
    const r = await client.call('tools/list');
    const names = (r.result!.tools as { name: string }[]).map((t) => t.name);
    assert.deepEqual(names.sort(), ['add_remote_peer', 'delegate', 'list_peers', 'open_file', 'whoami']);
  });

  test('add_remote_peer maps snake_case args onto the bridge request', async () => {
    const r = textOf(await client.call('tools/call', { name: 'add_remote_peer', arguments: {
      user: 'patryk', host: 'studio.ts.net', path: '/Users/patryk/pf-peer', ssh_args: ['-o', 'IdentitiesOnly=yes'],
      display_name: 'studio', env_file: '~/.config/peersflow/env', test_only: true,
    } }));
    assert.equal(r.isError, false);
    assert.deepEqual(JSON.parse(r.text), { status: 'success', peer: { displayName: 'studio' } });
    const req = received.find((q) => q.type === 'add_remote_peer') as unknown as Record<string, unknown>;
    assert.ok(req, 'bridge never saw add_remote_peer');
    assert.equal(req.user, 'patryk');
    assert.equal(req.host, 'studio.ts.net');
    assert.equal(req.path, '/Users/patryk/pf-peer');
    assert.deepEqual(req.sshArgs, ['-o', 'IdentitiesOnly=yes']);
    assert.equal(req.displayName, 'studio');
    assert.equal(req.envFile, '~/.config/peersflow/env');
    assert.equal(req.testOnly, true);
    assert.equal(req.rootConversationId, 'conv-1');
  });

  test('add_remote_peer rejects missing fields without asking the app', async () => {
    const before = received.length;
    const r = textOf(await client.call('tools/call', { name: 'add_remote_peer', arguments: { user: 'patryk', host: '' } }));
    assert.equal(r.isError, true);
    assert.match(r.text, /required/);
    assert.equal(received.length, before);
  });

  test('list_peers is answered by the bridge', async () => {
    const r = textOf(await client.call('tools/call', { name: 'list_peers', arguments: {} }));
    assert.equal(r.isError, false);
    assert.equal(r.text, '# Peers Flow — peer registry\n\nfrom the bridge');
    const req = received.find((q) => q.type === 'list_peers');
    assert.ok(req, 'bridge never saw list_peers');
    assert.equal(req.rootConversationId, 'conv-1');
  });

  test('whoami round-trips the bridge envelope', async () => {
    const r = textOf(await client.call('tools/call', { name: 'whoami', arguments: {} }));
    assert.equal(r.isError, false);
    assert.deepEqual(JSON.parse(r.text), WHOAMI);
    assert.equal(received.find((q) => q.type === 'whoami')?.rootConversationId, 'conv-1');
  });

  test('stdout carried nothing but JSON-RPC', () => {
    assert.deepEqual(client.nonProtocol, []);
  });
});

describe('MCP server with no bridge', () => {
  let client: Client;
  before(() => { client = startServer({ PEERSFLOW_BRIDGE_SOCK: '', PEERSFLOW_REMOTE: '1' }); });
  after(() => { client.child.kill('SIGKILL'); });

  test('whoami falls back to what the process can see', async () => {
    await client.call('initialize');
    const r = textOf(await client.call('tools/call', { name: 'whoami', arguments: {} }));
    assert.deepEqual(JSON.parse(r.text), { host: os.hostname(), rootDir: '/remote/pf-peer', conversationId: 'conv-1', remote: true });
  });
});

describe('MCP server with a dead bridge socket', () => {
  let client: Client;
  before(() => { client = startServer({ PEERSFLOW_BRIDGE_SOCK: path.join(os.tmpdir(), `pf-none-${process.pid}.sock`) }); });
  after(() => { client.child.kill('SIGKILL'); });

  test('list_peers reports the bridge is unreachable instead of an empty registry', async () => {
    const r = textOf(await client.call('tools/call', { name: 'list_peers', arguments: {} }));
    assert.equal(r.isError, true);
    assert.match(r.text, /Peers Flow did not respond/);
  });
});
