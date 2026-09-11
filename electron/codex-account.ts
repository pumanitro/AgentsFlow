import type { CodexAccountStatus, UsageMeter, UsageResult } from '../shared/types';
import type { CodexRpc, WireObject } from './codex-protocol';

export function codexUsage(response: WireObject, plan?: string): UsageResult {
  const meters: UsageMeter[] = [];
  const buckets = response.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length
    ? response.rateLimitsByLimitId : { codex: response.rateLimits };
  for (const [id, value] of Object.entries(buckets)) {
    const bucket = value as WireObject | null;
    if (!bucket) continue;
    for (const slot of ['primary', 'secondary']) {
      const window = bucket[slot];
      if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue;
      const percent = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
      const minutes = window.windowDurationMins;
      const duration = minutes === 10080 ? 'Weekly' : minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hours` : minutes > 0 ? `${minutes} minutes` : slot === 'primary' ? 'Session' : 'Longer window';
      const reset = typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1000) : null;
      meters.push({ key: `${id}:${slot}`, label: `${bucket.limitName || (id === 'codex' ? 'Codex' : id)} · ${duration}`,
        group: minutes >= 10080 ? 'weekly' : 'session', percent,
        severity: percent >= 95 ? 'danger' : percent >= 80 ? 'warning' : 'normal',
        resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null, isActive: true });
    }
  }
  return { ok: true, snapshot: { meters, plan, fetchedAt: new Date().toISOString() } };
}

// Shares the agent connection and deduplicates the Accounts/Usage panel reads.
export class CodexAccountReader {
  private cached?: { at: number; value: CodexAccountStatus };
  private inflight?: Promise<CodexAccountStatus>;
  constructor(private rpc: Pick<CodexRpc, 'start' | 'request'>) {}
  invalidate(): void { this.cached = undefined; }
  read(force = false): Promise<CodexAccountStatus> {
    if (this.inflight) return this.inflight;
    if (!force && this.cached && Date.now() - this.cached.at < 55_000) return Promise.resolve(this.cached.value);
    this.inflight = this.fetch().then(value => { this.cached = { at: Date.now(), value }; return value; }).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  private async fetch(): Promise<CodexAccountStatus> {
    try {
      await this.rpc.start();
      const { account } = await this.rpc.request('account/read', { refreshToken: false });
      if (!account) return { signedIn: false, usage: { ok: false, reason: 'no-auth', error: 'Sign in with codex login to connect Codex.' } };
      const result: CodexAccountStatus = { signedIn: true, email: account.email || undefined, plan: account.planType || undefined,
        authType: account.type, usage: { ok: false, reason: 'unknown', error: 'Plan usage is available for ChatGPT subscriptions.' } };
      if (account.type === 'chatgpt') {
        try { result.usage = codexUsage(await this.rpc.request('account/rateLimits/read', {}), result.plan); }
        catch { result.usage = { ok: false, reason: 'network', error: 'Could not read Codex usage. Refresh to try again.' }; }
      }
      return result;
    } catch {
      return { signedIn: false, error: 'Could not connect to Codex. Check that the CLI is installed and signed in.',
        usage: { ok: false, reason: 'unknown', error: 'Codex is unavailable. Check the CLI installation and sign-in.' } };
    }
  }
}
