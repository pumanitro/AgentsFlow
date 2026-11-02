import type { EventEmitter } from 'node:events';
import type { ChatKind, Conversation, PinnedDivider, PinnedItemRef, PinnedTodo, RunContract, TrackedDirectory } from '../../shared/types';
import type { NotificationsSnapshot } from '../../shared/notifications';
import type { CodexSnapshot } from '../../shared/codex';
import type { ClaudeAgentJsonRow, JobState } from '../claude-cli';
import type { ApiErrorCode, FeedItem, MessageEntry, MessageSource, MobileApi, MobileScope, MobileSettings, MobileStatus, PairingOffer, ServerHealth } from '../../shared/mobile';

export type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
export type LogFn = (msg: string, data?: Record<string, unknown>) => void;
export type SendResult = { ok: true; via: 'open-chat' | 'headless' } | { ok: false; error: string };

/** Everything the gateway needs from the app, injected by main.ts; fakes in tests. */
export interface GatewayDeps {
  userDataDir: string;              // mobile-devices.json, mobile-feed.json, mobile-heartbeat.json, mobile-idempotency.json live here
  projectsRoot: string;             // ~/.claude/projects
  jobsRoot: string;                 // ~/.claude/jobs
  port: number;                     // PEERSFLOW_MOBILE_PORT ?? 47820
  devMode: boolean;                 // PEERSFLOW_MOBILE_DEV === '1'
  appVersion: string;
  env: NodeJS.ProcessEnv;
  store: {
    getDirectories(): TrackedDirectory[];
    getConversations(): Conversation[];
    getConversation(id: string): Conversation | null;
    getPinnedOrder(): PinnedItemRef[];
    getDividers?(): PinnedDivider[];   // optional: older wiring / tests without them get an empty list
    getTodos?(): PinnedTodo[];
  };
  liveRows(): ClaudeAgentJsonRow[];                                   // poller.getLastAgentRows
  readJobState(daemonShort: string, host?: string): JobState | null;  // claude-cli.readJobState (remote-aware)
  jobStateMtimeMs(daemonShort: string, host?: string): number;
  findTranscript(cwd: string, sessionId: string): string | null;      // transcript-path.findTranscript(projectsRoot, …)
  sendToSession(opts: { sessionId: string; attachId: string; text: string; verify?: () => boolean }): Promise<SendResult>;
  stopAgent(daemonShort: string, host?: string): Promise<void>;
  setPinned(id: string, pinned: boolean): void;                       // persists AND broadcasts to the renderer
  spawn(req: { dir: TrackedDirectory; prompt: string; title?: string; chatKind: ChatKind; model?: string; contract?: RunContract }):
    Promise<{ conversationId: string; sessionId: string; daemonShort: string }>;
  notifications: { snapshot(): NotificationsSnapshot; dismiss(id: string): void } | null;
  codexSnapshot?: (id: string) => Promise<CodexSnapshot>;
  bus: EventEmitter;                // emits 'conversations.changed' | 'notifications.changed' (see bus.ts)
  exec: ExecFn;                     // child_process wrapper (claude --version, tailscale …)
  log: LogFn;
  now?: () => number;
}

export interface MobileGateway {
  port: number;
  status(): MobileStatus;
  startPairing(): PairingOffer;
  cancelPairing(): void;
  revokeDevice(id: string): void;
  revokeAll(): void;
  setPaused(paused: boolean): void;
  setDeviceScopes(id: string, scopes: MobileScope[]): void;
  updateSettings(patch: Parameters<MobileApi['updateSettings']>[0]): MobileSettings;
  onStatus(cb: (s: MobileStatus) => void): () => void;
  stop(): Promise<void>;
}
export type StartMobileGateway = (deps: GatewayDeps) => Promise<MobileGateway>;

// ---- internal seams (one owner each; others build against these) ----
export interface DeviceRecord { id: string; name: string; tokenHash: string; scopes: MobileScope[]; createdAt: string; lastSeenAt: string; lastIp?: string; cursor: number; revokedAt?: string }
export interface DeviceFileSettings { ownerLogin: string; sttKey: string; vocabulary: string[]; paused: boolean; httpsPort: number; publicUrl: string }   // publicUrl: the https address the phone uses (tunnel); '' = derive
export interface DeviceStore {
  list(): DeviceRecord[]; get(id: string): DeviceRecord | null; findByTokenHash(h: string): DeviceRecord | null;
  add(rec: DeviceRecord): void; touch(id: string, ip: string, nowIso: string): void; setCursor(id: string, seq: number): void;
  setScopes(id: string, scopes: MobileScope[]): void; revoke(id: string): void; revokeAll(): void;
  settings(): DeviceFileSettings; updateSettings(patch: Partial<DeviceFileSettings>): DeviceFileSettings; flushSync(): void;
}
export type AuthOutcome = { ok: true; device: DeviceRecord } | { ok: false; status: 401 | 403 | 429; code: 'unauthorized' | 'forbidden' | 'rate_limited'; error: string };
export interface AuthService {
  authenticate(headers: Record<string, string | string[] | undefined>, ip: string): AuthOutcome;   // owner header (non-dev) + bearer
  ownerOk(headers: Record<string, string | string[] | undefined>): boolean;
  createPairingCode(url: string, fingerprint: string): PairingOffer;                               // 2-minute TTL, one active at a time
  currentOffer(): PairingOffer | null; cancelPairing(): void;
  redeemPairingCode(code: string, deviceName: string, ip: string): { token: string; device: DeviceRecord } | null;
  allow(key: string, limit: number, windowMs: number): boolean;                                    // sliding-window rate limit
}
export interface RouteCtx { device: DeviceRecord | null; params: Record<string, string>; query: URLSearchParams; body: unknown; ip: string; devMode: boolean; headers: Record<string, string | string[] | undefined> }
export type RouteHandler = (ctx: RouteCtx) => Promise<unknown> | unknown;   // return ⇒ 200 JSON; throw HttpError otherwise
export type RouteScope = MobileScope | 'pair' | 'dev' | 'none';
export interface GatewayServer {
  addRoute(method: 'GET' | 'POST' | 'DELETE', pattern: string, scope: RouteScope, handler: RouteHandler): void;  // pattern like '/conversations/:id/reply' (prefix added by the server)
  onEvents(handler: (ws: import('ws').WebSocket, ctx: RouteCtx) => void): void;                                   // authenticated upgrade of /api/v1/events
  listen(): Promise<number>; close(): Promise<void>; connections(): number;
}
export interface IdempotencyCache { get(clientId: string): unknown | undefined; set(clientId: string, result: unknown): void; flushSync(): void }
export interface FeedStore { append(item: Omit<FeedItem, 'seq'>): FeedItem; after(seq: number): FeedItem[]; latestSeq(): number; flushSync(): void }
export interface Tailer {
  subscribe(convId: string, file: string, fromEnd: number, onAppend: (entries: MessageEntry[], end: number) => void): void;
  unsubscribe(convId: string): void; stop(): void;
}
export interface Heartbeat { start(): void; stop(): void; lastOutage(): ServerHealth['lastOutage']; startedAt: number }
export interface ApiContext {
  deps: GatewayDeps; server: GatewayServer; auth: AuthService; devices: DeviceStore; idem: IdempotencyCache; feed: FeedStore;
  tailer: Tailer; heartbeat: Heartbeat; cliVersion: () => string; health: () => ServerHealth;
  pairUrl: () => string; fingerprint: () => string; sttKey: () => string | null;
  noteSent: (conversationId: string, text: string, source: MessageSource) => void;   // lets the tailer tag the next matching user entry with its source
}
