import type { Conversation } from '../shared/types';
import type { CodexEntry, CodexReply, CodexRequest, CodexSnapshot } from '../shared/codex';
import { CodexRpc, WireObject } from './codex-protocol';

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

interface Session {
  snapshot: CodexSnapshot;
  turnId?: string;
  cursor?: string | null;
  rawRequests: Map<string | number, WireObject>;
  busy: boolean;
  turnEntries: Set<string>;
}
interface Dependencies {
  get: (id: string) => Conversation | null;
  update: (id: string, patch: Partial<Conversation>) => void;
  options: (conv: Conversation) => WireObject;
  changed: (snapshot: CodexSnapshot) => void;
}

export class CodexAgents {
  private closing = false;
  private sessions = new Map<string, Session>();
  private threads = new Map<string, string>();
  private loading = new Map<string, Promise<Session>>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private deps: Dependencies, private rpc = new CodexRpc()) {
    rpc.on('notification', (m) => this.notification(m));
    rpc.on('request', (m) => this.serverRequest(m));
    rpc.on('disconnected', (error: Error) => {
      if (this.closing) return;
      for (const [id, s] of this.sessions) {
        s.snapshot.requests = []; s.rawRequests.clear();
        this.state(id, 'error', error.message);
        this.deps.changed(s.snapshot);
      }
      this.sessions.clear(); this.threads.clear(); this.loading.clear();
    });
  }

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
    const descriptions: Record<string, string> = { working: 'Codex is working', done: 'Codex finished', 'needs-input': 'Codex needs your input', idle: 'Ready to continue', stopped: 'Interrupted' };
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

  private notification({ method, params: p = {} }: WireObject): void {
    const id = this.threads.get(p.threadId || p.thread?.id);
    if (!id) return;
    const s = this.sessions.get(id)!;
    if (method === 'turn/started') { s.turnEntries.clear(); s.turnId = p.turn.id; this.state(id, 'working'); }
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
      s.turnId = undefined; s.rawRequests.clear(); s.snapshot.requests = [];
      const status = p.turn.status === 'failed' ? 'error' : p.turn.status === 'interrupted' ? 'stopped' : 'done';
      const final = [...s.snapshot.entries].reverse().find((e) => e.role === 'assistant' && s.turnEntries.has(e.id))?.text || '';
      this.deps.update(id, { lastResult: final });
      this.state(id, status, p.turn.error?.message);
    }
    if (method === 'thread/name/updated' && p.threadName) this.deps.update(id, { title: p.threadName });
    if (method === 'error' && !p.willRetry) this.state(id, 'error', p.error?.message || 'Codex reported an error');
    this.changed(id);
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
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const pending = this.loading.get(id);
    if (pending) return pending;
    const promise = this.load(id);
    this.loading.set(id, promise);
    try { return await promise; }
    catch (error) {
      const s = this.sessions.get(id);
      if (s) this.threads.delete(s.snapshot.threadId);
      this.sessions.delete(id);
      this.deps.update(id, { state: 'error', status: 'error', description: (error as Error).message });
      throw error;
    } finally { this.loading.delete(id); }
  }

  private async load(id: string): Promise<Session> {
    const conv = this.deps.get(id);
    if (!conv || conv.provider !== 'codex') throw new Error('Codex conversation not found');
    await this.rpc.start();
    const options = { ...this.deps.options(conv), cwd: conv.directoryPath, ...(conv.model ? { model: conv.model } : {}) };
    const method = conv.forkFromSessionId && !conv.sessionId ? 'thread/fork' : conv.sessionId ? 'thread/resume' : 'thread/start';
    const response = await this.rpc.request(method, { ...options, ...(method === 'thread/start' ? {} : { threadId: conv.sessionId || conv.forkFromSessionId, excludeTurns: true }) });
    const thread = response.thread;
    const s: Session = { snapshot: { conversationId: id, threadId: thread.id, state: 'idle', entries: [], requests: [], hasOlder: false }, rawRequests: new Map(), busy: false, turnEntries: new Set() };
    this.sessions.set(id, s); this.threads.set(thread.id, id);
    this.deps.update(id, { sessionId: thread.id, model: response.model || conv.model });
    if (method !== 'thread/start') await this.history(s);
    this.state(id, 'idle');
    return s;
  }

  private async history(s: Session, older = false): Promise<void> {
    const page = await this.rpc.request('thread/items/list', { threadId: s.snapshot.threadId, limit: 100, sortDirection: 'desc', ...(older && s.cursor ? { cursor: s.cursor } : {}) });
    const entries = page.data.map((e: WireObject) => codexEntry(e.item)).filter(Boolean).reverse() as CodexEntry[];
    const present = new Set(s.snapshot.entries.map((e) => e.id));
    s.snapshot.entries = [...entries.filter((e) => !present.has(e.id)), ...s.snapshot.entries];
    s.cursor = page.nextCursor; s.snapshot.hasOlder = !!page.nextCursor;
  }

  async snapshot(id: string, older = false): Promise<CodexSnapshot> {
    const s = await this.ensure(id);
    if (older && s.cursor) await this.history(s, true);
    return s.snapshot;
  }

  async send(id: string, prompt: string, images: string[] = []): Promise<void> {
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
    } catch (error) { this.state(id, 'error', (error as Error).message); throw error; }
    finally { s.busy = false; }
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

  async forget(id: string): Promise<void> {
    await this.stop(id);
    const s = this.sessions.get(id);
    if (s) this.threads.delete(s.snapshot.threadId);
    this.sessions.delete(id);
  }

  close(): void {
    this.closing = true;
    for (const [id, s] of this.sessions) {
      if (s.turnId || s.busy) this.deps.update(id, { state: 'stopped', status: 'stopped', description: 'App closed. Reopen to continue.' });
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.rpc.close();
  }
}
