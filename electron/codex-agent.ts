import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CodexAccountReader } from './codex-account';
import { agentEnvironment } from './cli-environment';
import type { CodexModel, Conversation } from '../shared/types';
import type { CodexEntry, CodexReply, CodexRequest, CodexSnapshot } from '../shared/codex';
import { CodexRpc, WireObject } from './codex-protocol';
import { codexHistoryText } from './handover';

/** How the app-server words "you are out of quota", in any of its shapes. */
const LIMIT_MESSAGE = /rate.?limit|usage limit|quota|too many requests|429/i;

const MODEL_CACHE_MS = 10 * 60_000;

// Shown on every open conversation after the Codex login underneath them was
// replaced: the thread survives (its id is on the row), the connection did not.
export const CODEX_SWITCHED = 'Codex account switched — reopen to continue';

const HANDOVER_NOTE = 'Forked from Claude Code — that conversation was passed to Codex as context.';

/**
 * Spawn defaults for a thread this app starts. Codex parks a turn forever at
 * `waitingOnApproval` while nobody is connected, so an unattended run must not
 * be able to ask — the same reason Claude conversations here run `--bg` in
 * bypass mode. The sandbox is what keeps that safe. `deps.options(conv)`
 * overrides both, so an attended conversation can still ask for approvals.
 */
export const CODEX_DEFAULT_APPROVAL_POLICY = 'never';
export const CODEX_DEFAULT_SANDBOX = 'workspace-write';

/**
 * `thread/resume` fails with `no rollout found` until the thread's first turn
 * has written its rollout file, so a thread published between `thread/start`
 * and its first turn cannot be rejoined yet. Mutable so tests need not wait.
 */
export const RESUME_RETRY = { attempts: 5, delayMs: 2_000 };

/** The app-server's own words for a thread that was never given a turn. */
const NO_ROLLOUT = /no rollout found/i;

/**
 * How `thread/turns/list` refuses a thread that exists but has never been given
 * a first user message: `thread <id> is not materialized yet; thread/turns/list
 * is unavailable before first user message`. It is an answer — "no turns" — not
 * a failure to answer.
 */
const NOT_MATERIALIZED = /not materialized yet/i;

/**
 * How the app-server refuses a method it does not have. It answers -32600 with
 * `unknown variant \`thread/queue/add\``, not -32601, and `CodexRpc` keeps only
 * the message — so this is matched on text, and covers the capability gate too.
 */
const METHOD_ABSENT = /unknown (variant|method)|method not found|unsupported|experimentalApi/i;

/** Row states the server can still move on its own — nothing to rejoin past these. */
export const SETTLED_STATES = new Set(['done', 'error', 'stopped']);
/** Row states that mean "a turn was in flight when we last looked". */
const LIVE_STATES = new Set(['working', 'starting', 'active', 'needs-input', 'blocked']);
/**
 * The subset of those that can only come from a turn the server is running
 * right now — unlike `starting`, which this app writes onto a row before the
 * thread even exists. Nothing inconclusive may paint over these.
 */
const TURN_IN_FLIGHT = new Set(['working', 'active', 'needs-input', 'blocked']);

const NEEDS_INPUT = 'Codex needs your input';

export type CodexThreadState = 'working' | 'blocked' | 'idle' | 'done' | 'error' | 'stopped';

export interface ThreadStatusContext {
  /** The row's state as stored, consulted when the server's answer is not conclusive. */
  stored?: string;
  /** `thread/turns/list` limit 1, newest first — only read when it can change the answer. */
  lastTurnStatus?: string;
  lastTurnError?: string;
  /**
   * False when the thread is known to have run nothing yet — an empty
   * `thread/turns/list`, or its refusal to answer at all for a thread that has
   * not been materialized by a first user message. Undefined means "not asked
   * / could not tell", which is not the same thing and must not be read as
   * "finished". See the `idle` branch of `mapThreadStatus`.
   */
  hasTurns?: boolean;
}

/**
 * One thread status (`active` / `idle` / `systemError` / `notLoaded`, with
 * `activeFlags`) in the row states this app paints. `null` means "the server
 * did not say anything conclusive — keep what is stored".
 */
export function mapThreadStatus(status: WireObject | undefined | null, ctx: ThreadStatusContext = {}): { state: CodexThreadState; detail?: string } | null {
  const type = status?.type;
  if (!type || type === 'notLoaded') return null;
  if (type === 'systemError') return { state: 'error', detail: status!.message || status!.error?.message || status!.detail || 'Codex reported an error' };
  if (type === 'active') {
    const flags: string[] = Array.isArray(status!.activeFlags) ? status!.activeFlags : [];
    if (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) return { state: 'blocked', detail: NEEDS_INPUT };
    if (flags.includes('usageLimited') || flags.includes('budgetLimited')) return { state: 'blocked', detail: 'Codex is out of quota' };
    if (flags.includes('paused') || flags.includes('blocked')) return { state: 'blocked', detail: 'Codex is paused' };
    return { state: 'working' };
  }
  if (type !== 'idle') return null;
  // Idle only says "no turn is running"; which ending it was is the last turn's.
  if (ctx.lastTurnStatus === 'inProgress') return null; // Racing a turn that is still being recorded.
  if (ctx.lastTurnStatus === 'failed') return { state: 'error', detail: ctx.lastTurnError || 'The last Codex turn failed' };
  if (ctx.lastTurnStatus === 'interrupted') return { state: 'stopped' };
  if (ctx.lastTurnStatus === 'completed') return { state: 'done' };
  // A thread that has run nothing has finished nothing. `thread/start`
  // broadcasts `thread/started` with status idle, and that arrives while the
  // row is still `starting`/`working` from the send that created it — reading
  // it as an ending is what painted a brand-new chat's dot green for the whole
  // of its first turn.
  if (ctx.hasTurns === false) return null;
  if (ctx.stored && SETTLED_STATES.has(ctx.stored)) return null; // Already settled; idle adds nothing.
  if (ctx.stored && LIVE_STATES.has(ctx.stored)) return { state: 'done' }; // It ended while we were away.
  return { state: 'idle' };
}

export function codexEntry(item: WireObject): CodexEntry | null {
  const base = { id: String(item.id), status: item.status as string | undefined };
  if (item.type === 'userMessage') return { ...base, role: 'user', text: (item.content || []).map((c: WireObject) => c.text || c.path || c.url || '').join('\n') };
  if (item.type === 'agentMessage' || item.type === 'plan') return { ...base, role: 'assistant', text: item.text || '' };
  if (item.type === 'commandExecution') return { ...base, role: 'tool', text: `${item.command}\n${(item.aggregatedOutput || '').slice(-16000)}`.trim() };
  if (item.type === 'fileChange') return { ...base, role: 'tool', text: (item.changes || []).map((c: WireObject) => `${c.path}\n${c.diff || ''}`).join('\n').slice(-20000) };
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return { ...base, role: 'tool', text: `${item.server || item.namespace || ''} / ${item.tool}\n${JSON.stringify(item.arguments || {}, null, 2)}${item.error ? '\n' + JSON.stringify(item.error) : ''}`.slice(-16000) };
  if (item.type === 'reasoning') return null; // Do not render hidden reasoning content.
  return { ...base, role: 'tool', text: item.type || 'activity' };
}

export function approvalResult(method: string, params: WireObject, reply: CodexReply): WireObject {
  if (method === 'item/tool/requestUserInput') {
    return { answers: Object.fromEntries((params.questions || []).map((q: WireObject) => [q.id, { answers: reply.accept && reply.answers?.[q.id] ? [reply.answers[q.id]] : [] }])) };
  }
  if (method === 'item/permissions/requestApproval') return { permissions: reply.accept ? params.permissions : {}, scope: 'turn' };
  if (method === 'mcpServer/elicitation/request') return { action: reply.accept ? 'accept' : 'decline', content: reply.accept ? reply.content ?? null : null, _meta: null };
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: reply.accept ? 'accept' : 'decline' };
  throw new Error(`Unsupported Codex request: ${method}`);
}

/**
 * `codex queue`, as a seam. Only reached when the app-server has no
 * `thread/queue/add`; replaced wholesale in tests rather than mocked per call.
 */
export const queueCli = {
  run: (args: string[]): Promise<void> => new Promise((resolve, reject) => {
    execFile(process.env.CODEX_BIN || 'codex', args, { env: agentEnvironment() }, (error, _out, stderr) =>
      error ? reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ''}`)) : resolve());
  }),
};

/**
 * The transport surface this file uses. Written as an interface rather than the
 * class so it compiles against both the stdio `CodexRpc` that ships today and
 * the socket client that replaces it — the members that only the new one has
 * are optional and always called through `?.`.
 */
export interface CodexRpcLike {
  start(): Promise<void>;
  request(method: string, params?: WireObject): Promise<any>;
  reply(id: number | string, result: WireObject): void;
  rejectRequest(id: number | string, message: string): void;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  /** Bounce the app-server so the next connection picks up a new sign-in. */
  restart?(): Promise<void>;
  /** The unix socket the app-server listens on, for `codex queue --remote`. */
  socketPath?(): string;
  isConnected?(): boolean;
}

// The socket client takes `{ userData }`; today's stdio CodexRpc takes nothing.
// Cast so this file compiles before and after that change, with one place to
// delete once the constructor is real.
type CodexRpcConstructor = new (options?: { userData: string }) => CodexRpcLike;
const makeRpc = (userData: string): CodexRpcLike => new (CodexRpc as unknown as CodexRpcConstructor)({ userData });

interface Session {
  snapshot: CodexSnapshot;
  turnId?: string;
  cursor?: string | null;
  rawRequests: Map<string | number, WireObject>;
  busy: boolean;
  turnEntries: Set<string>;
  // Set while this thread was opened for a conversation forked from Claude and
  // still carrying its seed; cleared (on the row too) once Codex has answered.
  pendingHandover?: boolean;
  // Turn ids already reported to `onLimit`, so one refusal is one signal.
  limitedTurns: Set<string>;
}
export interface Dependencies {
  get: (id: string) => Conversation | null;
  update: (id: string, patch: Partial<Conversation>) => void;
  options: (conv: Conversation) => WireObject;
  changed: (snapshot: CodexSnapshot) => void;
  /** Every conversation, so a reconnect can find the Codex rows worth rejoining. */
  list: () => Conversation[];
  /** Where this app keeps its own state; the app-server's socket lives under it. */
  userData: string;
  /**
   * The condensed transcript of the Claude conversation this row was forked
   * from. Merged into the thread's developer instructions rather than the
   * prompt, so the user's own first message stays exactly what they typed.
   */
  handoverContext?: (conv: Conversation) => string | undefined;
  /** Codex refused a turn because the account is out of quota. */
  onLimit?: (id: string, message: string) => void;
  /**
   * A thread changed state underneath the app — on reconnect, or because
   * another client (a terminal attach, the ChatGPT app) drove it. The row has
   * already been updated; this is for anything that watches transitions.
   */
  onThreadStatus?: (conversationId: string, status: CodexThreadState, detail?: string) => void;
}

export class CodexAgents {
  private closing = false;
  private restarting = false;
  private sessions = new Map<string, Session>();
  private threads = new Map<string, string>();
  private loading = new Map<string, Promise<Session>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private models?: { at: number; list: CodexModel[] };
  // Bumped on every deliberate reconnect, so work started against the previous
  // app-server cannot report its own death onto a row that has moved on.
  private generation = 0;
  // One re-sync at a time: two 'connected' events must not resume twice.
  private resyncing?: Promise<void>;
  // Undefined until the first attempt tells us; `initialize` advertises neither
  // a capability list nor a method list, so this can only be learned by asking.
  private serverQueues?: boolean;

  private accountReader: CodexAccountReader;
  accountStatus(force = false) { return this.accountReader.read(force); }

  constructor(private deps: Dependencies, private rpc: CodexRpcLike = makeRpc(deps.userData)) {
    this.accountReader = new CodexAccountReader(rpc);
    rpc.on('notification', (m) => { if (m.method === 'account/updated') this.accountReader.invalidate(); });
    rpc.on('notification', (m) => this.notification(m));
    rpc.on('request', (m) => this.serverRequest(m));
    // Every successful initialize, first connection and reconnects alike. The
    // threads outlived the connection, so this is where the app catches up.
    rpc.on('connected', () => { void this.resync(); });
    rpc.on('disconnected', (error: Error) => {
      this.accountReader.invalidate();
      this.models = undefined;
      if (this.closing) return;
      if (this.restarting) { this.reconnect(); return; }
      for (const [id, s] of this.sessions) {
        s.snapshot.requests = []; s.rawRequests.clear();
        this.state(id, 'error', error.message);
        this.deps.changed(s.snapshot);
      }
      this.sessions.clear(); this.threads.clear(); this.loading.clear();
    });
  }

  /**
   * Drop the app-server connection and every live session without calling any
   * of it a failure. Used after the Codex login file underneath us was
   * replaced: the running server caches its credentials and will not adopt
   * another account's auth.json, so the only way onto the new login is a fresh
   * process. Threads are not lost — each row keeps its thread id, and the
   * reconnect that follows re-syncs them all.
   */
  async restart(): Promise<void> {
    if (this.closing) return;
    this.restarting = true;
    this.accountReader.invalidate();
    this.models = undefined;
    try {
      if (this.rpc.restart) await this.rpc.restart();
      else this.rpc.close();
    } catch { /* nothing was connected */ }
    if (this.restarting) this.reconnect(); // Never connected, so no 'disconnected' arrived.
  }

  private reconnect(): void {
    this.restarting = false;
    // Anything still in flight belongs to the connection we just dropped: it is
    // about to fail, and that failure must not relabel a row we parked as idle.
    this.generation++;
    for (const [id, s] of this.sessions) {
      s.snapshot.requests = []; s.rawRequests.clear();
      s.snapshot.state = 'idle'; s.snapshot.error = undefined;
      s.turnId = undefined; s.busy = false;
      this.deps.update(id, { state: 'idle', status: 'idle', description: CODEX_SWITCHED });
      this.deps.changed(s.snapshot);
    }
    this.sessions.clear(); this.threads.clear(); this.loading.clear();
  }

  /** True while any thread has a turn in flight — a switch would interrupt it. */
  hasRunningTurn(): boolean {
    for (const s of this.sessions.values()) if (s.turnId || s.busy) return true;
    return false;
  }

  /** The models this Codex CLI offers, default first. Never throws: [] on any failure. */
  async listModels(): Promise<CodexModel[]> {
    if (this.models && Date.now() - this.models.at < MODEL_CACHE_MS) return this.models.list;
    try {
      await this.rpc.start();
      const response = await this.rpc.request('model/list', {});
      const list: CodexModel[] = (response?.data || [])
        .filter((m: WireObject) => m && !m.hidden && m.id)
        .map((m: WireObject) => ({
          id: String(m.id),
          displayName: String(m.displayName || m.id),
          isDefault: Boolean(m.isDefault),
          description: typeof m.description === 'string' ? m.description : undefined,
        }));
      list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault)); // Stable: order is otherwise the server's.
      this.models = { at: Date.now(), list };
      return list;
    } catch {
      return [];
    }
  }

  // ---- Rejoin ----------------------------------------------------------

  /** The pinned Codex rows with a thread on the server, in stored order. */
  private rejoinable(): Conversation[] {
    return this.deps.list().filter((c) => c.provider === 'codex' && c.pinned && c.sessionId);
  }

  private conversationFor(threadId: string): string | undefined {
    const known = this.threads.get(threadId);
    if (known) return known;
    return this.deps.list().find((c) => c.provider === 'codex' && c.sessionId === threadId)?.id;
  }

  /**
   * Catch up with threads that kept running without us. `thread/list` repaints
   * every pinned row's dot in one call; each row that is not already settled is
   * then re-subscribed (`thread/resume`) and backfilled, because item deltas are
   * live-forward only and nothing is replayed to a client that was not there.
   */
  private async resync(): Promise<void> {
    if (this.closing || this.resyncing) return this.resyncing;
    this.accountReader.invalidate();
    this.models = undefined;
    this.resyncing = this.runResync().finally(() => { this.resyncing = undefined; });
    return this.resyncing;
  }

  private async runResync(): Promise<void> {
    const rows = this.rejoinable();
    if (!rows.length) return;
    const listed = new Map<string, WireObject>();
    try {
      const page = await this.rpc.request('thread/list', { limit: 100, excludeTurns: true });
      for (const row of page?.data || []) if (row?.id) listed.set(String(row.id), row);
    } catch { /* Best effort: the resumes below carry an authoritative status anyway. */ }
    await Promise.allSettled(rows.map(async (row) => {
      let state = row.state;
      const entry = listed.get(row.sessionId);
      if (entry) {
        const mapped = await this.applyThreadStatus(row.id, entry.status, row.state, row.sessionId);
        if (mapped) state = mapped.state;
      }
      if (SETTLED_STATES.has(state)) return; // Nothing left to watch on this thread.
      await this.rejoin(row.id, row.sessionId);
    }));
  }

  /** Re-subscribe to one thread, tolerating a rollout that does not exist yet. */
  private async rejoin(id: string, threadId: string): Promise<void> {
    const inFlight = this.loading.get(id);
    if (inFlight) { await inFlight.catch(() => undefined); return; }
    const promise = this.attach(id, threadId);
    this.loading.set(id, promise);
    // A thread that cannot be rejoined is not a thread that failed: the row
    // keeps its stored state and opening it later runs a full load().
    try { await promise; } catch { /* left as stored */ } finally { this.loading.delete(id); }
  }

  private async attach(id: string, threadId: string): Promise<Session> {
    const conv = this.deps.get(id);
    if (!conv) throw new Error('Codex conversation not found');
    const stored = conv.state;
    const fresh = !this.sessions.has(id);
    const s = this.sessions.get(id) ?? {
      snapshot: { conversationId: id, threadId, state: stored, entries: [], requests: [], hasOlder: false },
      rawRequests: new Map(), busy: false, turnEntries: new Set(), limitedTurns: new Set(),
    } as Session;
    // Both maps must be populated before the resume: an approval that was left
    // pending while nobody was connected is re-delivered in the same
    // millisecond as the response, and `serverRequest` rejects unknown threads.
    this.sessions.set(id, s); this.threads.set(threadId, id);
    try {
      const response = await this.resumeSubscribe(conv, threadId);
      await this.history(s);
      await this.applyThreadStatus(id, response?.thread?.status, stored, threadId);
      // A turn that completed while nobody was connected never delivered its
      // turn/completed, so the row's final result (what delegation and a fork
      // back to Claude read) is backfilled from the thread's history.
      const live = this.deps.get(id);
      if (live && !live.lastResult && live.state === 'done') {
        const last = [...s.snapshot.entries].reverse().find((e) => e.role === 'assistant')?.text?.trim();
        if (last) this.deps.update(id, { lastResult: last });
      }
      this.deps.changed(s.snapshot);
      return s;
    } catch (error) {
      if (fresh) { this.threads.delete(threadId); this.sessions.delete(id); }
      throw error;
    }
  }

  /**
   * `thread/resume` is the subscribe. It fails until the thread's first turn
   * has written a rollout, which is a window a freshly started thread really
   * does sit in, so that one error is retried rather than surfaced.
   */
  private async resumeSubscribe(conv: Conversation, threadId: string): Promise<WireObject> {
    const options = this.threadOptions(conv, false);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.rpc.request('thread/resume', { ...options, threadId, excludeTurns: true });
      } catch (error) {
        if (attempt >= RESUME_RETRY.attempts || !NO_ROLLOUT.test((error as Error).message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, RESUME_RETRY.delayMs));
      }
    }
  }

  /** Which ending an idle thread had. Only asked when it can change the answer. */
  private async lastTurn(threadId: string): Promise<ThreadStatusContext> {
    try {
      const page = await this.rpc.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc' });
      const turn = page?.data?.[0];
      return turn ? { hasTurns: true, lastTurnStatus: turn.status, lastTurnError: turn.error?.message } : { hasTurns: false };
    } catch (error) {
      // "not materialized yet" is an answer, not a failure: the thread exists
      // and has never been given a turn. Every other error means we could not
      // ask, which stays undefined so no ending is inferred from it either.
      return NOT_MATERIALIZED.test((error as Error).message) ? { hasTurns: false } : {};
    }
  }

  /**
   * True when an `idle` status has been overtaken while we were asking the
   * server how the last turn ended: a turn is in flight now, or something more
   * recent than this notification has already repainted the row. Painting it
   * anyway drops "Codex finished" on top of a live turn's working dot, where it
   * stays until the turn ends — the row reads as done for the whole turn.
   */
  private staleIdle(id: string, stored?: string): boolean {
    if (this.sessions.get(id)?.turnId) return true;
    const now = this.deps.get(id)?.state;
    return now !== undefined && stored !== undefined && now !== stored;
  }

  /** Paint one thread status onto its row. Returns what was applied, or null. */
  private async applyThreadStatus(id: string, status: WireObject | undefined, stored?: string, threadId?: string): Promise<{ state: CodexThreadState; detail?: string } | null> {
    let ctx: ThreadStatusContext = { stored };
    if (status?.type === 'idle' && threadId && !(stored && SETTLED_STATES.has(stored))) {
      ctx = { ...ctx, ...(await this.lastTurn(threadId)) };
      if (this.staleIdle(id, stored)) return null;
    }
    const mapped = mapThreadStatus(status, ctx);
    if (!mapped) return null;
    this.state(id, mapped.state, mapped.state === 'error' ? mapped.detail : undefined);
    if (mapped.detail && mapped.state !== 'error') this.deps.update(id, { description: mapped.detail });
    this.deps.onThreadStatus?.(id, mapped.state, mapped.detail);
    return mapped;
  }

  // ---- Session plumbing ------------------------------------------------

  private changed(id: string): void {
    if (this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      const s = this.sessions.get(id);
      if (s) this.deps.changed(s.snapshot);
    }, 60));
  }

  private state(id: string, state: string, error?: string): void {
    const s = this.sessions.get(id);
    if (s) { s.snapshot.state = state; s.snapshot.error = error; this.changed(id); }
    const descriptions: Record<string, string> = { working: 'Codex is working', done: 'Codex finished', 'needs-input': NEEDS_INPUT, blocked: NEEDS_INPUT, idle: 'Ready to continue', stopped: 'Interrupted' };
    this.deps.update(id, { state, status: state, description: error || descriptions[state] || state });
  }

  private addItem(s: Session, item: WireObject): void {
    const entry = codexEntry(item);
    if (!entry) return;
    if (s.turnId) s.turnEntries.add(entry.id);
    const index = s.snapshot.entries.findIndex((e) => e.id === entry.id);
    if (index >= 0) s.snapshot.entries[index] = entry;
    else s.snapshot.entries.push(entry);
  }

  /** One quota refusal is one signal, however many notifications describe it. */
  private limit(id: string, s: Session, turnId: string | undefined, message?: unknown): void {
    const text = typeof message === 'string' ? message : '';
    if (!text || !LIMIT_MESSAGE.test(text)) return;
    const key = turnId || 'no-turn';
    if (s.limitedTurns.has(key)) return;
    s.limitedTurns.add(key);
    this.deps.onLimit?.(id, text);
  }

  private notification({ method, params: p = {} }: WireObject): void {
    // Broadcast to every client, subscribed or not, so these are handled before
    // the session lookup: a pinned row the app has not resumed still gets a dot.
    if (method === 'thread/status/changed' || method === 'thread/started') { void this.broadcast(p); return; }
    const id = this.threads.get(p.threadId || p.thread?.id);
    if (!id) return;
    const s = this.sessions.get(id)!;
    if (method === 'turn/started') { s.turnEntries.clear(); s.limitedTurns.clear(); s.turnId = p.turn.id; this.state(id, 'working'); }
    if (method === 'item/started' || method === 'item/completed') this.addItem(s, p.item);
    if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
      let entry = s.snapshot.entries.find((e) => e.id === p.itemId);
      if (!entry) { entry = { id: p.itemId, role: 'assistant', text: '' }; s.snapshot.entries.push(entry); }
      entry.text += p.delta || '';
      s.turnEntries.add(entry.id);
    }
    if (method === 'serverRequest/resolved') {
      s.rawRequests.delete(p.requestId);
      s.snapshot.requests = s.snapshot.requests.filter((r) => r.id !== p.requestId);
      if (!s.snapshot.requests.length && s.turnId) this.state(id, 'working');
    }
    if (method === 'turn/completed') {
      for (const item of p.turn.items || []) this.addItem(s, item);
      const completedTurn = s.turnId || p.turn.id;
      s.turnId = undefined; s.rawRequests.clear(); s.snapshot.requests = [];
      const status = p.turn.status === 'failed' ? 'error' : p.turn.status === 'interrupted' ? 'stopped' : 'done';
      const final = [...s.snapshot.entries].reverse().find((e) => e.role === 'assistant' && s.turnEntries.has(e.id))?.text || '';
      this.deps.update(id, { lastResult: final });
      // The fork's seed has been delivered once Codex has answered on this thread.
      if (s.pendingHandover) { s.pendingHandover = false; this.deps.update(id, { handover: undefined }); }
      if (p.turn.status === 'failed') this.limit(id, s, completedTurn, p.turn.error?.message);
      this.state(id, status, p.turn.error?.message);
    }
    if (method === 'thread/name/updated' && p.threadName) this.deps.update(id, { title: p.threadName });
    if (method === 'error' && !p.willRetry) {
      this.limit(id, s, s.turnId, p.error?.message || p.message);
      this.state(id, 'error', p.error?.message || 'Codex reported an error');
    }
    this.changed(id);
  }

  /** `thread/status/changed` / `thread/started`, which reach every client. */
  private async broadcast(p: WireObject): Promise<void> {
    const threadId = String(p.threadId || p.thread?.id || '');
    if (!threadId) return;
    const id = this.conversationFor(threadId);
    if (!id) return; // A thread somebody else started; not one of our rows.
    const status = p.status || p.thread?.status;
    // A turn we are watching ends twice on the wire — idle here, and
    // `turn/completed` with the result. The second one is the authority.
    if (status?.type === 'idle' && this.sessions.get(id)?.turnId) return;
    const mapped = await this.applyThreadStatus(id, status, this.deps.get(id)?.state, threadId);
    if (mapped) this.changed(id);
  }

  private serverRequest(message: WireObject): void {
    const p = message.params || {};
    const id = this.threads.get(p.threadId);
    const s = id ? this.sessions.get(id) : undefined;
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'];
    if (!id || !s || !supported.includes(message.method)) {
      this.rpc.rejectRequest(message.id, `Peers Flow does not support ${message.method} for this thread`);
      return;
    }
    const titles: Record<string, string> = { 'item/commandExecution/requestApproval': 'Approve command', 'item/fileChange/requestApproval': 'Approve file changes', 'item/tool/requestUserInput': 'Codex has a question', 'item/permissions/requestApproval': 'Approve additional access', 'mcpServer/elicitation/request': 'Connection needs your input' };
    const item = s.snapshot.entries.find((e) => e.id === p.itemId);
    const request: CodexRequest = { id: message.id, method: message.method, title: titles[message.method], detail: [p.reason || p.message, p.command || item?.text, p.cwd, p.networkApprovalContext ? JSON.stringify(p.networkApprovalContext) : '', p.permissions ? JSON.stringify(p.permissions, null, 2) : ''].filter(Boolean).join('\n'), questions: p.questions, schema: p.requestedSchema, url: p.url };
    s.rawRequests.set(message.id, message);
    s.snapshot.requests.push(request);
    if (p.isBlocking !== false) this.state(id, 'needs-input');
    this.changed(id);
  }

  async ensure(id: string): Promise<Session> {
    // `loading` is checked first: a rejoin publishes its session early (so a
    // re-delivered approval has somewhere to land) and is only backfilled when
    // the promise settles — opening the row mid-rejoin must wait for that.
    const pending = this.loading.get(id);
    if (pending) return pending;
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const generation = this.generation;
    const promise = this.load(id);
    this.loading.set(id, promise);
    try { return await promise; }
    catch (error) {
      const s = this.sessions.get(id);
      if (s) this.threads.delete(s.snapshot.threadId);
      this.sessions.delete(id);
      if (generation === this.generation) this.deps.update(id, { state: 'error', status: 'error', description: (error as Error).message });
      throw error;
    } finally { this.loading.delete(id); }
  }

  /** Thread options, with a pending fork's seed folded into the developer instructions. */
  private threadOptions(conv: Conversation, handover: boolean): WireObject {
    const options: WireObject = {
      approvalPolicy: CODEX_DEFAULT_APPROVAL_POLICY, sandbox: CODEX_DEFAULT_SANDBOX,
      ...this.deps.options(conv), cwd: conv.directoryPath, ...(conv.model ? { model: conv.model } : {}),
    };
    if (!handover) return options;
    const context = this.deps.handoverContext?.(conv)?.trim();
    if (!context) return options;
    const existing = typeof options.developerInstructions === 'string' ? options.developerInstructions.trim() : '';
    options.developerInstructions = existing ? `${existing}\n\n${context}` : context;
    return options;
  }

  private async load(id: string): Promise<Session> {
    const conv = this.deps.get(id);
    if (!conv || conv.provider !== 'codex') throw new Error('Codex conversation not found');
    await this.rpc.start();
    // A row forked from Claude can still carry the *other* provider's id in
    // forkFromSessionId — Codex cannot fork a Claude session, so ignore it and
    // start a fresh thread unless this row already has a Codex one.
    const handover = Boolean(conv.handover);
    const method = handover ? (conv.sessionId ? 'thread/resume' : 'thread/start')
      : conv.forkFromSessionId && !conv.sessionId ? 'thread/fork'
        : conv.sessionId ? 'thread/resume' : 'thread/start';
    const source = handover ? conv.sessionId : conv.sessionId || conv.forkFromSessionId;
    const options = this.threadOptions(conv, handover);
    const response = await this.rpc.request(method, { ...options, ...(method === 'thread/start' ? {} : { threadId: source, excludeTurns: true }) });
    const thread = response.thread;
    const s: Session = { snapshot: { conversationId: id, threadId: thread.id, state: 'idle', entries: [], requests: [], hasOlder: false }, rawRequests: new Map(), busy: false, turnEntries: new Set(), limitedTurns: new Set() };
    if (handover) { s.pendingHandover = true; s.snapshot.entries.push({ id: 'handover', role: 'tool', text: HANDOVER_NOTE }); }
    this.sessions.set(id, s); this.threads.set(thread.id, id);
    this.deps.update(id, { sessionId: thread.id, model: response.model || conv.model });
    if (method !== 'thread/start') {
      await this.history(s);
      // Opening a row must not relabel a thread that is still working: the
      // resume response is the only status snapshot the server ever gives.
      if (await this.applyThreadStatus(id, thread.status, conv.state, thread.id)) return s;
    }
    // Nothing conclusive came back. "Ready to continue" is right for a cold
    // thread, but not on top of a row that says a turn is in flight — the
    // status may have been dropped precisely because it was overtaken by one.
    const live = (this.deps.get(id)?.state || '').toLowerCase();
    if (!TURN_IN_FLIGHT.has(live)) this.state(id, 'idle');
    return s;
  }

  /**
   * This conversation's Codex thread, condensed the same way a Claude
   * transcript is, to seed a fork back to Claude. '' when unreadable.
   */
  async historyText(id: string): Promise<string> {
    try {
      const loaded = this.sessions.get(id);
      const known = loaded?.snapshot.entries.filter((e) => e.id !== 'handover') || [];
      if (known.length) return codexHistoryText(known);
      const threadId = loaded?.snapshot.threadId || this.deps.get(id)?.sessionId;
      if (!threadId) return '';
      await this.rpc.start();
      const page = await this.rpc.request('thread/items/list', { threadId, limit: 100, sortDirection: 'desc' });
      const entries = (page?.data || []).map((e: WireObject) => codexEntry(e.item)).filter(Boolean).reverse() as CodexEntry[];
      return codexHistoryText(entries);
    } catch {
      return '';
    }
  }

  private async history(s: Session, older = false): Promise<void> {
    const page = await this.rpc.request('thread/items/list', { threadId: s.snapshot.threadId, limit: 100, sortDirection: 'desc', ...(older && s.cursor ? { cursor: s.cursor } : {}) });
    const entries = (page?.data || []).map((e: WireObject) => codexEntry(e.item)).filter(Boolean).reverse() as CodexEntry[];
    const present = new Set(s.snapshot.entries.map((e) => e.id));
    s.snapshot.entries = [...entries.filter((e) => !present.has(e.id)), ...s.snapshot.entries];
    s.cursor = page?.nextCursor; s.snapshot.hasOlder = !!page?.nextCursor;
  }

  async snapshot(id: string, older = false): Promise<CodexSnapshot> {
    const s = await this.ensure(id);
    if (older && s.cursor) await this.history(s, true);
    return s.snapshot;
  }

  async send(id: string, prompt: string, images: string[] = []): Promise<void> {
    const generation = this.generation;
    const s = await this.ensure(id);
    if (s.busy || s.turnId) throw new Error('Codex is still working. Stop the current turn before sending another.');
    if (!prompt.trim()) throw new Error('A prompt is required');
    s.busy = true;
    const conv = this.deps.get(id);
    this.deps.update(id, { lastPrompt: prompt, lastResult: '', attachments: [...new Set([...(conv?.attachments || []), ...images])] });
    this.state(id, 'working');
    try {
      const result = await this.rpc.request('turn/start', { threadId: s.snapshot.threadId, input: [{ type: 'text', text: prompt, text_elements: [] }, ...images.map((p) => ({ type: 'localImage', path: p }))] });
      // turn/started is authoritative; completion can arrive before this reply.
      if (result.turn?.status === 'inProgress' && s.snapshot.state === 'working') s.turnId = result.turn.id;
    } catch (error) {
      if (generation === this.generation) this.state(id, 'error', (error as Error).message);
      throw error;
    } finally { s.busy = false; }
  }

  /**
   * Put a message on a thread's queue instead of refusing it. A queued message
   * starts a turn immediately on an idle thread and waits for the running one
   * otherwise — which is what a nudge (a limit-watch resume, a delegation
   * follow-up) wants, since `send` will not interrupt work in flight.
   */
  async queue(id: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error('A message is required');
    const threadId = this.sessions.get(id)?.snapshot.threadId || this.deps.get(id)?.sessionId;
    if (!threadId) throw new Error('This conversation has no Codex thread yet');
    await this.rpc.start();
    if (this.serverQueues !== false) {
      try {
        await this.rpc.request('thread/queue/add', { threadId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: randomUUID() });
        this.serverQueues = true;
        return;
      } catch (error) {
        if (!METHOD_ABSENT.test((error as Error).message)) throw error;
        this.serverQueues = false; // An older app-server: the CLI can still reach it.
      }
    }
    const socket = this.rpc.socketPath?.();
    await queueCli.run(['queue', '--thread', threadId, '--message', text, ...(socket ? ['--remote', `unix://${socket}`] : [])]);
  }

  async stop(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s?.turnId) await this.rpc.request('turn/interrupt', { threadId: s.snapshot.threadId, turnId: s.turnId });
  }

  async reply(id: string, requestId: string | number, reply: CodexReply): Promise<void> {
    const s = this.sessions.get(id);
    const request = s?.rawRequests.get(requestId);
    if (!s || !request) throw new Error('This request is no longer pending');
    this.rpc.reply(requestId, approvalResult(request.method, request.params, reply));
    s.rawRequests.delete(requestId);
    s.snapshot.requests = s.snapshot.requests.filter((r) => r.id !== requestId);
    if (!s.snapshot.requests.length && s.turnId) this.state(id, 'working');
    this.changed(id);
  }

  /**
   * Let go of one thread: stop watching it and drop what we cached. The thread
   * itself stays on the server — it is history, and `thread/list` still has it.
   */
  async forget(id: string): Promise<void> {
    await this.stop(id);
    const s = this.sessions.get(id);
    const threadId = s?.snapshot.threadId || this.deps.get(id)?.sessionId;
    if (threadId) await this.rpc.request('thread/unsubscribe', { threadId }).catch(() => undefined);
    if (s) this.threads.delete(s.snapshot.threadId);
    this.sessions.delete(id);
  }

  /**
   * Give up the connection, not the work. The app-server outlives this process
   * and its threads keep running, so a turn in flight is left saying exactly
   * that — the next launch reads its real state back off the server.
   */
  close(): void {
    this.closing = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.sessions.clear(); this.threads.clear(); this.loading.clear();
    this.rpc.close();
  }
}
