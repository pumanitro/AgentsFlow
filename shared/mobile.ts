// Wire contract between the Peers Flow mobile gateway and the Android app. v1.
import type { ChatKind, RunContract } from './types';

export const MOBILE_API_VERSION = 1;
export const MOBILE_DEFAULT_PORT = 47820;
export const MOBILE_API_PREFIX = '/api/v1';
export const MOBILE_PAIR_SCHEME = 'peersflow://pair';          // peersflow://pair?url=<base>&code=<code>&fp=<hex|''>
export const MOBILE_OWNER_HEADER = 'tailscale-user-login';      // lower-case, as node exposes it

export type MobileScope = 'view' | 'talk' | 'admin';
export type MobileConvState = 'starting' | 'working' | 'blocked' | 'done' | 'failed' | 'idle';
export type MessageSource = 'desktop' | 'phone' | 'voice';
export type MobileProvider = 'claude' | 'codex';

export interface PeerSummary { id: string; name: string; path: string; remote: boolean }

export interface ConversationSummary {
  id: string; peerId: string; peerName: string; title: string;
  detail: string;                 // live one-liner (job detail / question / 'completed')
  state: MobileConvState; rawState: string; needsYou: boolean;
  pinned: boolean; provider: MobileProvider; chatKind: ChatKind;
  createdAt: string; unpinnedAt?: string; updatedAt: string;
  delegatedBy?: string; hasSession: boolean; host?: string;
}

export interface NeedsYouQuestion { id: string; question: string; options: { label: string; description?: string }[] }
export interface JobSlice {
  state: MobileConvState; rawState: string; detail: string; tempo?: string;
  needs?: string; suggestedReply?: string; questions: NeedsYouQuestion[];
  inFlight: { tasks: number; queued: number; kinds: string[] };
  updatedAt?: string;
  timeline: { at: string; state: string; detail: string }[];   // newest last, ≤ 20
}
export interface ConversationDetail { summary: ConversationSummary; job: JobSlice | null }

export type MessageKind = 'user.text' | 'assistant.text' | 'tool_use' | 'tool_result' | 'thinking' | 'subagent';
export interface MessageEntry {
  id: string;                     // `${entry.uuid}:${partIndex}`
  kind: MessageKind; at: string;  // ISO timestamp of the entry ('' when absent)
  text: string;                   // tool_use: one-line summary e.g. "Bash: npm test"; tool_result: first 2 KB
  toolName?: string; toolUseId?: string; truncated?: boolean; source?: MessageSource; sidechain?: boolean;
}
export interface MessagesPage { entries: MessageEntry[]; hasMore: boolean; cursor: number; end: number }
// cursor = byte offset of the oldest entry returned (pass as ?before=); end = byte offset after the last complete line.

export interface OutcomeItem  { seq: number; kind: 'outcome';   conversationId: string; title: string; peerName: string; at: string; spoken: string; needs?: string; messageId: string }
export interface NeedsYouItem { seq: number; kind: 'needs-you'; conversationId: string; title: string; peerName: string; at: string; questions: NeedsYouQuestion[]; needs?: string; suggestedReply?: string }
export type FeedItem = OutcomeItem | NeedsYouItem;

export interface ServerHealth {
  ok: true; hostname: string; appVersion: string; cliVersion: string; uptimeSec: number; now: string;
  devMode: boolean; paused: boolean; load1: number | null;
  lastOutage: { from: string; to: string; clean: boolean } | null;
}
export interface DeviceInfo { id: string; name: string; scopes: MobileScope[]; createdAt: string; lastSeenAt: string }
export interface MeResponse { device: DeviceInfo; server: ServerHealth; voicePeerId: string | null }

export interface PairRequest  { code: string; deviceName: string }
export interface PairResponse { token: string; deviceId: string; scopes: MobileScope[]; sttProvider: 'openai' | null; sttKey?: string; serverName: string }
export interface PairingOffer {
  code: string; url: string; expiresAt: string;
  qr: string;                     // the peersflow://pair?… string the QR encodes
  fingerprint: string;            // '' until TLS exists
  qrDataUrl?: string;             // desktop IPC only: PNG data URL rendered by main for the sidebar
}

export interface ReplyRequest  { text: string; source: MessageSource; clientId: string }
export interface AnswerRequest { questionId?: string; text: string; source?: MessageSource; clientId: string }
export interface ReplyResponse { ok: boolean; via?: 'open-chat' | 'headless'; error?: string; duplicate?: boolean }
export interface SpawnConversationRequest {
  peerId: string; prompt: string; kind: 'chat' | 'voice'; model?: string; contract?: RunContract;
  clientId: string; spokenAt?: string; source?: MessageSource;
}
export interface SpawnConversationResponse { conversationId: string; duplicate?: boolean }
export interface VocabularyResponse { words: string[]; updatedAt: string }
export interface MobileNotification { id: string; level: 'warn' | 'action'; title: string; body?: string; createdAt: string; conversationId?: string; peerName?: string }

export type ApiErrorCode = 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'paused' | 'unavailable';
export interface ApiError { error: string; code: ApiErrorCode }
// HTTP: 400 bad_request · 401 unauthorized · 403 forbidden · 404 not_found · 409 conflict · 429 rate_limited · 503 paused|unavailable

// ---- /api/v1/events (WebSocket) ----
export type ClientMessage =
  | { type: 'hello'; lastSeq: number; subscribe?: string[] }
  | { type: 'subscribe'; ids: string[] }
  | { type: 'unsubscribe'; ids: string[] }
  | { type: 'ping' };
export type ServerEvent =
  | { type: 'welcome'; seq: number; health: ServerHealth; serverTime: string }
  | { type: 'conversations.updated'; summaries: ConversationSummary[] }
  | { type: 'conversation.updated'; summary: ConversationSummary }
  | { type: 'conversation.detail'; detail: ConversationDetail }              // subscribed ids only, on change
  | { type: 'messages.appended'; conversationId: string; entries: MessageEntry[]; end: number }
  | { type: 'feed'; item: FeedItem }                                         // outcomes + needs-you, also replayed after hello
  | { type: 'notification.added'; notification: MobileNotification }
  | { type: 'server.health'; health: ServerHealth }
  | { type: 'pong'; serverTime: string }
  | { type: 'pinned.updated' }                                               // refetch GET /pinned
  | { type: 'error'; message: string };
// Order after a hello: welcome → feed items with seq > lastSeq (oldest first) → conversations.updated.

// ---- desktop IPC (renderer ⇄ main) ----
export const MOBILE_IPC = {
  status: 'mobile:status', startPairing: 'mobile:startPairing', cancelPairing: 'mobile:cancelPairing',
  revoke: 'mobile:revoke', revokeAll: 'mobile:revokeAll', setPaused: 'mobile:setPaused',
  setScopes: 'mobile:setScopes', updateSettings: 'mobile:updateSettings', updated: 'mobile:updated',
} as const;
export interface MobileDeviceRow extends DeviceInfo { connected: boolean; cursor: number; lastIp?: string }
export interface MobileSettings { ownerLogin: string; sttKeySet: boolean; vocabulary: string[]; httpsPort: number; publicUrl?: string }
export interface TailnetInfo { available: boolean; dnsName?: string; ownerLogin?: string; serveOn: boolean; url?: string; error?: string }
export interface MobileStatus {
  running: boolean; port: number; devMode: boolean; paused: boolean; connectedSockets: number;
  devices: MobileDeviceRow[]; settings: MobileSettings; tailnet: TailnetInfo; pairing: PairingOffer | null; lastError?: string;
}
export interface MobileApi {
  status: () => Promise<MobileStatus>;
  startPairing: () => Promise<PairingOffer>;
  cancelPairing: () => Promise<void>;
  revokeDevice: (id: string) => Promise<void>;
  revokeAll: () => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
  setDeviceScopes: (id: string, scopes: MobileScope[]) => Promise<void>;
  updateSettings: (patch: Partial<Omit<MobileSettings, 'sttKeySet'>> & { sttKey?: string }) => Promise<MobileSettings>;
  onUpdated: (cb: (s: MobileStatus) => void) => () => void;
}

// ---- pinned list (GET /api/v1/pinned) — the desktop "PINNED CONVERSATIONS" list, in its order ----
export interface PinnedTodoItem { id: string; text: string; done: boolean }
export type PinnedListItem =
  | { kind: 'divider'; id: string; title: string }
  | { kind: 'conversation'; summary: ConversationSummary; todos: PinnedTodoItem[]; children: ConversationSummary[] }
  | { kind: 'todo'; id: string; text: string; done: boolean; peerName: string };
export interface PinnedListResponse { items: PinnedListItem[]; history: ConversationSummary[] }
