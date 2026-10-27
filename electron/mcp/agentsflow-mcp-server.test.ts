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
    env: { ...process.env, PEERSFLOW_STORE_PATH: '', PEERSFLOW_ROOT_CONVERSATION_ID: 'conv-1', PEERSFLOW_ROOT_DIR: '/remote/pf-peer', PEERSFLOW_CHAT_KIND: '', ...env },
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
  // Same bridge, but a routine's chat: the only kind that may notify.
  let routine: Client;

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
        const envelope = req.type === 'list_peers' ? { status: 'success', markdown: '# Peers Flow — peer registry\n\nfrom the bridge' } : req.type === 'whoami' ? WHOAMI : req.type === 'add_remote_peer' ? { status: 'success', peer: { displayName: 'studio' } } : req.type === 'add_local_peer' ? { status: 'success', peer: { id: 'd-1', displayName: 'arrow', path: (req as { path?: string }).path } } : req.type === 'remove_peer' ? { status: 'success', removed: { id: 'd-1', displayName: 'arrow' } } : req.type === 'routines' ? { status: (req as { op?: string }).op === 'delete' ? 'failure' : 'success', op: (req as { op?: string }).op } : req.type === 'notify' ? { status: 'success', id: 'n-1' } : { status: 'failure', error: 'unexpected' };
        c.end(`${JSON.stringify({ type: 'result', id: req.id, envelope })}\n`);
      });
    });
    await new Promise<void>((r) => server.listen(sock, r));
    client = startServer({ PEERSFLOW_BRIDGE_SOCK: sock, PEERSFLOW_REMOTE: '1' });
    routine = startServer({ PEERSFLOW_BRIDGE_SOCK: sock, PEERSFLOW_REMOTE: '1', PEERSFLOW_CHAT_KIND: 'routine' });
  });

  after(async () => {
    client.child.kill('SIGKILL');
    routine.child.kill('SIGKILL');
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('initialize', async () => {
    const r = await client.call('initialize', { protocolVersion: '2025-06-18' });
    assert.equal((r.result!.serverInfo as { name: string }).name, 'peersflow');
  });

  test('says hello over the bridge once at start, with its pid and the root conversation', async () => {
    for (let i = 0; i < 200 && !received.some((q) => q.type === 'hello'); i++) await new Promise((r) => setTimeout(r, 10));
    const hellos = received.filter((q) => q.type === 'hello' && q.pid === client.child.pid);
    assert.equal(hellos.length, 1);
    assert.equal(hellos[0].rootConversationId, 'conv-1');
    assert.equal(hellos[0].pid, client.child.pid);
    assert.ok(!Number.isNaN(Date.parse(String(hellos[0].startedAt))));
  });

  test('tools/list of a casual chat has whoami, the add/remove peer tools and the routine tools, but no notify', async () => {
    const r = await client.call('tools/list');
    const tools = r.result!.tools as { name: string }[];
    assert.deepEqual(tools.map((t) => t.name).sort(), ['add_local_peer', 'add_remote_peer', 'create_routine', 'delegate', 'delete_routine', 'list_peers', 'list_routines', 'open_file', 'remove_peer', 'run_routine', 'update_routine', 'whoami']);
  });

  test('tools/list of a routine chat includes notify', async () => {
    const r = await routine.call('tools/list');
    const tools = r.result!.tools as { name: string; inputSchema: { required?: string[] } }[];
    assert.deepEqual(tools.map((t) => t.name).sort(), ['add_local_peer', 'add_remote_peer', 'create_routine', 'delegate', 'delete_routine', 'list_peers', 'list_routines', 'notify', 'open_file', 'remove_peer', 'run_routine', 'update_routine', 'whoami']);
    assert.deepEqual(tools.find((t) => t.name === 'notify')!.inputSchema.required, ['title', 'level']);
  });

  test('casual chat: tools/call notify is refused and the bridge never sees it', async () => {
    const r = textOf(await client.call('tools/call', { name: 'notify', arguments: { title: 't', level: 'action' } }));
    assert.equal(r.isError, true);
    assert.match(r.text, /only available to chats started by a routine/);
    assert.equal(JSON.parse(r.text).status, 'failure');
    assert.ok(!received.some((q) => q.type === 'notify'), 'a casual chat reached the bridge with notify');
  });

  test('notify goes over the bridge with the root conversation id and untouched args', async () => {
    const args = {
      title: 'Timesheet is ready — needs you', level: 'action', body: 'Check it.',
      files: [{ path: 'timesheets/oct.pdf', label: 'October timesheet (PDF)' }],
      questions: [{ id: 'dayoffs', text: 'Any days off?', kind: 'yesno', hint: 'None found.' }],
      todos: [{ text: 'Send the email yourself' }],
    };
    const r = textOf(await routine.call('tools/call', { name: 'notify', arguments: args }));
    assert.equal(r.isError, false);
    assert.deepEqual(JSON.parse(r.text), { status: 'success', id: 'n-1' });
    const req = received.find((q) => q.type === 'notify');
    assert.ok(req, 'bridge never saw notify');
    assert.equal(req.rootConversationId, 'conv-1');
    assert.deepEqual(req.args, args);
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

  test('add_local_peer maps snake_case args onto the bridge request', async () => {
    const r = textOf(await client.call('tools/call', { name: 'add_local_peer', arguments: { path: '/Users/patryk/arrow', display_name: 'arrow', test_only: true } }));
    assert.equal(r.isError, false);
    assert.deepEqual(JSON.parse(r.text), { status: 'success', peer: { id: 'd-1', displayName: 'arrow', path: '/Users/patryk/arrow' } });
    const req = received.find((q) => q.type === 'add_local_peer');
    assert.ok(req, 'bridge never saw add_local_peer');
    assert.equal(req.path, '/Users/patryk/arrow');
    assert.equal(req.displayName, 'arrow');
    assert.equal(req.testOnly, true);
    assert.equal(req.rootConversationId, 'conv-1');
  });

  test('add_local_peer rejects a missing or relative path without asking the app', async () => {
    const before = received.length;
    const missing = textOf(await client.call('tools/call', { name: 'add_local_peer', arguments: {} }));
    assert.equal(missing.isError, true);
    assert.match(missing.text, /required/);
    const relative = textOf(await client.call('tools/call', { name: 'add_local_peer', arguments: { path: 'projects/arrow' } }));
    assert.equal(relative.isError, true);
    assert.match(relative.text, /must be absolute/);
    assert.equal(received.length, before);
  });

  test('remove_peer sends name / path / id and needs one of them', async () => {
    const before = received.length;
    assert.equal(textOf(await client.call('tools/call', { name: 'remove_peer', arguments: {} })).isError, true);
    assert.equal(received.length, before);
    const r = textOf(await client.call('tools/call', { name: 'remove_peer', arguments: { name: 'arrow', id: 'd-1' } }));
    assert.equal(r.isError, false);
    assert.deepEqual(JSON.parse(r.text), { status: 'success', removed: { id: 'd-1', displayName: 'arrow' } });
    const req = received.find((q) => q.type === 'remove_peer');
    assert.ok(req, 'bridge never saw remove_peer');
    assert.equal(req.name, 'arrow');
    assert.equal(req.peerId, 'd-1');
    assert.equal(req.rootConversationId, 'conv-1');
  });

  test('each routine tool is one `routines` bridge request with its arguments untouched', async () => {
    const args = { name: 'Reddit daily', prompt: '/reddit-daily-routine', time: '09:00', month_days: [1, 15] };
    const r = textOf(await client.call('tools/call', { name: 'create_routine', arguments: args }));
    assert.equal(r.isError, false);
    assert.deepEqual(JSON.parse(r.text), { status: 'success', op: 'create' });
    for (const name of ['list_routines', 'update_routine', 'run_routine']) {
      assert.equal(textOf(await client.call('tools/call', { name, arguments: { routine: 'Reddit daily' } })).isError, false, name);
    }
    // A failure envelope from the app is a tool error the model can read.
    assert.equal(textOf(await client.call('tools/call', { name: 'delete_routine', arguments: { routine: 'x' } })).isError, true);
    const reqs = received.filter((q) => q.type === 'routines');
    assert.deepEqual(reqs.map((q) => q.op), ['create', 'list', 'update', 'run', 'delete']);
    assert.deepEqual(reqs[0].args, args);
    assert.equal(reqs[0].rootConversationId, 'conv-1');
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
    assert.deepEqual(routine.nonProtocol, []);
  });
});

describe('MCP server with no bridge', () => {
  let client: Client;
  let routine: Client;
  before(() => {
    client = startServer({ PEERSFLOW_BRIDGE_SOCK: '', PEERSFLOW_REMOTE: '1' });
    routine = startServer({ PEERSFLOW_BRIDGE_SOCK: '', PEERSFLOW_REMOTE: '1', PEERSFLOW_CHAT_KIND: 'routine' });
  });
  after(() => { client.child.kill('SIGKILL'); routine.child.kill('SIGKILL'); });

  test('a routine tool says it needs the app', async () => {
    const r = textOf(await client.call('tools/call', { name: 'create_routine', arguments: { name: 'x', prompt: 'p', time: '09:00' } }));
    assert.equal(r.isError, true);
    assert.match(r.text, /Routines require the Peers Flow app/);
  });

  test('notify (routine chat) says it needs the app', async () => {
    const r = textOf(await routine.call('tools/call', { name: 'notify', arguments: { title: 't', level: 'warn' } }));
    assert.equal(r.isError, true);
    assert.deepEqual(JSON.parse(r.text), { status: 'failure', error: 'Notifications require the Peers Flow app (this session has no app bridge).' });
  });

  test('add_local_peer and remove_peer say they need the app', async () => {
    const add = textOf(await client.call('tools/call', { name: 'add_local_peer', arguments: { path: '/tmp' } }));
    assert.equal(add.isError, true);
    assert.match(add.text, /Adding a peer requires the Peers Flow app/);
    const rm = textOf(await client.call('tools/call', { name: 'remove_peer', arguments: { name: 'arrow' } }));
    assert.equal(rm.isError, true);
    assert.match(rm.text, /Removing a peer requires the Peers Flow app/);
  });

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
