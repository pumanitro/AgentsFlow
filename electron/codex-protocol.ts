import { EventEmitter } from 'node:events';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { agentEnvironment } from './cli-environment';

// App-server is versioned independently of this app. Only the small wire surface
// we consume is modeled here; unknown notifications remain forward compatible.
export type WireObject = Record<string, any>;
export class CodexRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.launch();
    return this.ready;
  }

  private async launch(): Promise<void> {
    const child = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--stdio'], {
      env: agentEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.emit('diagnostic', error); }
    });
    const failed = (error: Error) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      lines.close();
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear();
      this.emit('disconnected', error);
    };
    child.on('error', (e) => failed(new Error(`Cannot start Codex: ${e.message}. Check CODEX_BIN or your CLI installation.`)));
    child.on('exit', (code) => failed(new Error(`Codex app-server exited (${code}). ${stderr}`)));
    child.stdin.on('error', failed);
    try {
      await this.request('initialize', { clientInfo: { name: 'peers_flow', title: 'Peers Flow', version: '10.1.0' }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
    } catch (error) {
      child.kill();
      throw error;
    }
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
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex is disconnected. Reopen the conversation to reconnect.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  request(method: string, params: WireObject = {}): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  reply(id: number | string, result: WireObject): void { this.write({ id, result }); }
  rejectRequest(id: number | string, message: string): void { this.write({ id, error: { code: -32601, message } }); }
  close(): void { this.child?.kill(); }
}
