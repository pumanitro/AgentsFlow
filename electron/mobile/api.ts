// Every REST route of the mobile gateway (contract C2). Handlers use ONLY the
// injected ApiContext: no store, poller or PTY import, so tests drive them with
// fakes. Errors leave through HttpError and nothing else; the server maps them.

import * as fs from 'fs';
import * as os from 'os';
import * as fsMod from 'fs';
import * as pathMod from 'path';
import {
  MOBILE_API_VERSION,
  type ConversationDetail,
  type ConversationSummary,
  type DeviceInfo,
  type FeedItem,
  type MessageEntry,
  type MessageSource,
  type MessagesPage,
  type MobileNotification,
  type PairResponse,
  type PeerSummary,
  type ReplyResponse,
  type SpawnConversationResponse,
} from '../../shared/mobile';
import type { CodexSnapshot } from '../../shared/codex';
import type { UserNotification } from '../../shared/notifications';
import type { ChatKind, Conversation, RunContract } from '../../shared/types';
import { findLiveRow } from '../derive-state';
import { sliceFromJobState, readJobSlice } from './job-state';
import { filterSummaries, orderSummaries, toSummary } from './summaries';
import { hasUserTextAfter, readMessagesPage } from './transcript-tailer';
import { buildVocabulary } from './vocabulary';
import { HttpError } from './server';
import { buildPinnedList } from './pinned';
import type { PinnedListResponse } from '../../shared/mobile';
import type { ApiContext, DeviceRecord, RouteCtx } from './types';

const MAX_TEXT = 20_000;
const MAX_CLIENT_ID = 80;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const SOURCES: MessageSource[] = ['desktop', 'phone', 'voice'];
const CONTRACTS: RunContract[] = ['once', 'until-done', 'forever'];

const nowMs = (ctx: ApiContext): number => (ctx.deps.now ? ctx.deps.now() : Date.now());
const emptyPage = (): MessagesPage => ({ entries: [], hasMore: false, cursor: 0, end: 0 });
const isCodex = (c: Conversation): boolean => c.provider === 'codex';
const cwdOf = (c: Conversation): string => c.worktreePath ?? c.directoryPath;

// ---- validation helpers ----

function bodyOf(ctx: RouteCtx): Record<string, unknown> {
  const b = ctx.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'bad_request', 'request body must be a JSON object');
  return b as Record<string, unknown>;
}

function reqStr(v: unknown, name: string, min: number, max: number): string {
  if (typeof v !== 'string' || v.length < min || v.length > max) {
    throw new HttpError(400, 'bad_request', `${name} must be a string of ${min}-${max} characters`);
  }
  return v;
}

function optStr(v: unknown, name: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  return reqStr(v, name, 0, max);
}

function sourceOf(v: unknown, fallback: MessageSource): MessageSource {
  return SOURCES.includes(v as MessageSource) ? (v as MessageSource) : fallback;
}

function contractOf(v: unknown): RunContract | undefined {
  if (v === undefined || v === null) return undefined;
  if (!CONTRACTS.includes(v as RunContract)) throw new HttpError(400, 'bad_request', `contract must be one of ${CONTRACTS.join(', ')}`);
  return v as RunContract;
}

function needConv(ctx: ApiContext, id: string): Conversation {
  const conv = ctx.deps.store.getConversation(id);
  if (!conv) throw new HttpError(404, 'not_found', 'no such conversation');
  return conv;
}

// ---- shared shapes (events.ts and index.ts reuse these) ----

export function deviceInfo(d: DeviceRecord): DeviceInfo {
  return { id: d.id, name: d.name, scopes: [...d.scopes], createdAt: d.createdAt, lastSeenAt: d.lastSeenAt };
}

export function toMobileNotification(n: UserNotification): MobileNotification {
  const out: MobileNotification = { id: n.id, level: n.level, title: n.title, createdAt: n.createdAt };
  if (n.body) out.body = n.body;
  if (n.source?.conversationId) out.conversationId = n.source.conversationId;
  if (n.source?.peerName) out.peerName = n.source.peerName;
  return out;
}

export function openNotifications(ctx: ApiContext): MobileNotification[] {
  const snap = ctx.deps.notifications?.snapshot();
  if (!snap) return [];
  return snap.notifications.filter((n) => !n.dismissedAt).map(toMobileNotification);
}

function summaryOf(ctx: ApiContext, c: Conversation, dirs: ReturnType<ApiContext['deps']['store']['getDirectories']>, rows: ReturnType<ApiContext['deps']['liveRows']>): ConversationSummary {
  const job = c.daemonShort ? ctx.deps.readJobState(c.daemonShort, c.host) : null;
  const mtime = c.daemonShort ? ctx.deps.jobStateMtimeMs(c.daemonShort, c.host) : 0;
  return toSummary(c, dirs, findLiveRow(c, rows), job, mtime);
}

/** Every conversation as the phone sees it, in sidebar order (pinned first). */
export function summarise(ctx: ApiContext): ConversationSummary[] {
  const dirs = ctx.deps.store.getDirectories();
  const rows = ctx.deps.liveRows();
  const list = ctx.deps.store.getConversations().map((c) => summaryOf(ctx, c, dirs, rows));
  return orderSummaries(list, ctx.deps.store.getPinnedOrder(), nowMs(ctx));
}

/** The desktop's pinned list for the phone (see pinned.ts). */
export function pinnedOf(ctx: ApiContext): PinnedListResponse {
  const dirs = ctx.deps.store.getDirectories();
  const rows = ctx.deps.liveRows();
  return buildPinnedList({
    convs: ctx.deps.store.getConversations(),
    dividers: ctx.deps.store.getDividers?.() ?? [],
    todos: ctx.deps.store.getTodos?.() ?? [],
    order: ctx.deps.store.getPinnedOrder(),
    dirs,
    summarise: (c) => summaryOf(ctx, c, dirs, rows),
  });
}

/** One conversation plus its live job slice; null when the id is unknown. */
export function detailOf(ctx: ApiContext, id: string): ConversationDetail | null {
  const conv = ctx.deps.store.getConversation(id);
  if (!conv) return null;
  const summary = summaryOf(ctx, conv, ctx.deps.store.getDirectories(), ctx.deps.liveRows());
  let job: ConversationDetail['job'] = null;
  if (conv.daemonShort) {
    if (conv.host) {
      const state = ctx.deps.readJobState(conv.daemonShort, conv.host);
      job = state ? sliceFromJobState(state, []) : null;
    } else {
      job = readJobSlice(ctx.deps.jobsRoot, conv.daemonShort);
    }
  }
  return { summary, job };
}

function mapCodex(snap: CodexSnapshot): MessagesPage {
  const entries: MessageEntry[] = [];
  snap.entries.forEach((e, i) => {
    if ((e.role === 'user' || e.role === 'assistant') && typeof e.text === 'string' && e.text) {
      entries.push({ id: `codex:${i}`, kind: e.role === 'user' ? 'user.text' : 'assistant.text', at: '', text: e.text });
    }
  });
  // No byte offsets for Codex: the page is the whole snapshot, never paged.
  return { entries, hasMore: false, cursor: 0, end: entries.length };
}

function fileSize(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

// ---- routes ----

export function registerRoutes(ctx: ApiContext): void {
  const { server, deps } = ctx;
  const log = deps.log;

  server.addRoute('GET', '/ping', 'none', () => ({ ok: true, name: 'peersflow-mobile', v: MOBILE_API_VERSION }));

  server.addRoute('POST', '/pair', 'pair', (r) => {
    const b = bodyOf(r);
    const code = reqStr(b.code, 'code', 6, 12);
    const deviceName = reqStr(b.deviceName ?? '', 'deviceName', 0, 60);
    const redeemed = ctx.auth.redeemPairingCode(code, deviceName, r.ip);
    if (!redeemed) {
      log('pair', { ok: false, ip: r.ip });
      throw new HttpError(404, 'not_found', 'pairing code is wrong or expired');
    }
    const key = ctx.sttKey();
    const out: PairResponse = {
      token: redeemed.token,
      deviceId: redeemed.device.id,
      scopes: [...redeemed.device.scopes],
      sttProvider: key ? 'openai' : null,
      serverName: os.hostname(),
    };
    if (key) out.sttKey = key;
    log('pair', { deviceId: redeemed.device.id, ok: true });
    return out;
  });

  server.addRoute('POST', '/dev/pair-code', 'dev', () => ctx.auth.createPairingCode(ctx.pairUrl(), ctx.fingerprint()));

  server.addRoute('GET', '/me', 'view', (r) => {
    if (!r.device) throw new HttpError(401, 'unauthorized', 'no device');
    const lisa = deps.store.getDirectories().find((d) => d.displayName.toLowerCase() === 'lisa');
    return { device: deviceInfo(r.device), server: ctx.health(), voicePeerId: lisa ? lisa.id : null };
  });

  server.addRoute('GET', '/health', 'view', () => ctx.health());

  server.addRoute('GET', '/peers', 'view', () => {
    const peers: PeerSummary[] = deps.store.getDirectories().map((d) => ({ id: d.id, name: d.displayName, path: d.path, remote: !!d.remote }));
    return { peers };
  });

  server.addRoute('GET', '/conversations', 'view', (r) => ({
    summaries: filterSummaries(summarise(ctx), r.query.get('filter'), r.query.get('peer')),
  }));

  server.addRoute('GET', '/conversations/:id', 'view', (r) => {
    const d = detailOf(ctx, r.params.id);
    if (!d) throw new HttpError(404, 'not_found', 'no such conversation');
    return d;
  });

  server.addRoute('GET', '/conversations/:id/messages', 'view', async (r) => {
    const conv = needConv(ctx, r.params.id);
    if (isCodex(conv)) {
      if (!deps.codexSnapshot) return emptyPage();
      try { return mapCodex(await deps.codexSnapshot(conv.id)); } catch { return emptyPage(); }
    }
    if (!conv.sessionId) return emptyPage();
    const file = deps.findTranscript(cwdOf(conv), conv.sessionId);
    if (!file) return emptyPage();
    const before = Number(r.query.get('before')) || undefined;
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(r.query.get('limit')) || DEFAULT_PAGE)));
    return readMessagesPage(file, { before, limit });
  });

  // Exactly-once for writes. A headless send takes 7–11 s (attach, type,
  // verify), longer than a phone's HTTP timeout, and the Mac app can die in the
  // middle of it. So a write is claimed BEFORE it starts: an in-memory promise
  // that a concurrent retry awaits, and a persisted `pending` marker that a
  // retry after a restart resolves by looking at what actually landed (the
  // transcript for a reply, the store for a spawn) instead of sending again.
  const inflight = new Map<string, Promise<unknown>>();
  const claim = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const p = run();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  };

  // reply + answer share one send path; only the idempotency key and log verb differ.
  const send = async (r: RouteCtx, verb: 'reply' | 'answer'): Promise<ReplyResponse> => {
    const b = bodyOf(r);
    const text = reqStr(b.text, 'text', 1, MAX_TEXT);
    const clientId = reqStr(b.clientId, 'clientId', 1, MAX_CLIENT_ID);
    const key = `${verb}:${clientId}`;
    const running = inflight.get(key) as Promise<ReplyResponse> | undefined;
    if (running) { const res = await running; return { ...res, duplicate: true }; }
    const cached = ctx.idem.get(key) as (ReplyResponse & { pending?: boolean; file?: string; from?: number }) | undefined;
    if (cached && !cached.pending) return { ...cached, duplicate: true };
    if (cached?.pending && cached.file && typeof cached.from === 'number' && hasUserTextAfter(cached.file, cached.from, text)) {
      const landed: ReplyResponse = { ok: true, via: 'headless' };
      ctx.idem.set(key, landed);
      log(verb, { deviceId: r.device?.id, conversationId: r.params.id, ok: true, recovered: true });
      return { ...landed, duplicate: true };
    }
    return claim(key, () => sendOnce(r, verb, b, text, key, cached?.pending ? cached : undefined));
  };
  const sendOnce = async (r: RouteCtx, verb: 'reply' | 'answer', b: Record<string, unknown>, text: string, key: string,
    prior?: { file?: string; from?: number }): Promise<ReplyResponse> => {
    const conv = needConv(ctx, r.params.id);
    const logBase = { deviceId: r.device?.id, conversationId: conv.id, ...(verb === 'answer' ? { questionId: typeof b.questionId === 'string' ? b.questionId : undefined } : {}) };
    if (isCodex(conv)) throw new HttpError(503, 'unavailable', 'Codex chats are read-only on the phone for now');
    if (!conv.sessionId || (!conv.daemonShort && !findLiveRow(conv, deps.liveRows()))) {
      log(verb, { ...logBase, ok: false, error: 'not running' });
      throw new HttpError(409, 'conflict', 'the chat is not running');
    }
    const file = deps.findTranscript(cwdOf(conv), conv.sessionId);
    // A retry of a send whose outcome was lost keeps the ORIGINAL offset, so a
    // copy that landed late is still seen by verify.
    const from = prior?.file === file && typeof prior?.from === 'number' ? prior.from : (file ? fileSize(file) : 0);
    ctx.idem.set(key, { pending: true, file: file ?? undefined, from });
    ctx.idem.flushSync();
    const res = await deps.sendToSession({
      sessionId: conv.sessionId,
      attachId: conv.daemonShort,
      text,
      verify: file ? () => hasUserTextAfter(file, from, text) : undefined,
    });
    if (res.ok) ctx.noteSent(conv.id, text, sourceOf(b.source, 'phone'));
    const result: ReplyResponse = res.ok ? { ok: true, via: res.via } : { ok: false, error: res.error };
    if (res.ok) ctx.idem.set(key, result);
    else if (!(file && hasUserTextAfter(file, from, text))) ctx.idem.set(key, { pending: true, file: file ?? undefined, from });   // stays retryable, offset kept
    log(verb, { ...logBase, ok: res.ok, via: res.ok ? res.via : undefined });
    return result;
  };
  server.addRoute('POST', '/conversations/:id/reply', 'talk', (r) => send(r, 'reply'));
  server.addRoute('POST', '/conversations/:id/answer', 'talk', (r) => send(r, 'answer'));

  server.addRoute('POST', '/conversations/:id/stop', 'talk', async (r) => {
    const conv = needConv(ctx, r.params.id);
    if (isCodex(conv)) throw new HttpError(503, 'unavailable', 'Codex chats are read-only on the phone for now');
    if (!conv.daemonShort) throw new HttpError(409, 'conflict', 'the chat is not running');
    await deps.stopAgent(conv.daemonShort, conv.host);
    log('stop', { deviceId: r.device?.id, conversationId: conv.id, ok: true });
    return { ok: true };
  });

  const pin = (verb: 'done' | 'reopen', pinned: boolean) => (r: RouteCtx) => {
    const conv = needConv(ctx, r.params.id);
    deps.setPinned(conv.id, pinned);
    log(verb, { deviceId: r.device?.id, conversationId: conv.id, ok: true });
    return { ok: true };
  };
  server.addRoute('POST', '/conversations/:id/done', 'talk', pin('done', false));
  server.addRoute('POST', '/conversations/:id/reopen', 'talk', pin('reopen', true));

  server.addRoute('POST', '/conversations', 'talk', async (r) => {
    const b = bodyOf(r);
    const peerId = reqStr(b.peerId, 'peerId', 1, 200);
    const prompt = reqStr(b.prompt, 'prompt', 1, MAX_TEXT);
    if (b.kind !== 'chat' && b.kind !== 'voice') throw new HttpError(400, 'bad_request', 'kind must be chat or voice');
    const kind = b.kind;
    const clientId = reqStr(b.clientId, 'clientId', 1, MAX_CLIENT_ID);
    const model = optStr(b.model, 'model', 100);
    const contract = contractOf(b.contract);
    const spokenAt = optStr(b.spokenAt, 'spokenAt', 64);
    const key = `spawn:${clientId}`;
    const running = inflight.get(key) as Promise<SpawnConversationResponse> | undefined;
    if (running) { const res = await running; return { ...res, duplicate: true }; }
    const cached = ctx.idem.get(key) as (SpawnConversationResponse & { pending?: boolean; at?: number; title?: string }) | undefined;
    if (cached && !cached.pending) return { ...cached, duplicate: true };
    if (cached?.pending) {
      // The app died between claiming and answering: the chat may exist already.
      const since = (cached.at ?? 0) - 5_000;
      const found = deps.store.getConversations().find((c) => c.directoryId === peerId && Date.parse(c.createdAt) >= since
        && (c.title === cached.title || (c.lastPrompt ?? '').includes(prompt.trim())));
      if (found) {
        const out: SpawnConversationResponse = { conversationId: found.id };
        ctx.idem.set(key, out);
        log('spawn', { deviceId: r.device?.id, conversationId: found.id, ok: true, recovered: true });
        return { ...out, duplicate: true };
      }
    }
    return claim(key, () => spawnOnce(r, b, { peerId, prompt, kind, model, contract, spokenAt, key }));
  });
  const spawnOnce = async (r: RouteCtx, b: Record<string, unknown>, a: { peerId: string; prompt: string; kind: 'chat' | 'voice'; model?: string; contract?: RunContract; spokenAt?: string; key: string }): Promise<SpawnConversationResponse> => {
    const { peerId, prompt, kind, model, contract, spokenAt, key } = a;
    const dir = deps.store.getDirectories().find((d) => d.id === peerId);
    if (!dir) throw new HttpError(404, 'not_found', 'no such peer');

    let req: { prompt: string; title?: string; chatKind: ChatKind; contract?: RunContract };
    if (kind === 'voice') {
      const spoken = prompt.trim();
      const at = spokenAt ?? new Date(nowMs(ctx)).toISOString();
      req = {
        // The /voice-task skill lives in the LISA peer. A peer without it would
        // answer "Unknown command" and dead-end, so it gets the contract inline.
        prompt: hasVoiceTaskSkill(dir.path, deps.env)
          ? `/voice-task ${spoken}\n\nspokenAt: ${at}`
          : `${VOICE_TASK_INLINE}\n\nTask (spoken on the phone at ${at}): ${spoken}`,
        title: spoken.slice(0, 80),
        chatKind: 'voice',
        contract: contract ?? 'until-done',
      };
    } else {
      req = { prompt, chatKind: 'chat', contract };
    }
    ctx.idem.set(key, { pending: true, at: nowMs(ctx), title: (req.title ?? prompt).trim().slice(0, 80) });
    ctx.idem.flushSync();
    let spawned: { conversationId: string };
    try {
      spawned = await deps.spawn({ dir, prompt: req.prompt, title: req.title, chatKind: req.chatKind, model, contract: req.contract });
    } catch (e) {
      log('spawn', { deviceId: r.device?.id, peerId, ok: false, error: e instanceof Error ? e.message : String(e) });
      ctx.idem.set(key, undefined as unknown as SpawnConversationResponse);   // a failed spawn stays retryable
      throw new HttpError(503, 'unavailable', e instanceof Error ? e.message : String(e));
    }
    const out: SpawnConversationResponse = { conversationId: spawned.conversationId };
    ctx.idem.set(key, out);
    ctx.noteSent(spawned.conversationId, req.prompt, kind === 'voice' ? 'voice' : sourceOf(b.source, 'phone'));
    log('spawn', { deviceId: r.device?.id, conversationId: spawned.conversationId, kind, ok: true });
    return out;
  };

  server.addRoute('GET', '/outcomes', 'view', (r) => {
    const items: FeedItem[] = ctx.feed.after(Number(r.query.get('after')) || 0);
    return { items };
  });

  server.addRoute('GET', '/notifications', 'view', () => ({ notifications: openNotifications(ctx) }));

  server.addRoute('POST', '/notifications/:id/dismiss', 'talk', (r) => {
    deps.notifications?.dismiss(r.params.id);
    log('dismiss', { deviceId: r.device?.id, notificationId: r.params.id, ok: !!deps.notifications });
    return { ok: true };
  });

  // The desktop's pinned list in its exact order (separators, to-dos, sub-chats) + History.
  server.addRoute('GET', '/pinned', 'view', () => pinnedOf(ctx));

  // The speech-to-text key for a phone paired before the key was set (pairing hands it out too).
  server.addRoute('GET', '/voice-key', 'talk', () => ({ sttKey: ctx.sttKey() ?? null }));

  server.addRoute('GET', '/vocabulary', 'view', () =>
    buildVocabulary(deps.store.getDirectories(), ctx.devices.settings().vocabulary, new Date(nowMs(ctx)).toISOString()));
}


// ---- voice tasks on a peer without the /voice-task skill ----
export function hasVoiceTaskSkill(peerPath: string, env: NodeJS.ProcessEnv): boolean {
  const home = env.HOME || os.homedir();
  return [pathMod.join(peerPath, '.claude', 'skills', 'voice-task', 'SKILL.md'), pathMod.join(home, '.claude', 'skills', 'voice-task', 'SKILL.md')]
    .some((p) => { try { return fsMod.statSync(p).isFile(); } catch { return false; } });
}
export const VOICE_TASK_INLINE = [
  'This task was spoken on the user\'s phone (Peers Flow voice). Work on it end to end without chit-chat:',
  '1. Restate the request in one sentence in the user\'s language.',
  '2. Plan, delegate to the peer that owns the capability when needed, verify the results.',
  '3. If only the user can decide, write the question with lettered options, call the peersflow notify tool (level "action"), and end your turn.',
  '4. Finish with the full write-up, then on its own lines <spoken>…</spoken> (at most 3 sentences, the user\'s language, no paths or URLs) and, only if something is left for the user, <needs>…</needs>.',
].join('\n');
