// The /api/v1/events WebSocket hub (C1 protocol). One hub per gateway; every
// phone socket attaches here after the server authenticated the upgrade.
//
// After `hello`: welcome → feed items newer than lastSeq (oldest first, each
// advancing the device cursor) → conversations.updated → the hello's
// subscriptions. Live: summary diffs (bus-driven, debounced, plus a 5 s sweep
// because job state files change without the store changing), per-socket
// detail diffs for subscribed ids, transcript appends via the shared tailer,
// new notifications, health every minute, ws-level keepalive.

import * as fs from 'fs';
import type { ClientMessage, ConversationDetail, ConversationSummary, FeedItem, MessageEntry, MobileNotification, ServerEvent } from '../../shared/mobile';
import { openNotifications } from './api';
import type { ApiContext, DeviceRecord } from './types';

const HELLO_TIMEOUT_MS = 10_000;
const DEBOUNCE_MS = 150;
const SWEEP_MS = 5_000;
const DETAIL_TICK_MS = 1_000;
const HEALTH_MS = 60_000;
const PING_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const OPEN = 1;

/** The subset of `ws.WebSocket` the hub touches (lets tests pass a fake). */
type SocketLike = Pick<import('ws').WebSocket, 'on' | 'send' | 'close' | 'ping' | 'terminate' | 'readyState'>;

interface Sock {
  ws: SocketLike;
  device: DeviceRecord;
  ready: boolean;                       // said hello
  subs: Set<string>;                    // subscribed conversation ids
  tailed: Set<string>;                  // subset that holds a tailer refcount
  lastDetail: Map<string, string>;
  helloTimer: NodeJS.Timeout | null;
  detailTimer: NodeJS.Timeout | null;
  pongTimer: NodeJS.Timeout | null;
  closed: boolean;
}

export interface EventHubOptions {
  ctx: ApiContext;
  summaries: () => ConversationSummary[];
  detail: (id: string) => ConversationDetail | null;
  /** Called with every recomputed summary list (the outcome watcher hangs here). */
  onSummaries?: (list: ConversationSummary[]) => void;
  /** Re-tags tailed entries (e.g. user.text sent from the phone) before fan-out. */
  tagEntries?: (conversationId: string, entries: MessageEntry[]) => MessageEntry[];
  /** A socket connected or went away. */
  onConnectionChange?: () => void;
}

export interface EventHub {
  attach(ws: import('ws').WebSocket, device: DeviceRecord): void;
  broadcastSummaries(): void;
  broadcastConversation(summary: ConversationSummary): void;
  broadcastFeed(item: FeedItem): void;
  broadcastNotification(n: MobileNotification): void;
  broadcastHealth(): void;
  close(): void;
  count(): number;
  connectedDeviceIds(): string[];
  closeDevice(id: string): void;
  closeAll(): void;
  /** Recompute summaries now (tests; the bus and the sweep call it too). */
  recompute(): void;
}

const unref = <T extends NodeJS.Timeout>(t: T): T => { t.unref?.(); return t; };

export function createEventHub(o: EventHubOptions): EventHub {
  const { ctx } = o;
  const log = ctx.deps.log;
  const sockets = new Set<Sock>();
  const tails = new Map<string, Set<Sock>>();       // conv id → sockets sharing its tailer
  let lastSummaries = new Map<string, string>();    // id → JSON
  let notifIds = new Set<string>(safeNotifications().map((n) => n.id));
  let debounce: NodeJS.Timeout | null = null;
  let closed = false;

  function safeNotifications(): MobileNotification[] {
    try { return openNotifications(ctx); } catch { return []; }
  }

  const send = (s: Sock, ev: ServerEvent): void => {
    if (s.closed || s.ws.readyState !== OPEN) return;
    try { s.ws.send(JSON.stringify(ev)); } catch { /* socket died mid-send; close handler cleans up */ }
  };
  const broadcast = (ev: ServerEvent): void => { for (const s of sockets) if (s.ready) send(s, ev); };

  const sendFeed = (s: Sock, item: FeedItem): void => {
    send(s, { type: 'feed', item });
    ctx.devices.setCursor(s.device.id, item.seq);
  };

  // ---- subscriptions ----

  const transcriptOf = (id: string): string | null => {
    const conv = ctx.deps.store.getConversation(id);
    if (!conv || !conv.sessionId || conv.provider === 'codex') return null;
    try { return ctx.deps.findTranscript(conv.worktreePath ?? conv.directoryPath, conv.sessionId); } catch { return null; }
  };

  const startTail = (s: Sock, id: string): boolean => {
    let group = tails.get(id);
    if (!group) {
      const file = transcriptOf(id);
      if (!file) return false;
      let size = 0;
      try { size = fs.statSync(file).size; } catch { return false; }
      group = new Set();
      tails.set(id, group);
      const members = group;
      ctx.tailer.subscribe(id, file, size, (entries, end) => {
        const tagged = o.tagEntries ? o.tagEntries(id, entries) : entries;
        for (const m of members) send(m, { type: 'messages.appended', conversationId: id, entries: tagged, end });
      });
    }
    group.add(s);
    s.tailed.add(id);
    return true;
  };

  const stopTail = (s: Sock, id: string): void => {
    if (!s.tailed.delete(id)) return;
    const group = tails.get(id);
    if (!group) return;
    group.delete(s);
    if (group.size === 0) { tails.delete(id); ctx.tailer.unsubscribe(id); }
  };

  const tickDetails = (s: Sock): void => {
    for (const id of s.subs) {
      if (!s.tailed.has(id)) startTail(s, id);           // a fresh chat's transcript appears a few seconds in
      let d: ConversationDetail | null = null;
      try { d = o.detail(id); } catch (e) { log('socket', { deviceId: s.device.id, conversationId: id, ok: false, error: String(e) }); }
      if (!d) continue;
      const json = JSON.stringify(d);
      if (s.lastDetail.get(id) === json) continue;
      s.lastDetail.set(id, json);
      send(s, { type: 'conversation.detail', detail: d });
    }
  };

  const syncDetailTimer = (s: Sock): void => {
    if (s.subs.size > 0 && !s.detailTimer && !s.closed) s.detailTimer = unref(setInterval(() => tickDetails(s), DETAIL_TICK_MS));
    if (s.subs.size === 0 && s.detailTimer) { clearInterval(s.detailTimer); s.detailTimer = null; }
  };

  const subscribe = (s: Sock, ids: unknown): void => {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id !== 'string' || !id || s.subs.has(id)) continue;
      s.subs.add(id);
      startTail(s, id);
    }
    syncDetailTimer(s);
    tickDetails(s);
  };

  const unsubscribe = (s: Sock, ids: unknown): void => {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      s.subs.delete(id);
      s.lastDetail.delete(id);
      stopTail(s, id);
    }
    syncDetailTimer(s);
  };

  // ---- socket lifecycle ----

  const cleanup = (s: Sock): void => {
    if (s.closed) return;
    s.closed = true;
    for (const t of [s.helloTimer, s.pongTimer]) if (t) clearTimeout(t);
    if (s.detailTimer) clearInterval(s.detailTimer);
    s.helloTimer = s.pongTimer = s.detailTimer = null;
    for (const id of [...s.tailed]) stopTail(s, id);
    s.subs.clear();
    sockets.delete(s);
    log('socket', { deviceId: s.device.id, ok: true, event: 'closed' });
    o.onConnectionChange?.();
  };

  const onHello = (s: Sock, msg: Extract<ClientMessage, { type: 'hello' }>): void => {
    s.ready = true;
    if (s.helloTimer) { clearTimeout(s.helloTimer); s.helloTimer = null; }
    send(s, { type: 'welcome', seq: ctx.feed.latestSeq(), health: ctx.health(), serverTime: new Date().toISOString() });
    const lastSeq = typeof msg.lastSeq === 'number' && Number.isFinite(msg.lastSeq) ? msg.lastSeq : 0;
    for (const item of ctx.feed.after(lastSeq)) sendFeed(s, item);
    let list: ConversationSummary[] = [];
    try { list = o.summaries(); } catch (e) { log('socket', { deviceId: s.device.id, ok: false, error: String(e) }); }
    send(s, { type: 'conversations.updated', summaries: list });
    if (msg.subscribe) subscribe(s, msg.subscribe);
  };

  const onMessage = (s: Sock, raw: unknown): void => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : Array.isArray(raw) ? Buffer.concat(raw as Buffer[]).toString('utf8') : String(raw));
    } catch {
      send(s, { type: 'error', message: 'messages must be JSON' });
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (!s.ready) {
      if (msg.type !== 'hello') { s.ws.close(4000, 'hello expected first'); return; }
      onHello(s, msg);
      return;
    }
    switch (msg.type) {
      case 'hello': onHello(s, msg); break;
      case 'subscribe': subscribe(s, msg.ids); break;
      case 'unsubscribe': unsubscribe(s, msg.ids); break;
      case 'ping': send(s, { type: 'pong', serverTime: new Date().toISOString() }); break;
      default: send(s, { type: 'error', message: 'unknown message type' });
    }
  };

  // ---- hub-level recompute ----

  const recompute = (): void => {
    if (closed) return;
    let next: ConversationSummary[];
    try { next = o.summaries(); } catch (e) { log('socket', { ok: false, error: `summaries failed: ${String(e)}` }); return; }
    const nextMap = new Map(next.map((s) => [s.id, JSON.stringify(s)]));
    const sameIds = nextMap.size === lastSummaries.size && [...nextMap.keys()].every((id) => lastSummaries.has(id));
    if (!sameIds) {
      broadcast({ type: 'conversations.updated', summaries: next });
    } else {
      for (const s of next) if (lastSummaries.get(s.id) !== nextMap.get(s.id)) broadcast({ type: 'conversation.updated', summary: s });
    }
    lastSummaries = nextMap;
    try { o.onSummaries?.(next); } catch (e) { log('socket', { ok: false, error: `onSummaries failed: ${String(e)}` }); }
  };

  const onConversationsChanged = (): void => {
    if (debounce || closed) return;
    // pinned.updated: order, separators or to-dos may have changed without any chat changing.
    debounce = unref(setTimeout(() => { debounce = null; recompute(); broadcast({ type: 'pinned.updated' }); }, DEBOUNCE_MS));
  };

  const onNotificationsChanged = (): void => {
    const now = safeNotifications();
    for (const n of now) if (!notifIds.has(n.id)) broadcast({ type: 'notification.added', notification: n });
    notifIds = new Set(now.map((n) => n.id));
  };

  const bus = ctx.deps.bus;
  bus.on('conversations.changed', onConversationsChanged);
  bus.on('notifications.changed', onNotificationsChanged);

  const sweep = unref(setInterval(recompute, SWEEP_MS));
  const health = unref(setInterval(() => hub.broadcastHealth(), HEALTH_MS));
  const keepalive = unref(setInterval(() => {
    for (const s of sockets) {
      if (s.closed || s.pongTimer) continue;
      try { s.ws.ping(); } catch { continue; }
      s.pongTimer = unref(setTimeout(() => {
        log('socket', { deviceId: s.device.id, ok: false, event: 'pong timeout' });
        try { s.ws.terminate(); } catch { /* already gone */ }
        cleanup(s);
      }, PONG_TIMEOUT_MS));
    }
  }, PING_MS));

  const hub: EventHub = {
    attach(ws, device) {
      const s: Sock = {
        ws, device, ready: false, subs: new Set(), tailed: new Set(), lastDetail: new Map(),
        helloTimer: null, detailTimer: null, pongTimer: null, closed: false,
      };
      if (closed) { try { ws.close(1001, 'gateway stopping'); } catch { /* ignore */ } return; }
      sockets.add(s);
      s.helloTimer = unref(setTimeout(() => { if (!s.ready) { try { ws.close(4000, 'hello expected within 10 s'); } catch { /* ignore */ } } }, HELLO_TIMEOUT_MS));
      ws.on('message', (data: unknown) => onMessage(s, data));
      ws.on('pong', () => { if (s.pongTimer) { clearTimeout(s.pongTimer); s.pongTimer = null; } });
      ws.on('close', () => cleanup(s));
      ws.on('error', () => cleanup(s));
      log('socket', { deviceId: device.id, ok: true, event: 'open' });
      o.onConnectionChange?.();
    },
    broadcastSummaries() {
      let list: ConversationSummary[];
      try { list = o.summaries(); } catch { return; }
      lastSummaries = new Map(list.map((s) => [s.id, JSON.stringify(s)]));
      broadcast({ type: 'conversations.updated', summaries: list });
    },
    broadcastConversation(summary) { broadcast({ type: 'conversation.updated', summary }); },
    broadcastFeed(item) { for (const s of sockets) if (s.ready) sendFeed(s, item); },
    broadcastNotification(n) { broadcast({ type: 'notification.added', notification: n }); },
    broadcastHealth() {
      if (sockets.size === 0) return;
      let h;
      try { h = ctx.health(); } catch { return; }
      broadcast({ type: 'server.health', health: h });
    },
    close() {
      if (closed) return;
      closed = true;
      if (debounce) clearTimeout(debounce);
      clearInterval(sweep); clearInterval(health); clearInterval(keepalive);
      bus.off('conversations.changed', onConversationsChanged);
      bus.off('notifications.changed', onNotificationsChanged);
      for (const s of [...sockets]) { try { s.ws.close(1001, 'gateway stopping'); } catch { /* ignore */ } cleanup(s); }
    },
    count() { return sockets.size; },
    connectedDeviceIds() { return [...new Set([...sockets].map((s) => s.device.id))]; },
    closeDevice(id) {
      for (const s of [...sockets]) if (s.device.id === id) { try { s.ws.close(4001, 'device revoked'); } catch { /* ignore */ } cleanup(s); }
    },
    closeAll() {
      for (const s of [...sockets]) { try { s.ws.close(4003, 'gateway paused'); } catch { /* ignore */ } cleanup(s); }
    },
    recompute,
  };
  return hub;
}
