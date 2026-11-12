// Usage fallback for pooled accounts whose usage endpoint cannot answer (dead
// or revoked sign-in, scope 403, standing 429). Sends a 1-token message with
// the account's one-year inference token and reads the unified rate-limit
// headers off the response. Weekly meter only unless a 5h header comes back.
import * as https from 'node:https';
import type { UsageMeter, UsageResult, UsageSnapshot } from '../shared/types';

export const PROBE_MIN_INTERVAL_MS = 10 * 60 * 1000;
export const PROBE_FORCE_MIN_INTERVAL_MS = 60 * 1000;
export const STALE_SNAPSHOT_MS = 15 * 60 * 1000;

export type HeaderBag = Record<string, string | string[] | undefined>;
export type ProbeHttp = (token: string) => Promise<{ status: number; headers: HeaderBag }>;

const PREFIX = 'anthropic-ratelimit-unified-';

function header(headers: HeaderBag, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== want) continue;
    const v = headers[k];
    const first = Array.isArray(v) ? v[0] : v;
    if (typeof first === 'string') return first.trim();
  }
  return undefined;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoFromUnix(v: string | undefined): string | null {
  const n = num(v);
  if (n === null) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function severityOf(status: string | undefined, percent: number): UsageMeter['severity'] {
  const s = (status ?? '').toLowerCase();
  if (s) {
    if (s.includes('rejected')) return 'danger';
    if (s.includes('warning')) return 'warning';
    if (s === 'allowed') return 'normal';
  }
  if (percent >= 100) return 'danger';
  if (percent >= 80) return 'warning';
  return 'normal';
}

function windowMeter(headers: HeaderBag, win: '5h' | '7d', claim: string | undefined): UsageMeter | null {
  const u = num(header(headers, `${PREFIX}${win}-utilization`));
  if (u === null) return null;
  const percent = Math.min(100, Math.max(0, Math.round(u * 100)));
  const session = win === '5h';
  return {
    key: session ? 'session' : 'weekly_all',
    label: session ? 'Current session' : 'All models',
    group: session ? 'session' : 'weekly',
    percent,
    severity: severityOf(header(headers, `${PREFIX}${win}-status`), percent),
    resetsAt: isoFromUnix(header(headers, `${PREFIX}${win}-reset`)),
    isActive: claim === (session ? 'five_hour' : 'seven_day'),
  };
}

export function snapshotFromRateLimitHeaders(headers: HeaderBag, fetchedAt: string, plan?: string): UsageSnapshot | null {
  const claim = header(headers, `${PREFIX}representative-claim`);
  const meters: UsageMeter[] = [];
  const s = windowMeter(headers, '5h', claim);
  const w = windowMeter(headers, '7d', claim);
  if (s) meters.push(s);
  if (w) meters.push(w);
  if (!meters.length && (header(headers, `${PREFIX}status`) ?? '').toLowerCase() === 'rejected') {
    const session = claim === 'five_hour';
    meters.push({
      key: session ? 'session' : 'weekly_all',
      label: session ? 'Current session' : 'All models',
      group: session ? 'session' : 'weekly',
      percent: 100,
      severity: 'danger',
      resetsAt: isoFromUnix(header(headers, `${PREFIX}reset`)),
      isActive: true,
    });
  }
  if (!meters.length) return null;
  return { meters, fetchedAt, plan, source: 'token-probe' };
}

export function needsProbe(primary: UsageResult, nowMs: number = Date.now()): boolean {
  if (!primary.ok) return primary.reason !== 'network';
  // usage.ts keeps serving the last good snapshot through a standing 429.
  const at = Date.parse(primary.snapshot.fetchedAt);
  return Number.isFinite(at) && nowMs - at > STALE_SNAPSHOT_MS;
}

const realHttp: ProbeHttp = (token) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  const req = https.request(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 10_000,
    },
    (res) => {
      res.on('data', () => { /* drain */ });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers as HeaderBag }));
    },
  );
  req.on('timeout', () => req.destroy(new Error('request timed out')));
  req.on('error', reject);
  req.end(body);
});

let http: ProbeHttp = realHttp;
let clock: () => number = Date.now;
const cache = new Map<string, { result: UsageResult; atMs: number }>();
const inflight = new Map<string, Promise<UsageResult>>();

export function __setProbeHttpForTests(fn: ProbeHttp | null): void {
  http = fn ?? realHttp;
  cache.clear();
  inflight.clear();
}

export function __setProbeClockForTests(fn: (() => number) | null): void {
  clock = fn ?? Date.now;
}

export function getUsageFromTokenProbe(accountId: string, token: string, force = false, plan?: string): Promise<UsageResult> {
  const now = clock();
  const hit = cache.get(accountId);
  const minAge = force ? PROBE_FORCE_MIN_INTERVAL_MS : PROBE_MIN_INTERVAL_MS;
  if (hit && now - hit.atMs < minAge) return Promise.resolve(hit.result);
  const running = inflight.get(accountId);
  if (running) return running;
  const p = (async (): Promise<UsageResult> => {
    let result: UsageResult;
    let status = 0;
    try {
      const res = await http(token);
      status = res.status;
      const snap = snapshotFromRateLimitHeaders(res.headers, new Date(clock()).toISOString(), plan);
      if (snap) result = { ok: true, snapshot: snap };
      else if (status === 401 || status === 403) result = { ok: false, reason: 'expired', error: `One-year token rejected (HTTP ${status}).` };
      else result = { ok: false, reason: 'unknown', error: `Token probe returned HTTP ${status} without usage headers.` };
    } catch (err) {
      result = { ok: false, reason: 'network', error: `Token probe failed: ${(err as Error)?.message ?? err}` };
    }
    console.log('[agentsflow][usage] token probe', { accountId, status, ok: result.ok });
    cache.set(accountId, { result, atMs: clock() });
    return result;
  })().finally(() => inflight.delete(accountId));
  inflight.set(accountId, p);
  return p;
}
