import * as http from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { MOBILE_API_PREFIX, type ApiError, type ApiErrorCode } from '../../shared/mobile';
import type { AuthService, DeviceRecord, GatewayServer, LogFn, RouteCtx, RouteHandler, RouteScope } from './types';

// The gateway's HTTP + WebSocket front door. It binds to 127.0.0.1 only:
// the phone reaches it through `tailscale serve`, which proxies from the
// tailnet and adds the owner's login header. Every request runs one pipeline:
// route match -> scope/auth -> paused -> JSON body -> handler -> JSON reply.

export class HttpError extends Error {
  constructor(public status: number, public code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function badRequest(msg: string): HttpError {
  return new HttpError(400, 'bad_request', msg);
}

const BODY_LIMIT = 256 * 1024;
const PAIR_LIMIT = 5;
const PAIR_WINDOW_MS = 60_000;
const EVENTS_PATH = `${MOBILE_API_PREFIX}/events`;

type Method = 'GET' | 'POST' | 'DELETE';
interface Route { method: Method; segs: string[]; scope: RouteScope; handler: RouteHandler }
type Headers = Record<string, string | string[] | undefined>;

export function normaliseIp(raw: string | undefined): string {
  const ip = raw ?? '';
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

const splitPath = (p: string): string[] => p.split('/').filter(Boolean);

function matchSegs(segs: string[], parts: string[]): Record<string, string> | null {
  if (segs.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.startsWith(':')) {
      try { params[s.slice(1)] = decodeURIComponent(parts[i]); } catch { return null; }
    } else if (s !== parts[i]) return null;
  }
  return params;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, close = false): void {
  if (res.headersSent) { res.end(); return; }
  const text = JSON.stringify(body ?? { ok: true });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...(close ? { connection: 'close' } : {}),
  });
  res.end(text);
}

const errBody = (code: ApiErrorCode, error: string): ApiError => ({ error, code });

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > BODY_LIMIT) { reject(badRequest('request body too large')); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > BODY_LIMIT) { done = true; reject(badRequest('request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

export function createGatewayServer(o: { port: number; devMode: boolean; auth: AuthService; log: LogFn; paused: () => boolean }): GatewayServer {
  const routes: Route[] = [];
  let eventsHandler: ((ws: WebSocket, ctx: RouteCtx) => void) | null = null;
  const wss = new WebSocketServer({ noServer: true });

  const devAllowed = (ip: string): boolean => o.devMode && ip === '127.0.0.1';

  /** Scope + auth + paused gate shared by HTTP routes. Returns the device or throws HttpError. */
  const gate = (scope: RouteScope, headers: Headers, ip: string): DeviceRecord | null => {
    if (scope === 'none') {
      if (!o.auth.ownerOk(headers)) throw new HttpError(403, 'forbidden', "request did not come through the owner's tailnet identity");
      return null;
    }
    if (scope === 'pair') {
      if (!o.auth.ownerOk(headers)) throw new HttpError(403, 'forbidden', "request did not come through the owner's tailnet identity");
      if (!o.auth.allow('pair:' + ip, PAIR_LIMIT, PAIR_WINDOW_MS)) throw new HttpError(429, 'rate_limited', 'too many pairing attempts, wait a minute');
      return null;
    }
    if (scope === 'dev') {
      if (!devAllowed(ip)) throw new HttpError(404, 'not_found', 'not found');
      return null;
    }
    const out = o.auth.authenticate(headers, ip);
    if (!out.ok) throw new HttpError(out.status, out.code, out.error);
    if (!out.device.scopes.includes(scope)) throw new HttpError(403, 'forbidden', `this device is not allowed to ${scope}`);
    if (o.paused()) throw new HttpError(503, 'paused', 'mobile access is paused on the Mac');
    return out.device;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const ip = normaliseIp(req.socket.remoteAddress);
    let pathname = '';
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      pathname = url.pathname;
      if (pathname !== MOBILE_API_PREFIX && !pathname.startsWith(MOBILE_API_PREFIX + '/')) throw new HttpError(404, 'not_found', 'not found');
      const parts = splitPath(pathname.slice(MOBILE_API_PREFIX.length));
      const candidates = routes
        .map((r) => ({ r, params: matchSegs(r.segs, parts) }))
        .filter((c): c is { r: Route; params: Record<string, string> } => !!c.params)
        // A dev route the caller may not use must look exactly like a missing one.
        .filter((c) => c.r.scope !== 'dev' || devAllowed(ip));
      if (!candidates.length) throw new HttpError(404, 'not_found', 'not found');
      const hit = candidates.find((c) => c.r.method === req.method);
      if (!hit) throw new HttpError(400, 'bad_request', `method ${req.method} not allowed here`);

      const device = gate(hit.r.scope, req.headers, ip);

      let body: unknown = undefined;
      if (req.method !== 'GET') {
        const buf = await readBody(req);
        if (buf.length === 0) body = {};
        else {
          const ct = String(req.headers['content-type'] ?? '').toLowerCase();
          if (!ct.includes('application/json')) throw badRequest('content-type must be application/json');
          try { body = JSON.parse(buf.toString('utf8')); } catch { throw badRequest('invalid JSON body'); }
        }
      }

      const ctx: RouteCtx = { device, params: hit.params, query: url.searchParams, body, ip, devMode: o.devMode, headers: req.headers };
      const result = await hit.r.handler(ctx);
      sendJson(res, 200, result === undefined ? { ok: true } : result);
    } catch (e) {
      // If the request body was never read (rejected before parsing), close the
      // connection so the unread bytes cannot poison the next request.
      const unread = !req.readableEnded;
      if (e instanceof HttpError) {
        sendJson(res, e.status, errBody(e.code, e.message), unread);
        if (unread) req.resume();
        return;
      }
      o.log('route failed', { path: pathname, error: e instanceof Error ? e.message : String(e) });
      sendJson(res, 500, errBody('unavailable', 'internal error'), unread);
      if (unread) req.resume();
    }
  };

  const server = http.createServer((req, res) => { void handle(req, res); });

  const reject = (socket: Duplex, status: number, text: string): void => {
    try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* already gone */ }
    socket.destroy();
  };

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const ip = normaliseIp(req.socket.remoteAddress);
    let pathname = '';
    let query = new URLSearchParams();
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      pathname = url.pathname;
      query = url.searchParams;
    } catch { /* falls through to 404 */ }
    if (pathname !== EVENTS_PATH) { reject(socket, 404, 'Not Found'); return; }
    const out = o.auth.authenticate(req.headers, ip);
    if (!out.ok || !out.device.scopes.includes('view')) {
      o.log('events upgrade rejected', { ip, code: out.ok ? 'forbidden' : out.code });
      reject(socket, 401, 'Unauthorized');
      return;
    }
    if (o.paused()) { reject(socket, 503, 'Service Unavailable'); return; }
    if (!eventsHandler) { reject(socket, 503, 'Service Unavailable'); return; }
    const handler = eventsHandler;
    const device = out.device;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const ctx: RouteCtx = { device, params: {}, query, body: undefined, ip, devMode: o.devMode, headers: req.headers };
      try { handler(ws, ctx); } catch (e) {
        o.log('events handler failed', { error: e instanceof Error ? e.message : String(e) });
        ws.terminate();
      }
    });
  });

  return {
    addRoute(method, pattern, scope, handler) {
      routes.push({ method, segs: splitPath(pattern), scope, handler });
    },
    onEvents(handler) { eventsHandler = handler; },
    listen() {
      return new Promise<number>((resolve, rejectP) => {
        const onErr = (e: Error): void => rejectP(e);
        server.once('error', onErr);
        server.listen(o.port, '127.0.0.1', () => {
          server.off('error', onErr);
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : o.port);
        });
      });
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      return new Promise<void>((resolve) => {
        if (!server.listening) { resolve(); return; }
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
    connections() { return wss.clients.size; },
  };
}
