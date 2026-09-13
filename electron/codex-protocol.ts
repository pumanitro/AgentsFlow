import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import { INITIALIZE_PARAMS, codexSocketPath, ensureCodexServer, stopCodexServer } from './codex-server';
import { WsClient } from './ws-client';

// App-server is versioned independently of this app. Only the small wire surface
// we consume is modeled here; unknown notifications remain forward compatible.
export type WireObject = Record<string, any>;

export interface CodexRpcOptions {
  /**
   * Electron's `userData` directory — it decides where the socket, pidfile and
   * server log live. `main.ts` should pass `app.getPath('userData')` explicitly;
   * the default below only exists so a zero-argument `new CodexRpc()` still works.
   */
  userData?: string;
  /** Extra environment for a server this client has to spawn. */
  env?: NodeJS.ProcessEnv;
  /** Reconnect automatically after an unexpected close. Default true. */
  reconnect?: boolean;
}

export function defaultUserData(): string {
  const configured = process.env.AGENTSFLOW_USER_DATA;
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), 'Library', 'Application Support', 'Peers Flow');
}

/** 1s, 2s, 4s … capped at 30s. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * A JSON-RPC client for the Codex app-server.
 *
 * The transport is a WebSocket over a unix socket, not a child process's stdio:
 * the server is a detached daemon that keeps running turns after this app quits
 * (see `codex-server.ts`). `close()` therefore drops the *connection* and stops
 * reconnecting — it deliberately leaves the server, and every thread inside it,
 * running. Use `stopCodexServer()` if you really mean to end them.
 *
 * Events: `connected` ({ socketPath }) after every successful initialize,
 * `disconnected` (Error), `notification`, `request`, `diagnostic`.
 */
export class CodexRpc extends EventEmitter {
  private ws: WsClient | null = null;
  private ready: Promise<void> | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly userData: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly reconnectEnabled: boolean;
  /** Set by `close()`. Suppresses reconnects until the next `start()`/`restart()`. */
  private stopped = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(options: CodexRpcOptions = {}) {
    super();
    this.userData = options.userData ? path.resolve(options.userData) : defaultUserData();
    this.env = options.env;
    this.reconnectEnabled = options.reconnect !== false;
  }

  /** The unix socket this client dials — the same path `codex resume --remote` needs. */
  socketPath(): string { return codexSocketPath(this.userData); }

  isConnected(): boolean { return this.ws !== null; }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.ready) return this.ready;
    const attempt = this.launch().catch((error) => {
      // Do not cache a rejection: the next start() must be free to try again.
      if (this.ready === attempt) this.ready = null;
      throw error;
    });
    this.ready = attempt;
    return attempt;
  }

  /**
   * Forget the connection and fail everything waiting on it. Synchronous on
   * purpose: `ready` must be null before the next `start()` can be called,
   * otherwise a deliberate reconnect would hand back the promise of the
   * connection we just dropped.
   */
  private reset(error: Error, announce: boolean): void {
    const ws = this.ws;
    this.ws = null;
    this.ready = null;
    if (ws) {
      ws.removeAllListeners();
      // A dropped connection still needs a listener or Node throws on 'error'.
      ws.on('error', () => { /* nothing left to report */ });
      try { ws.close(); } catch { /* already gone */ }
    }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    if (announce) this.emit('disconnected', error);
  }

  private async launch(): Promise<void> {
    // Re-run on every attempt: the server may have died since the last one.
    await ensureCodexServer({ userData: this.userData, env: this.env });
    const socketPath = this.socketPath();
    const ws = await WsClient.connect({ path: socketPath, timeoutMs: 15_000 });
    this.ws = ws;
    ws.on('message', (text: string) => {
      try { this.receive(JSON.parse(text)); }
      catch (error) { this.emit('diagnostic', error); }
    });
    const dropped = (error: Error) => {
      if (this.ws !== ws) return; // Already torn down by close(), restart(), or an earlier failure.
      this.reset(error, true);
      this.scheduleReconnect();
    };
    ws.on('error', (error: Error) => dropped(new Error(`Codex app-server connection failed: ${error.message}`)));
    ws.on('close', () => dropped(new Error('Codex app-server connection closed.')));

    try {
      await this.request('initialize', INITIALIZE_PARAMS);
      this.write({ method: 'initialized', params: {} });
    } catch (error) {
      this.ws = null;
      ws.removeAllListeners();
      ws.on('error', () => { /* discarded */ });
      ws.close();
      throw error;
    }
    this.attempt = 0;
    this.emit('connected', { socketPath });
  }

  private scheduleReconnect(): void {
    if (!this.reconnectEnabled || this.stopped || this.retryTimer) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      void this.start().catch((error) => {
        this.emit('diagnostic', error);
        this.scheduleReconnect();
      });
    }, wait);
    // Never keep the process alive just to retry.
    if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
  }

  receive(message: WireObject): void {
    if (message.method) {
      this.emit(message.id === undefined ? 'notification' : 'request', message);
    } else {
      const p = this.pending.get(message.id);
      if (!p) return;
      this.pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error) p.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else p.resolve(message.result);
    }
  }

  private write(value: WireObject): void {
    if (!this.ws) throw new Error('Codex is disconnected. Reopen the conversation to reconnect.');
    this.ws.send(JSON.stringify(value));
  }

  request(method: string, params: WireObject = {}): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  reply(id: number | string, result: WireObject): void { this.write({ id, result }); }
  rejectRequest(id: number | string, message: string): void { this.write({ id, error: { code: -32601, message } }); }

  /**
   * Drop the connection and stop reconnecting. The app-server keeps running —
   * that is the point of the daemon model — so a later `start()` rejoins the
   * same threads.
   */
  close(): void {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.attempt = 0;
    if (this.ws || this.ready) this.reset(new Error('Codex app-server connection was closed.'), true);
  }

  /**
   * Replace the app-server itself, for cases where its own state is stale — a
   * Codex account switch, for instance, since sign-in is read at startup.
   * Emits `disconnected`, then `connected`.
   */
  async restart(): Promise<void> {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.attempt = 0;
    if (this.ws || this.ready) this.reset(new Error('Codex app-server is restarting.'), true);
    await stopCodexServer(this.userData);
    this.stopped = false;
    await this.start();
  }
}
