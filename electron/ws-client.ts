import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import * as net from 'node:net';

// A minimal RFC 6455 client, only as much of it as `codex app-server --listen
// unix://…` needs. Written by hand rather than pulled from npm for two reasons:
// the Electron main bundle has no WebSocket dependency and should not grow one
// for a single socket, and the app-server rejects the `permessage-deflate`
// extension outright — off-the-shelf clients offer it by default and fail the
// handshake with "Missing, duplicated or incorrect header
// sec-websocket-extensions". We simply never offer an extension.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HEADER_BYTES = 64 * 1024;
/** Refuse absurd frame lengths rather than trying to allocate them. */
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export interface WsConnectOptions {
  /** Filesystem path of the unix domain socket to dial. */
  path: string;
  /** How long to wait for the 101 response. Default 10s. */
  timeoutMs?: number;
}

/**
 * Events: `message` (string), `close` (code?: number), `error` (Error).
 * Control frames are handled internally: ping is answered with pong, and a
 * close frame is echoed before the socket is ended.
 */
export class WsClient extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = 0;
  private closing = false;
  private ended = false;
  private closeCode: number | undefined;
  private closeTimer: NodeJS.Timeout | null = null;

  private constructor(private readonly socket: net.Socket) {
    super();
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error: Error) => {
      if (this.ended) return;
      this.emit('error', error);
      this.finish();
    });
    socket.on('close', () => this.finish());
  }

  /** True once the peer, or `close()`, has torn the connection down. */
  get isClosed(): boolean { return this.ended; }

  static connect(options: WsConnectOptions): Promise<WsClient> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    return new Promise<WsClient>((resolve, reject) => {
      const key = randomBytes(16).toString('base64');
      const expected = createHash('sha1').update(key + GUID).digest('base64');
      const socket = net.connect({ path: options.path });
      socket.setNoDelay(true);

      let head = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(
        () => fail(new Error(`Timed out after ${timeoutMs}ms waiting for a WebSocket handshake on ${options.path}`)),
        timeoutMs,
      );
      if (typeof timer.unref === 'function') timer.unref();

      function fail(error: Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }

      socket.on('error', (error: Error) => fail(new Error(`Cannot reach ${options.path}: ${error.message}`)));
      socket.on('close', () => fail(new Error(`${options.path} closed before completing the WebSocket handshake`)));
      socket.on('connect', () => {
        socket.write(
          'GET / HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
        );
      });
      socket.on('data', function onHead(chunk: Buffer) {
        if (settled) return;
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          if (head.length > MAX_HEADER_BYTES) fail(new Error('WebSocket handshake response header is too large'));
          return;
        }
        const raw = head.subarray(0, end).toString('latin1');
        const rest = head.subarray(end + 4);
        const [status, ...headerLines] = raw.split('\r\n');
        if (!/^HTTP\/1\.1 101\b/.test(status)) {
          fail(new Error(`WebSocket upgrade refused by ${options.path}: ${status}`));
          return;
        }
        const headers = new Map<string, string>();
        for (const line of headerLines) {
          const colon = line.indexOf(':');
          if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
        if ((headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
          fail(new Error('WebSocket upgrade response is missing "Upgrade: websocket"'));
          return;
        }
        if (headers.get('sec-websocket-accept') !== expected) {
          fail(new Error('WebSocket upgrade response carries a wrong Sec-WebSocket-Accept'));
          return;
        }
        if (headers.has('sec-websocket-extensions')) {
          fail(new Error(`Server negotiated an unsupported WebSocket extension: ${headers.get('sec-websocket-extensions')}`));
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.off('data', onHead);
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        socket.removeAllListeners('connect');
        const client = new WsClient(socket);
        resolve(client);
        // The caller attaches its `message` listener after this promise
        // settles, so anything already in the pipe has to wait a turn.
        if (rest.length) setImmediate(() => client.onData(rest));
      });
    });
  }

  send(text: string): void {
    if (this.ended || this.closing) throw new Error('WebSocket is closed');
    this.socket.write(this.frame(OPCODE.text, Buffer.from(text, 'utf8')));
  }

  /** Start the closing handshake; the socket is dropped either way within a second. */
  close(code = 1000): void {
    if (this.ended) return;
    if (this.closing) { this.socket.destroy(); return; }
    this.closing = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    try {
      this.socket.write(this.frame(OPCODE.close, payload));
      this.socket.end();
    } catch { this.socket.destroy(); }
    this.closeTimer = setTimeout(() => this.socket.destroy(), 1000);
    if (typeof this.closeTimer.unref === 'function') this.closeTimer.unref();
  }

  // ---- framing ----

  /** Client-to-server frames are always masked (RFC 6455 §5.3). */
  private frame(opcode: number, payload: Buffer): Buffer {
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length < 65_536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode; // FIN; we never fragment outgoing messages.
    const mask = randomBytes(4);
    const masked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const frame = this.readFrame();
      if (!frame || this.ended) return;
      this.handleFrame(frame);
      if (this.ended) return;
    }
  }

  private readFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let length = b[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) return null;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return null;
      const wide = b.readBigUInt64BE(2);
      if (wide > BigInt(MAX_MESSAGE_BYTES)) {
        this.fatal(new Error(`WebSocket frame of ${wide} bytes exceeds the ${MAX_MESSAGE_BYTES} byte limit`));
        return null;
      }
      length = Number(wide);
      offset = 10;
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      mask = b.subarray(offset, offset + 4);
      offset += 4;
    }
    if (b.length < offset + length) return null;
    // Copy out: `this.buffer` is re-sliced below and may be concatenated later.
    const payload = Buffer.from(b.subarray(offset, offset + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = b.subarray(offset + length);
    return { fin, opcode, payload };
  }

  private handleFrame(frame: { fin: boolean; opcode: number; payload: Buffer }): void {
    switch (frame.opcode) {
      case OPCODE.text:
      case OPCODE.binary:
        if (frame.fin) { this.emit('message', frame.payload.toString('utf8')); return; }
        this.fragmentOpcode = frame.opcode;
        this.fragments = [frame.payload];
        this.fragmentBytes = frame.payload.length;
        return;
      case OPCODE.continuation: {
        if (!this.fragmentOpcode) { this.fatal(new Error('WebSocket continuation frame without a start frame')); return; }
        this.fragments.push(frame.payload);
        this.fragmentBytes += frame.payload.length;
        if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
          this.fatal(new Error(`WebSocket message exceeds the ${MAX_MESSAGE_BYTES} byte limit`));
          return;
        }
        if (!frame.fin) return;
        const message = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmentOpcode = 0;
        this.emit('message', message.toString('utf8'));
        return;
      }
      case OPCODE.ping:
        if (!this.closing && !this.ended) this.socket.write(this.frame(OPCODE.pong, frame.payload));
        return;
      case OPCODE.pong:
        this.emit('pong', frame.payload);
        return;
      case OPCODE.close: {
        this.closeCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : undefined;
        if (!this.closing) {
          this.closing = true;
          try { this.socket.write(this.frame(OPCODE.close, frame.payload.subarray(0, 2))); } catch { /* peer is gone */ }
        }
        this.socket.end();
        // The peer may never send FIN; do not wait forever for `close`.
        this.closeTimer = setTimeout(() => this.socket.destroy(), 500);
        if (typeof this.closeTimer.unref === 'function') this.closeTimer.unref();
        return;
      }
      default:
        this.fatal(new Error(`Unsupported WebSocket opcode 0x${frame.opcode.toString(16)}`));
    }
  }

  private fatal(error: Error): void {
    if (this.ended) return;
    this.emit('error', error);
    this.socket.destroy();
    this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    this.emit('close', this.closeCode);
  }
}
