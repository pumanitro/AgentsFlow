/**
 * Wake proxy — holds the public ports of a sleeping service and wakes it on the
 * first connection.
 *
 * While a service is asleep, Peers Flow listens on its ports itself. The first
 * connection is accepted and paused (nothing is read from it), every listener of
 * that service is closed so the real service can bind the same port again, and
 * `onWake` is called once. When the service is up, the held connection is joined
 * to `127.0.0.1:<port>` and piped both ways — the client gets its reply on the
 * same connection, no retry needed (handoff verified on macOS, probe2/probe3).
 *
 * Connections that arrive while the listeners are down get "connection refused"
 * by design; callers (atlas's UI behind the vite proxy) retry on 502/504.
 *
 * Never throws: bind errors land in `failed[]`, socket errors destroy only the
 * pair they belong to. Timers are unref'd so the proxy never holds the app open.
 */
import * as net from 'node:net';
import { SERVICE_DEFAULTS, type ServicePort } from '../../shared/services';

export interface WakeProxy {
  arm(id: string, ports: ServicePort[]): Promise<{ armed: ServicePort[]; failed: Array<{ port: ServicePort; error: string }> }>;  // EADDRINUSE → failed, never throws
  disarm(id: string): Promise<void>;        // closes listeners (does NOT await their close callbacks: they wait for held sockets); held sockets are kept until piped or timed out
  guarded(id: string): number[];            // ports currently listened on for this id
  close(): Promise<void>;                   // everything, on app quit
}

const RETRY_MS = 250;

interface Entry {
  listeners: Map<number, { port: ServicePort; server: net.Server }>;
  ports: ServicePort[];                    // what was last armed — re-armed after a failed wake
  episode: Promise<boolean> | null;        // the wake in flight; concurrent connections share it
  gen: number;                             // bumped by disarm: a re-arm scheduled before it is dropped
}

export function createWakeProxy(opts: {
  onWake: (id: string, port: ServicePort) => Promise<boolean>;   // called ONCE per wake episode; concurrent connections (any port of the id) queue on the same promise
  log: (msg: string, detail?: Record<string, unknown>) => void;
  holdMs?: number;                                               // SERVICE_DEFAULTS.holdMs
}): WakeProxy {
  const holdMs = opts.holdMs ?? SERVICE_DEFAULTS.holdMs;
  const entries = new Map<string, Entry>();
  const live = new Set<net.Socket>();      // held client sockets and their upstreams, for close()
  let closed = false;

  const log = (msg: string, detail?: Record<string, unknown>): void => {
    try { opts.log(msg, detail); } catch { /* a logger must never break the proxy */ }
  };
  const entry = (id: string): Entry => {
    let e = entries.get(id);
    if (!e) { e = { listeners: new Map(), ports: [], episode: null, gen: 0 }; entries.set(id, e); }
    return e;
  };
  const track = (s: net.Socket): void => { live.add(s); s.once('close', () => live.delete(s)); };

  // Stop accepting at once. The close callback only fires once every accepted
  // socket is gone — and we are holding one — so it is never awaited.
  function closeListeners(e: Entry): void {
    for (const { server } of e.listeners.values()) {
      try { server.close(); } catch { /* already closed */ }
    }
    e.listeners.clear();
  }

  function listen(id: string, e: Entry, port: ServicePort): Promise<string | null> {
    return new Promise((resolve) => {
      const server = net.createServer({ pauseOnConnect: true }, (sock) => onConnection(id, port, sock));
      const onError = (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message);
      server.once('error', onError);
      try {
        server.listen(port.port, port.host, () => {
          server.off('error', onError);
          server.on('error', (err) => log('wake proxy listener error', { id, port: port.port, error: String(err) }));
          server.unref();
          e.listeners.set(port.port, { port, server });
          resolve(null);
        });
      } catch (err) {
        resolve(String(err));
      }
    });
  }

  async function arm(id: string, ports: ServicePort[]) {
    const armed: ServicePort[] = [];
    const failed: Array<{ port: ServicePort; error: string }> = [];
    if (closed) return { armed, failed: ports.map((port) => ({ port, error: 'wake proxy closed' })) };
    const e = entry(id);
    // Binding now would steal the port from the service that is starting up.
    if (e.episode) return { armed, failed: ports.map((port) => ({ port, error: 'waking' })) };
    e.ports = ports.slice();
    for (const port of ports) {
      if (e.listeners.has(port.port)) { armed.push(port); continue; }
      const error = await listen(id, e, port);
      if (error) failed.push({ port, error });
      else armed.push(port);
    }
    return { armed, failed };
  }

  function rearm(id: string, e: Entry, gen: number, why: string): void {
    if (closed || e.gen !== gen || e.listeners.size > 0) return;
    void arm(id, e.ports).then(({ armed, failed }) => {
      log(`wake proxy re-armed after ${why}`, { id, armed: armed.map((p) => p.port), failed });
    });
  }

  function onConnection(id: string, port: ServicePort, sock: net.Socket): void {
    sock.pause();
    track(sock);
    sock.on('error', () => { /* client vanished while held; nothing to do */ });
    const e = entry(id);
    const gen = e.gen;                     // a disarm after this point means someone else owns the wake
    const deadline = Date.now() + holdMs;
    const holdTimer = setTimeout(() => {
      log('wake proxy gave up holding a connection', { id, port: port.port, holdMs });
      sock.destroy();
    }, holdMs);
    holdTimer.unref();

    if (!e.episode) {
      // Close on the next turn, not now: connections already in this poll batch
      // (other ports of the same service, or the same backlog) are accepted first
      // and join this episode instead of being refused.
      e.episode = new Promise<boolean>((resolve) => {
        setImmediate(() => {
          closeListeners(e);
          log('wake proxy: first connection, waking', { id, port: port.port });
          Promise.resolve()
            .then(() => opts.onWake(id, port))
            .then((ok) => resolve(ok === true), (err) => { log('wake proxy: onWake threw', { id, error: String(err) }); resolve(false); });
        });
      });
      void e.episode.then((ok) => {
        e.episode = null;
        if (!ok) { log('wake proxy: wake failed', { id }); rearm(id, e, gen, 'a failed wake'); }
      });
    }

    void e.episode.then((ok) => {
      if (!ok || sock.destroyed) { clearTimeout(holdTimer); sock.destroy(); return; }
      connectUp(port.port, deadline, sock, (up) => {
        clearTimeout(holdTimer);
        if (!up) {
          log('wake proxy: service never accepted', { id, port: port.port });
          sock.destroy();
          rearm(id, e, gen, 'a wake that never accepted');
          return;
        }
        const end = () => { sock.destroy(); up.destroy(); };
        sock.on('error', end); up.on('error', end);
        sock.on('close', end); up.on('close', end);
        sock.pipe(up).pipe(sock);
        sock.resume();
      });
    });
  }

  // Retry every RETRY_MS until the real service accepts, the deadline passes, or
  // the held client goes away.
  function connectUp(portNo: number, deadline: number, sock: net.Socket, done: (up: net.Socket | null) => void): void {
    if (closed || sock.destroyed) { done(null); return; }
    const up = net.connect(portNo, '127.0.0.1');
    track(up);
    up.once('connect', () => { up.removeAllListeners('error'); done(up); });
    up.once('error', () => {
      up.destroy();
      if (Date.now() + RETRY_MS > deadline) { done(null); return; }
      const t = setTimeout(() => connectUp(portNo, deadline, sock, done), RETRY_MS);
      t.unref();
    });
  }

  async function disarm(id: string): Promise<void> {
    const e = entries.get(id);
    if (!e) return;
    e.gen++;
    closeListeners(e);
  }

  function guarded(id: string): number[] {
    const e = entries.get(id);
    return e ? [...e.listeners.keys()].sort((a, b) => a - b) : [];
  }

  async function close(): Promise<void> {
    closed = true;
    for (const e of entries.values()) { e.gen++; closeListeners(e); }
    for (const s of live) s.destroy();
    live.clear();
  }

  return { arm, disarm, guarded, close };
}
