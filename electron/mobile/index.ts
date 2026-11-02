// startMobileGateway: assembles the in-process mobile gateway from its parts
// (device store, auth, HTTP/WS server, idempotency cache, outcome feed,
// transcript tailer, heartbeat, tailscale helper) and the routes + event hub.
// Everything app-side arrives through GatewayDeps, so this file never imports
// electron, the store or the poller.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Conversation } from '../../shared/types';
import type { MessageEntry, MessageSource, MobileSettings, MobileStatus, PairingOffer, ServerHealth, TailnetInfo } from '../../shared/mobile';
import { detailOf, deviceInfo, registerRoutes, summarise } from './api';
import { createAuthService } from './auth';
import { readMobileEnv } from './dev-mode';
import { normalizePublicUrl, createDeviceStore } from './devices';
import { createEventHub, type EventHub } from './events';
import { createHeartbeat } from './heartbeat';
import { createIdempotencyCache } from './idempotency';
import { createFeedStore, createOutcomeWatcher } from './outcomes';
import { createGatewayServer } from './server';
import { createTailscaleHelper } from './tailscale';
import { createTailer, normaliseText, stripSpokenAt } from './transcript-tailer';
import type { ApiContext, AuthService, MobileGateway, StartMobileGateway } from './types';

const TAIL_BYTES = 96 * 1024;
const NOTED_PER_CONV = 100;
const TAILNET_POLL_MS = 5 * 60_000;
const TOUCH_PUSH_MIN_MS = 1_000;

/** The newest assistant entry with text in the last 96 KB of a transcript. */
export function lastAssistantFromTail(tail: string): { text: string; at: string; uuid: string } | null {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let rec: { type?: unknown; uuid?: unknown; timestamp?: unknown; message?: { content?: unknown } };
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || rec.type !== 'assistant') continue;
    const content = rec.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((p): p is { type: 'text'; text: string } => !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
        .map((p) => p.text)
        .join('\n');
    }
    text = text.trim();
    if (!text) continue;
    return { text, at: typeof rec.timestamp === 'string' ? rec.timestamp : '', uuid: typeof rec.uuid === 'string' ? rec.uuid : '' };
  }
  return null;
}

function readTail(file: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : ''; }   // drop the cut-off first line
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

export const startMobileGateway: StartMobileGateway = async (deps) => {
  const now = deps.now ?? Date.now;
  const log = deps.log;

  let env: { devMode: boolean; port: number; sttKeyFromEnv: string | null };
  try { env = readMobileEnv(deps.env); } catch { env = { devMode: deps.devMode, port: deps.port, sttKeyFromEnv: null }; }
  const devMode = deps.devMode || env.devMode;
  const port = deps.port;

  const devices = createDeviceStore(path.join(deps.userDataDir, 'mobile-devices.json'), now);
  const baseAuth = createAuthService({ devices, devMode, ownerLogin: () => devices.settings().ownerLogin, log, now });

  // ---- status push plumbing (needs to exist before auth is wrapped) ----
  const listeners = new Set<(s: MobileStatus) => void>();
  let lastTouchPush = 0;
  let touchTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  const push = (): void => {
    if (stopped || listeners.size === 0) return;
    let s: MobileStatus;
    try { s = gateway.status(); } catch (e) { log('status failed', { error: String(e) }); return; }
    for (const cb of listeners) { try { cb(s); } catch { /* a listener's bug is its own */ } }
  };
  const pushThrottled = (): void => {
    const t = now();
    if (t - lastTouchPush >= TOUCH_PUSH_MIN_MS) { lastTouchPush = t; push(); return; }
    if (touchTimer) return;
    touchTimer = setTimeout(() => { touchTimer = null; lastTouchPush = now(); push(); }, TOUCH_PUSH_MIN_MS - (t - lastTouchPush));
    touchTimer.unref?.();
  };

  // Wrapped so a device touch (lastSeen/lastIp) or a new pairing reaches the sidebar.
  const auth: AuthService = {
    ...baseAuth,
    authenticate(h, ip) { const r = baseAuth.authenticate(h, ip); if (r.ok && listeners.size) pushThrottled(); return r; },
    redeemPairingCode(code, name, ip) { const r = baseAuth.redeemPairingCode(code, name, ip); if (r) queueMicrotask(push); return r; },
  };

  const paused = (): boolean => devices.settings().paused;
  const server = createGatewayServer({ port, devMode, auth, log, paused });
  const idem = createIdempotencyCache(path.join(deps.userDataDir, 'mobile-idempotency.json'));
  const feed = createFeedStore(path.join(deps.userDataDir, 'mobile-feed.json'));
  const tailer = createTailer({ log });
  const heartbeat = createHeartbeat(path.join(deps.userDataDir, 'mobile-heartbeat.json'), { now });

  let cliVersion = '';
  deps.exec('claude', ['--version'], 10_000)
    .then((r) => { cliVersion = r.code === 0 ? (r.stdout.split('\n')[0] ?? '').trim() : ''; })
    .catch(() => { cliVersion = ''; });

  // ---- tailnet ----
  const tailscale = createTailscaleHelper({
    exec: deps.exec,
    socket: deps.env.PEERSFLOW_MOBILE_TS_SOCKET ?? path.join(os.homedir(), '.tailscale-home', 'tailscaled.sock'),
    bin: deps.env.PEERSFLOW_MOBILE_TS_BIN ?? 'tailscale',
    log,
  });
  let tailnet: TailnetInfo = { available: false, serveOn: false };
  const httpsPort = (): number => devices.settings().httpsPort;
  const pollTailnet = async (): Promise<void> => {
    try {
      const st = await tailscale.status(port, httpsPort());
      const { backendState: _b, ...info } = st;
      void _b;
      tailnet = info;
    } catch (e) {
      tailnet = { available: false, serveOn: false, error: e instanceof Error ? e.message : String(e) };
    }
    push();
  };

  const pairUrl = (): string => (devMode ? `http://10.0.2.2:${actualPort}` : devices.settings().publicUrl || (tailnet.url ? `${tailnet.url}:${httpsPort()}` : `http://127.0.0.1:${actualPort}`));
  const fingerprint = (): string => '';
  const sttKey = (): string | null => devices.settings().sttKey || env.sttKeyFromEnv || null;

  // ---- phone-sent texts: tag the matching transcript entry with its source ----
  const noted = new Map<string, { text: string; source: MessageSource }[]>();
  const noteSent = (conversationId: string, text: string, source: MessageSource): void => {
    const list = noted.get(conversationId) ?? [];
    list.push({ text: normaliseText(stripSpokenAt(text)), source });   // matches how the phone shows a voice task
    while (list.length > NOTED_PER_CONV) list.shift();
    noted.set(conversationId, list);
  };
  const tagEntries = (conversationId: string, entries: MessageEntry[]): MessageEntry[] => {
    const list = noted.get(conversationId);
    if (!list || list.length === 0) return entries;
    return entries.map((e) => {
      if (e.kind !== 'user.text') return e;
      const key = normaliseText(e.text);
      const i = list.findIndex((n) => n.text === key);
      if (i < 0) return e;
      const [hit] = list.splice(i, 1);
      return { ...e, source: hit.source };
    });
  };

  const health = (): ServerHealth => ({
    ok: true,
    hostname: os.hostname(),
    appVersion: deps.appVersion,
    cliVersion,
    uptimeSec: Math.max(0, Math.floor((now() - heartbeat.startedAt) / 1000)),
    now: new Date(now()).toISOString(),
    devMode,
    paused: paused(),
    load1: os.loadavg()[0] ?? null,
    lastOutage: heartbeat.lastOutage(),
  });

  const ctx: ApiContext = {
    deps, server, auth, devices, idem, feed, tailer, heartbeat,
    cliVersion: () => cliVersion, health, pairUrl, fingerprint, sttKey, noteSent,
  };
  registerRoutes(ctx);

  let hub: EventHub | null = null;
  const watcher = createOutcomeWatcher({
    feed,
    readLastAssistant: (conv: Conversation) => {
      if (!conv.sessionId) return null;
      const file = deps.findTranscript(conv.worktreePath ?? conv.directoryPath, conv.sessionId);
      return file ? lastAssistantFromTail(readTail(file)) : null;
    },
    onItem: (item) => hub?.broadcastFeed(item),
    log,
  });
  hub = createEventHub({
    ctx,
    summaries: () => summarise(ctx),
    detail: (id) => detailOf(ctx, id),
    // Only tasks started from the phone by voice reach the phone as a notification
    // (and a spoken conclusion). Every other chat finishing on the Mac stays silent:
    // the user found Mac-chat notifications on the phone unwanted (2026-11-01).
    onSummaries: (list) => watcher.tick(list.filter((s) => s.chatKind === 'voice'), deps.store.getConversations(), (id) => detailOf(ctx, id)?.job ?? null),
    tagEntries,
    onConnectionChange: () => push(),
  });
  const theHub = hub;
  server.onEvents((ws, rctx) => {
    if (!rctx.device) { try { ws.close(4001, 'unauthorized'); } catch { /* ignore */ } return; }
    theHub.attach(ws, rctx.device);
  });

  const actualPort = await server.listen();
  heartbeat.start();
  log('listening', { host: '127.0.0.1', port: actualPort, devMode });

  void pollTailnet();
  const tailnetTimer = setInterval(() => { void pollTailnet(); }, TAILNET_POLL_MS);
  tailnetTimer.unref?.();

  const settingsOut = (): MobileSettings => {
    const s = devices.settings();
    return { ownerLogin: s.ownerLogin, sttKeySet: !!sttKey(), vocabulary: [...s.vocabulary], httpsPort: s.httpsPort, publicUrl: s.publicUrl };
  };

  const gateway: MobileGateway = {
    port: actualPort,
    status() {
      const connected = new Set(theHub.connectedDeviceIds());
      return {
        running: !stopped,
        port: actualPort,
        devMode,
        paused: paused(),
        connectedSockets: theHub.count(),
        devices: devices.list().filter((d) => !d.revokedAt).map((d) => ({
          ...deviceInfo(d), connected: connected.has(d.id), cursor: d.cursor, ...(d.lastIp ? { lastIp: d.lastIp } : {}),
        })),
        settings: settingsOut(),
        tailnet: { ...tailnet },
        pairing: auth.currentOffer(),
      };
    },
    startPairing(): PairingOffer {
      const offer = auth.createPairingCode(pairUrl(), fingerprint());
      log('pair', { ok: true, event: 'offer', expiresAt: offer.expiresAt });
      push();
      return offer;
    },
    cancelPairing() { auth.cancelPairing(); push(); },
    revokeDevice(id) {
      devices.revoke(id);
      theHub.closeDevice(id);
      log('revoke', { deviceId: id, ok: true });
      push();
    },
    revokeAll() {
      const ids = devices.list().filter((d) => !d.revokedAt).map((d) => d.id);
      devices.revokeAll();
      for (const id of ids) theHub.closeDevice(id);
      theHub.closeAll();
      log('revoke', { deviceId: 'all', ok: true, count: ids.length });
      push();
    },
    setPaused(p) {
      devices.updateSettings({ paused: !!p });
      if (p) theHub.closeAll();
      log('pause', { ok: true, paused: !!p });
      push();
    },
    setDeviceScopes(id, scopes) { devices.setScopes(id, scopes); push(); },
    updateSettings(patch) {
      const next: Parameters<typeof devices.updateSettings>[0] = {};
      if (patch.ownerLogin !== undefined) next.ownerLogin = patch.ownerLogin;
      if (patch.vocabulary !== undefined) next.vocabulary = patch.vocabulary;
      if (patch.httpsPort !== undefined) next.httpsPort = patch.httpsPort;
      if (patch.sttKey !== undefined) next.sttKey = patch.sttKey;
      if (patch.publicUrl !== undefined) next.publicUrl = normalizePublicUrl(patch.publicUrl);
      devices.updateSettings(next);
      if (patch.httpsPort !== undefined && tailnet.available && !tailnet.serveOn) {
        // The ONLY path that turns Tailscale Serve on: an explicit settings change.
        tailscale.enableServe(actualPort, httpsPort())
          .then(() => pollTailnet())
          .catch((e) => log('tailscale serve failed', { error: e instanceof Error ? e.message : String(e) }));
      }
      push();
      return settingsOut();
    },
    onStatus(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(tailnetTimer);
      if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
      heartbeat.stop();
      theHub.close();
      tailer.stop();
      await server.close();
      idem.flushSync();
      feed.flushSync();
      devices.flushSync();
      listeners.clear();
    },
  };
  return gateway;
};
