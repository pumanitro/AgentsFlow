// Live plan-usage meters, read from the same authenticated endpoint that powers
// Claude Code's `/usage` screen. We only ever READ: the OAuth access token comes
// from the macOS keychain entry Claude Code itself maintains (or, as a fallback,
// ~/.claude/.credentials.json). We never write tokens back or attempt a refresh —
// the constantly-running claude sessions in this app keep that token fresh, and
// touching it could race Claude Code's own token management.
//
// Endpoint (verified live): GET https://api.anthropic.com/api/oauth/usage
//   Authorization: Bearer <accessToken>
//   anthropic-beta: oauth-2025-04-20
// Response carries a clean `limits[]` array we normalise into UsageMeter rows.

import { execFile } from 'child_process';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { UsageMeter, UsageResult, UsageSnapshot } from '../shared/types';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

// Don't hammer the endpoint: reuse a recent result for repeat callers (multiple
// windows, rapid polls). The renderer polls on a ~60s cadence anyway.
const MIN_FETCH_INTERVAL_MS = 25_000;

interface OAuthCreds {
  accessToken: string;
  expiresAt?: number; // epoch ms
  subscriptionType?: string;
  rateLimitTier?: string;
}

let cache: { result: UsageResult; atMs: number } | null = null;
let inflight: Promise<UsageResult> | null = null;

function execFileP(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// Read Claude Code's OAuth credentials. Prefer the macOS keychain (where the CLI
// stores them on darwin); fall back to the plaintext credentials file used on
// other platforms / older installs.
async function readCreds(): Promise<OAuthCreds | null> {
  // 1) macOS keychain
  if (process.platform === 'darwin') {
    try {
      const raw = await execFileP('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], 4000);
      const creds = parseCreds(raw);
      if (creds) return creds;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[agentsflow][usage] keychain read failed', (err as Error)?.message ?? err);
    }
  }
  // 2) ~/.claude/.credentials.json fallback
  try {
    const p = path.join(os.homedir(), '.claude', '.credentials.json');
    const raw = fs.readFileSync(p, 'utf8');
    const creds = parseCreds(raw);
    if (creds) return creds;
  } catch { /* not present — fine */ }
  return null;
}

function parseCreds(raw: string): OAuthCreds | null {
  try {
    const j = JSON.parse(raw);
    const o = j?.claudeAiOauth ?? j;
    if (o && typeof o.accessToken === 'string' && o.accessToken) {
      return {
        accessToken: o.accessToken,
        expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : undefined,
        subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : undefined,
        rateLimitTier: typeof o.rateLimitTier === 'string' ? o.rateLimitTier : undefined,
      };
    }
  } catch { /* fall through */ }
  return null;
}

function httpGetJson(url: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function normalizeSeverity(s: unknown): UsageMeter['severity'] {
  const v = String(s ?? '').toLowerCase();
  if (v === 'warning' || v === 'warn') return 'warning';
  if (v === 'danger' || v === 'critical' || v === 'exceeded' || v === 'error') return 'danger';
  return 'normal';
}

function labelFor(kind: string, scope: any): string {
  if (kind === 'session') return 'Current session';
  if (kind === 'weekly_all') return 'All models';
  const model = scope?.model?.display_name;
  const surface = scope?.surface;
  if (model) return surface ? `${model} · ${surface}` : String(model);
  if (surface) return String(surface);
  return 'Scoped limit';
}

function keyFor(kind: string, scope: any, idx: number): string {
  if (kind === 'session') return 'session';
  if (kind === 'weekly_all') return 'weekly_all';
  const id = scope?.model?.id ?? scope?.model?.display_name ?? scope?.surface ?? idx;
  return `weekly:${id}`;
}

function planLabel(creds: OAuthCreds): string | undefined {
  const t = creds.subscriptionType;
  if (!t) return undefined;
  const pretty = t.charAt(0).toUpperCase() + t.slice(1);
  // rateLimitTier occasionally encodes a multiplier (e.g. "default_max_20x").
  const m = creds.rateLimitTier?.match(/(\d+x)/i);
  return m ? `${pretty} (${m[1]})` : pretty;
}

function normalize(json: any, creds: OAuthCreds, fetchedAt: string): UsageSnapshot {
  const limits: any[] = Array.isArray(json?.limits) ? json.limits : [];
  const meters: UsageMeter[] = limits
    .map((l, i) => {
      const kind = String(l?.kind ?? '');
      const group: UsageMeter['group'] = l?.group === 'session' || kind === 'session' ? 'session' : 'weekly';
      const pct = Number(l?.percent);
      return {
        key: keyFor(kind, l?.scope, i),
        label: labelFor(kind, l?.scope),
        group,
        percent: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0,
        severity: normalizeSeverity(l?.severity),
        resetsAt: typeof l?.resets_at === 'string' ? l.resets_at : null,
        isActive: Boolean(l?.is_active),
      } as UsageMeter;
    })
    // Session first, then the weekly rows in the order the API returned them.
    .sort((a, b) => (a.group === b.group ? 0 : a.group === 'session' ? -1 : 1));

  return { meters, fetchedAt, plan: planLabel(creds) };
}

async function doFetch(): Promise<UsageResult> {
  const creds = await readCreds();
  if (!creds) {
    return { ok: false, reason: 'no-auth', error: 'Not signed in to Claude Code (no credentials found).' };
  }
  if (creds.expiresAt && creds.expiresAt < Date.now()) {
    // Let the request run anyway (the token may still be honoured briefly), but
    // if it 401s we report it as expired below.
    // eslint-disable-next-line no-console
    console.warn('[agentsflow][usage] access token appears expired; attempting fetch anyway');
  }
  let resp: { status: number; body: string };
  try {
    resp = await httpGetJson(USAGE_URL, creds.accessToken);
  } catch (err) {
    return { ok: false, reason: 'network', error: `Network error: ${(err as Error)?.message ?? err}` };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, reason: 'expired', error: `Auth rejected (HTTP ${resp.status}). Open a Claude Code session to refresh sign-in.` };
  }
  if (resp.status < 200 || resp.status >= 300) {
    return { ok: false, reason: 'unknown', error: `Usage endpoint returned HTTP ${resp.status}.` };
  }
  let json: any;
  try {
    json = JSON.parse(resp.body);
  } catch {
    return { ok: false, reason: 'unknown', error: 'Usage endpoint returned unparseable data.' };
  }
  const fetchedAt = new Date().toISOString();
  return { ok: true, snapshot: normalize(json, creds, fetchedAt) };
}

// Public entry: returns a normalised usage snapshot, cached briefly. Pass
// force=true to bypass the cache (the panel's manual refresh button).
export async function getUsage(force = false): Promise<UsageResult> {
  const now = Date.now();
  if (!force && cache && now - cache.atMs < MIN_FETCH_INTERVAL_MS) {
    return cache.result;
  }
  if (inflight) return inflight;
  inflight = doFetch()
    .then((result) => {
      // Cache successes; also cache hard-auth failures (no point re-hammering a
      // signed-out state), but let transient network errors retry next tick.
      if (result.ok || result.reason === 'no-auth' || result.reason === 'expired') {
        cache = { result, atMs: Date.now() };
      } else if (cache && cache.result.ok) {
        // Keep serving the last good snapshot through a transient blip.
        return cache.result;
      }
      return result;
    })
    .finally(() => { inflight = null; });
  return inflight;
}
