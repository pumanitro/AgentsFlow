import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WsClient } from './ws-client';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Server-to-client frames are never masked (RFC 6455 §5.1). */
function serverFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) { header = Buffer.alloc(2); header[1] = length; }
  else if (length < 65_536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
}

interface ClientFrame { fin: boolean; opcode: number; masked: boolean; payload: Buffer }

/** Decode as many whole frames as `buffer` holds; returns the unconsumed tail. */
function readFrames(buffer: Buffer, out: ClientFrame[]): Buffer {
  for (;;) {
    if (buffer.length < 2) return buffer;
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) { if (buffer.length < 4) return buffer; length = buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (buffer.length < 10) return buffer; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
    let mask: Buffer | null = null;
    if (masked) { if (buffer.length < offset + 4) return buffer; mask = buffer.subarray(offset, offset + 4); offset += 4; }
    if (buffer.length < offset + length) return buffer;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    out.push({ fin, opcode, masked, payload });
    buffer = buffer.subarray(offset + length);
  }
}

class FakeWsServer {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ws-'));
  readonly socketPath = path.join(this.dir, 's.sock');
  readonly frames: ClientFrame[] = [];
  /** Text messages received from the client, reassembled. */
  readonly messages: string[] = [];
  /** Replace the 101 response to test rejection paths. */
  badHandshake: string | null = null;
  onMessage: ((text: string, socket: net.Socket) => void) | null = null;
  private server = net.createServer((socket) => this.serve(socket));
  private sockets: net.Socket[] = [];

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socketPath, resolve));
  }

  private serve(socket: net.Socket): void {
    this.sockets.push(socket);
    socket.on('error', () => { /* torn down by a test */ });
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
        if (this.badHandshake !== null) { socket.end(this.badHandshake); return; }
        const accept = createHash('sha1').update(key + GUID).digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        upgraded = true;
      }
      const before = this.frames.length;
      buffer = readFrames(buffer, this.frames);
      for (const frame of this.frames.slice(before)) {
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          this.messages.push(frame.payload.toString('utf8'));
          this.onMessage?.(frame.payload.toString('utf8'), socket);
        }
        if (frame.opcode === 0x8) socket.end(serverFrame(0x8, frame.payload.subarray(0, 2)));
      }
    });
  }

  send(frame: Buffer): void { for (const socket of this.sockets) socket.write(frame); }
  text(value: string): void { this.send(serverFrame(0x1, Buffer.from(value, 'utf8'))); }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

async function withServer(run: (server: FakeWsServer) => Promise<void>): Promise<void> {
  const server = new FakeWsServer();
  await server.listen();
  try { await run(server); } finally { await server.close(); }
}

const nextMessage = (client: WsClient): Promise<string> =>
  new Promise((resolve) => client.once('message', resolve));
const settled = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await settled(10);
  }
}

test('completes the handshake and masks the text frames it sends', async () => {
  await withServer(async (server) => {
    const client = await WsClient.connect({ path: server.socketPath });
    client.on('error', () => { /* ignored */ });
    client.send('hello');
    await until(() => server.messages.length === 1);
    assert.deepEqual(server.messages, ['hello']);
    const frame = server.frames.find((f) => f.opcode === 0x1)!;
    assert.equal(frame.masked, true, 'client frames must be masked');
    assert.equal(frame.fin, true);
    client.close();
  });
});

test('reassembles a fragmented message', async () => {
  await withServer(async (server) => {
    const client = await WsClient.connect({ path: server.socketPath });
    client.on('error', () => { /* ignored */ });
    const received = nextMessage(client);
    server.send(serverFrame(0x1, Buffer.from('hel'), false));
    server.send(serverFrame(0x0, Buffer.from('lo, '), false));
    server.send(serverFrame(0x0, Buffer.from('world'), true));
    assert.equal(await received, 'hello, world');
    client.close();
  });
});

test('carries a 70 kB message in both directions', async () => {
  await withServer(async (server) => {
    const client = await WsClient.connect({ path: server.socketPath });
    client.on('error', () => { /* ignored */ });
    // 70 kB needs the 64-bit length field; 300 B needs the 16-bit one.
    for (const size of [70_000, 300]) {
      const big = 'x'.repeat(size);
      server.onMessage = (text, socket) => socket.write(serverFrame(0x1, Buffer.from(text, 'utf8')));
      const echoed = nextMessage(client);
      client.send(big);
      assert.equal(await echoed, big, `${size} byte round trip`);
      assert.equal(server.messages.at(-1), big);
    }
    client.close();
  });
});

test('splitting a frame across chunks does not lose it', async () => {
  await withServer(async (server) => {
    const client = await WsClient.connect({ path: server.socketPath });
    client.on('error', () => { /* ignored */ });
    const received = nextMessage(client);
    const frame = serverFrame(0x1, Buffer.from('split down the middle'));
    server.send(frame.subarray(0, 5));
    await settled(20);
    server.send(frame.subarray(5));
    assert.equal(await received, 'split down the middle');
    client.close();
  });
});

test('answers a ping with a matching masked pong', async () => {
  await withServer(async (server) => {
    const client = await WsClient.connect({ path: server.socketPath });
    client.on('error', () => { /* ignored */ });
    server.send(serverFrame(0x9, Buffer.from('keepalive')));
    await until(() => server.frames.some((f) => f.opcode === 0xa));
    const pong = server.frames.find((f) => f.opcode === 0xa)!;
    assert.equal(pong.payload.toString('utf8'), 'keepalive');
    assert.equal(pong.masked, true);
    client.close();
  });
});

test('close() sends a close frame and ends with a close event', async () => {
  await withServer(async (server) => {
    const client = await WsClient.connect({ path: server.socketPath });
    client.on('error', () => { /* ignored */ });
    const closed = new Promise<number | undefined>((resolve) => client.once('close', resolve));
    client.close();
    assert.equal(await closed, 1000);
    assert.equal(client.isClosed, true);
    const frame = server.frames.find((f) => f.opcode === 0x8)!;
    assert.equal(frame.payload.readUInt16BE(0), 1000);
    assert.throws(() => client.send('too late'), /closed/);
  });
});

test('a close frame from the server is echoed and reported', async () => {
  await withServer(async (server) => {
    const client = await WsClient.connect({ path: server.socketPath });
    client.on('error', () => { /* ignored */ });
    const closed = new Promise<number | undefined>((resolve) => client.once('close', resolve));
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1001, 0);
    server.send(serverFrame(0x8, payload));
    assert.equal(await closed, 1001);
    assert.ok(server.frames.some((f) => f.opcode === 0x8 && f.masked));
  });
});

test('rejects a non-101 response', async () => {
  await withServer(async (server) => {
    server.badHandshake = 'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n';
    await assert.rejects(WsClient.connect({ path: server.socketPath, timeoutMs: 2_000 }), /400 Bad Request/);
  });
});

test('rejects a wrong Sec-WebSocket-Accept', async () => {
  await withServer(async (server) => {
    server.badHandshake = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: nope\r\n\r\n';
    await assert.rejects(WsClient.connect({ path: server.socketPath, timeoutMs: 2_000 }), /Sec-WebSocket-Accept/);
  });
});

test('rejects a negotiated extension, because the app-server never offers one', async () => {
  await withServer(async (server) => {
    server.badHandshake = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: nope\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n';
    await assert.rejects(WsClient.connect({ path: server.socketPath, timeoutMs: 2_000 }), /Sec-WebSocket-Accept|extension/);
  });
});

test('rejects when nothing is listening', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ws-'));
  await assert.rejects(
    WsClient.connect({ path: path.join(dir, 'absent.sock'), timeoutMs: 2_000 }),
    /Cannot reach/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
