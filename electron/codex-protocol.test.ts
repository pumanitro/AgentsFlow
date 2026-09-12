import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexRpc, defaultUserData, type WireObject } from './codex-protocol';
import { codexServerDir, codexSocketPath, ensureCodexServer, probeCodexServer, readCodexPid, stopCodexServer } from './codex-server';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function serverFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) { header = Buffer.alloc(2); header[1] = length; }
  else if (length < 65_536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/**
 * An app-server stand-in on the socket `CodexRpc` dials. Because it is already
 * listening, `ensureCodexServer` finds a live server and reuses it, so these
 * tests never spawn anything.
 */
class FakeAppServer {
  readonly received: WireObject[] = [];
  connections = 0;
  /** Answers for requests other than `initialize`. */
  responses = new Map<string, WireObject>();
  /** 1-based indexes of `initialize` requests to reject. Note that every
   *  connect costs two: the liveness probe's, then the client's. */
  failInitializeOn: number[] = [];
  private initializeSeen = 0;
  private server = net.createServer((socket) => this.serve(socket));
  private sockets: net.Socket[] = [];

  constructor(readonly socketPath: string) {}

  listen(): Promise<void> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    return new Promise((resolve) => this.server.listen(this.socketPath, resolve));
  }

  private serve(socket: net.Socket): void {
    this.connections += 1;
    this.sockets.push(socket);
    socket.on('error', () => { /* dropped by a test */ });
    let buffer: Buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? '';
        const accept = createHash('sha1').update(key + GUID).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
      }
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        let mask: Buffer | null = null;
        if (masked) { if (buffer.length < offset + 4) return; mask = buffer.subarray(offset, offset + 4); offset += 4; }
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) { socket.end(serverFrame(0x8, payload.subarray(0, 2))); return; }
        if (opcode !== 0x1) continue;
        let message: WireObject;
        try { message = JSON.parse(payload.toString('utf8')); } catch { continue; }
        this.received.push(message);
        this.answer(message, socket);
      }
    });
  }

  private answer(message: WireObject, socket: net.Socket): void {
    if (message.id === undefined || !message.method) return;
    if (message.method === 'initialize') {
      this.initializeSeen += 1;
      if (this.failInitializeOn.includes(this.initializeSeen)) {
        this.write(socket, { id: message.id, error: { code: -32603, message: 'initialize refused' } });
        return;
      }
      this.write(socket, { id: message.id, result: { userAgent: 'fake-app-server' } });
      return;
    }
    const canned = this.responses.get(message.method);
    if (canned) this.write(socket, { id: message.id, ...canned });
  }

  private write(socket: net.Socket, value: WireObject): void {
    socket.write(serverFrame(0x1, Buffer.from(JSON.stringify(value), 'utf8')));
  }

  /** Push a notification or a server-to-client request down every connection. */
  push(value: WireObject): void { for (const socket of this.sockets) this.write(socket, value); }

  /** Simulate the server going away without a close handshake. */
  dropAll(): void { for (const socket of this.sockets.splice(0)) socket.destroy(); }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** A spawnable app-server stand-in, for the one test that has to see a new process. */
const FAKE_CODEX = String.raw`#!/usr/bin/env node
const net = require('net');
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const args = process.argv.slice(2);
if (args[0] !== 'app-server') process.exit(2);
const sock = (args[args.indexOf('--listen') + 1] || '').replace(/^unix:\/\//, '');
if (!sock) process.exit(3);
function frame(op, payload) {
  const n = payload.length;
  let h;
  if (n < 126) { h = Buffer.alloc(2); h[1] = n; }
  else if (n < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  h[0] = 0x80 | op;
  return Buffer.concat([h, payload]);
}
net.createServer((s) => {
  let buf = Buffer.alloc(0);
  let up = false;
  s.on('error', () => {});
  s.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    if (!up) {
      const e = buf.indexOf('\r\n\r\n');
      if (e < 0) return;
      const head = buf.subarray(0, e).toString('latin1');
      buf = buf.subarray(e + 4);
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)[1];
      s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
      up = true;
    }
    for (;;) {
      if (buf.length < 2) break;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let n = buf[1] & 0x7f;
      let o = 2;
      if (n === 126) { if (buf.length < 4) break; n = buf.readUInt16BE(2); o = 4; }
      else if (n === 127) { if (buf.length < 10) break; n = Number(buf.readBigUInt64BE(2)); o = 10; }
      let m = null;
      if (masked) { if (buf.length < o + 4) break; m = buf.subarray(o, o + 4); o += 4; }
      if (buf.length < o + n) break;
      const p = Buffer.from(buf.subarray(o, o + n));
      if (m) for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3];
      buf = buf.subarray(o + n);
      if (op === 0x8) { s.end(frame(0x8, p.subarray(0, 2))); break; }
      if (op !== 0x1) continue;
      let msg = null;
      try { msg = JSON.parse(p.toString('utf8')); } catch (err) { msg = null; }
      if (msg && msg.id !== undefined && msg.method) {
        s.write(frame(0x1, Buffer.from(JSON.stringify({ id: msg.id, result: { pid: process.pid } }))));
      }
    }
  });
}).listen(sock);
setInterval(() => {}, 1 << 30);
`;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const once = <T>(emitter: CodexRpc, event: string): Promise<T> =>
  new Promise((resolve) => emitter.once(event, (value: T) => resolve(value)));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(predicate: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await delay(20);
  }
}

interface Fixture { userData: string; server: FakeAppServer; rpc: CodexRpc }

/**
 * `CODEX_BIN` is pointed at a path that does not exist on purpose: if anything
 * in these tests tried to spawn a server instead of reusing the fake, it would
 * fail loudly rather than quietly launching the real Codex CLI.
 */
async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  options: { reconnect?: boolean } = {},
): Promise<void> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cp-'));
  const server = new FakeAppServer(codexSocketPath(userData));
  await server.listen();
  const rpc = new CodexRpc({ userData, reconnect: options.reconnect });
  rpc.on('diagnostic', () => { /* reconnect chatter */ });
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = path.join(userData, 'never-spawn-this');
  try {
    await run({ userData, server, rpc });
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
    rpc.close();
    await server.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

test('defaultUserData follows AGENTSFLOW_USER_DATA, else the app support directory', () => {
  const previous = process.env.AGENTSFLOW_USER_DATA;
  try {
    process.env.AGENTSFLOW_USER_DATA = '/tmp/isolated';
    assert.equal(defaultUserData(), '/tmp/isolated');
    delete process.env.AGENTSFLOW_USER_DATA;
    assert.equal(defaultUserData(), path.join(os.homedir(), 'Library', 'Application Support', 'Peers Flow'));
  } finally {
    if (previous === undefined) delete process.env.AGENTSFLOW_USER_DATA; else process.env.AGENTSFLOW_USER_DATA = previous;
  }
});

test('a zero-argument CodexRpc still resolves a socket path', () => {
  const rpc = new CodexRpc();
  assert.equal(rpc.socketPath(), codexSocketPath(defaultUserData()));
  assert.equal(rpc.isConnected(), false);
});

test('start() initializes over the socket and announces the connection', { timeout: 30_000 }, async () => {
  await withFixture(async ({ rpc, server, userData }) => {
    assert.equal(rpc.socketPath(), path.join(codexServerDir(userData), 'app-server.sock'));
    const connected = once<{ socketPath: string }>(rpc, 'connected');
    await rpc.start();
    assert.equal((await connected).socketPath, rpc.socketPath());
    assert.equal(rpc.isConnected(), true);

    const initialize = server.received.find((m) => m.method === 'initialize')!;
    assert.deepEqual(initialize.params.clientInfo, { name: 'peers_flow', title: 'Peers Flow', version: '10.1.0' });
    assert.deepEqual(initialize.params.capabilities, { experimentalApi: true });
    await until(() => server.received.some((m) => m.method === 'initialized' && m.id === undefined));
  });
});

test('start() is idempotent while a connection is up', { timeout: 30_000 }, async () => {
  await withFixture(async ({ rpc, server }) => {
    await Promise.all([rpc.start(), rpc.start()]);
    await rpc.start();
    assert.equal(server.connections, 2, 'one probe from ensureCodexServer plus one real connection');
  });
});

test('requests round-trip, and server errors reject', { timeout: 30_000 }, async () => {
  await withFixture(async ({ rpc, server }) => {
    server.responses.set('model/list', { result: { data: [{ id: 'gpt-6-astra' }] } });
    server.responses.set('thread/resume', { error: { code: -32600, message: 'no rollout found for thread id x' } });
    await rpc.start();
    assert.deepEqual(await rpc.request('model/list', {}), { data: [{ id: 'gpt-6-astra' }] });
    await assert.rejects(rpc.request('thread/resume', { threadId: 'x' }), /no rollout found/);
  });
});

test('notifications and server requests are routed to their own events', { timeout: 30_000 }, async () => {
  await withFixture(async ({ rpc, server }) => {
    await rpc.start();
    const notification = once<WireObject>(rpc, 'notification');
    server.push({ method: 'thread/status/changed', params: { threadId: 't1', status: { type: 'idle' } } });
    assert.equal((await notification).params.threadId, 't1');

    const request = once<WireObject>(rpc, 'request');
    server.push({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 't1' } });
    assert.equal((await request).id, 7);

    rpc.reply(7, { decision: 'approve' });
    await until(() => server.received.some((m) => m.id === 7 && m.result?.decision === 'approve'));
    rpc.rejectRequest(8, 'unsupported');
    await until(() => server.received.some((m) => m.id === 8 && m.error?.message === 'unsupported'));
  });
});

test('a request made while disconnected rejects immediately', { timeout: 30_000 }, async () => {
  await withFixture(async ({ rpc }) => {
    // Before start().
    await assert.rejects(rpc.request('model/list', {}), /disconnected/);
    await rpc.start();
    rpc.close();
    // And after close().
    await assert.rejects(rpc.request('model/list', {}), /disconnected/);
    assert.equal(rpc.isConnected(), false);
  });
});

test('in-flight requests fail when the connection drops', { timeout: 30_000 }, async () => {
  await withFixture(async ({ rpc, server }) => {
    await rpc.start();
    const pending = rpc.request('turn/start', { threadId: 't1' }); // The fake never answers this.
    const disconnected = once<Error>(rpc, 'disconnected');
    server.dropAll();
    await assert.rejects(pending, /connection closed|connection failed/);
    assert.match((await disconnected).message, /Codex app-server connection/);
  }, { reconnect: false });
});

test('an unexpected drop reconnects on its own', { timeout: 30_000 }, async () => {
  await withFixture(async ({ rpc, server }) => {
    await rpc.start();
    const before = server.connections;
    const reconnected = once<{ socketPath: string }>(rpc, 'connected');
    server.dropAll();
    await once<Error>(rpc, 'disconnected');
    assert.equal(rpc.isConnected(), false);
    await reconnected; // First backoff step is 1s.
    assert.equal(rpc.isConnected(), true);
    assert.ok(server.connections > before);
    // Two connects, each preceded by ensureCodexServer's liveness probe.
    assert.equal(server.received.filter((m) => m.method === 'initialize').length, 4);
  });
});

test('close() stops reconnecting and leaves the server running', { timeout: 30_000 }, async () => {
  await withFixture(async ({ rpc, server }) => {
    await rpc.start();
    const connections = server.connections;
    rpc.close();
    await delay(2_500); // Well past the 1s first backoff step.
    assert.equal(rpc.isConnected(), false);
    assert.equal(server.connections, connections, 'close() must not schedule a reconnect');
    // The whole point of the daemon model: the server is still there.
    assert.equal(await probeCodexServer(rpc.socketPath(), 2_000), true);
  });
});

test('start() after close() reconnects to the same server', { timeout: 30_000 }, async () => {
  await withFixture(async ({ rpc, server }) => {
    await rpc.start();
    rpc.close();
    await rpc.start();
    assert.equal(rpc.isConnected(), true);
    assert.equal(server.received.filter((m) => m.method === 'initialize').length, 4);
  });
});

test('a refused initialize rejects start() and leaves it retryable', { timeout: 30_000 }, async () => {
  await withFixture(async ({ rpc, server }) => {
    // The probe's initialize (#1) succeeds, so the server counts as live; the
    // client's own (#2) is refused.
    server.failInitializeOn = [2];
    await assert.rejects(rpc.start(), /initialize refused/);
    assert.equal(rpc.isConnected(), false);
    await rpc.start();
    assert.equal(rpc.isConnected(), true);
  }, { reconnect: false });
});

test('restart() replaces the server process and reconnects', { timeout: 60_000 }, async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cp-'));
  const bin = path.join(userData, 'fake-codex');
  fs.writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  const rpc = new CodexRpc({ userData, reconnect: false });
  rpc.on('diagnostic', () => { /* ignored */ });
  try {
    await rpc.start();
    const first = readCodexPid(userData)!;
    assert.ok(first > 0);
    assert.equal(alive(first), true);

    const events: string[] = [];
    rpc.on('disconnected', () => events.push('disconnected'));
    rpc.on('connected', () => events.push('connected'));
    await rpc.restart();

    assert.deepEqual(events, ['disconnected', 'connected']);
    const second = readCodexPid(userData)!;
    assert.notEqual(second, first, 'restart must start a new server');
    assert.equal(alive(first), false, 'and stop the old one');
    assert.equal(rpc.isConnected(), true);
    assert.deepEqual(await rpc.request('model/list', {}), { pid: second });
  } finally {
    rpc.close();
    await stopCodexServer(userData);
    if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

// ---- integration ----
// Everything above runs against a stand-in. This one runs against the real
// `codex app-server` and is skipped wherever the CLI is not installed.

function findCodex(): string | null {
  const explicit = process.env.CODEX_BIN;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'codex');
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

const CODEX = findCodex();

test('a real codex app-server survives a disconnect and is reused', {
  skip: CODEX ? false : 'codex is not on PATH',
  timeout: 180_000,
}, async () => {
  // Short prefix: unix socket paths are capped at ~104 bytes.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ix-'));
  const rpc = new CodexRpc({ userData, reconnect: false });
  rpc.on('diagnostic', () => { /* ignored */ });
  try {
    const spawned = await ensureCodexServer({ userData });
    assert.equal(spawned.started, true, 'nothing was listening, so this call must have spawned the server');
    assert.ok(spawned.pid > 0);
    assert.equal(spawned.socketPath, codexSocketPath(userData));

    await rpc.start();
    assert.equal(rpc.isConnected(), true);

    // A round trip over the real wire. Whichever of these the current sign-in
    // allows, the point is that a response comes back through the WebSocket.
    let answered = false;
    for (const method of ['model/list', 'account/read']) {
      try { await rpc.request(method, {}); answered = true; break; }
      catch { /* try the next one */ }
    }
    assert.equal(answered, true, 'neither model/list nor account/read answered');

    rpc.close();
    assert.equal(rpc.isConnected(), false);
    await delay(500);
    // close() drops the connection only. The daemon is still there.
    assert.equal(alive(spawned.pid), true, 'close() must not stop the app-server');

    const rejoined = await ensureCodexServer({ userData });
    assert.equal(rejoined.started, false, 'the second call must reuse the running server');
    assert.equal(rejoined.pid, spawned.pid, 'and it must be the same process');

    await rpc.start();
    assert.equal(rpc.isConnected(), true);
    assert.equal(readCodexPid(userData), spawned.pid);

    rpc.close();
    await stopCodexServer(userData);
    assert.equal(alive(spawned.pid), false, 'stopCodexServer must stop the server we started');
    assert.equal(fs.existsSync(codexSocketPath(userData)), false);
  } finally {
    rpc.close();
    await stopCodexServer(userData);
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
