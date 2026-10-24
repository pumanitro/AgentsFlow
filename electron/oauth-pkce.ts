// The app's own `claude setup-token`: an OAuth authorization-code flow with
// PKCE that ends in a one-year, inference-only token for one claude.ai login.
//
// How it runs (endpoints and parameters read out of the CLI binary, not
// guessed):
//   1. A throwaway HTTP server listens on a loopback port; its
//      `http://localhost:<port>/callback` is the redirect URI.
//   2. The browser opens the authorize URL (PKCE challenge + random state);
//      the user approves on claude.ai, which redirects back with `code`.
//   3. The code is exchanged at the token endpoint, together with the PKCE
//      verifier and the lifetime we ask for, for the token itself.
//
// Rules this module keeps:
//   • The token never reaches a log line, an error message or the browser.
//     Errors carry an HTTP status at most, never a response body.
//   • The callback server is always closed, however the flow ends.
//   • The browser is opened only through the caller's `openUrl`, so tests and
//     main.ts decide how (shell.openExternal in the app).

import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import type { AddressInfo } from 'net';

export const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const EXCHANGE_TIMEOUT_MS = 15_000;

export class OAuthFlowError extends Error {
  constructor(public readonly reason: 'cancelled' | 'timeout' | 'denied' | 'network' | 'unknown', message: string) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

// ---------------------------------------------------------------------------
// PKCE + authorize URL
// ---------------------------------------------------------------------------

export interface Pkce { verifier: string; challenge: string; state: string }

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Verifier and state are 32 random bytes each; challenge = base64url(sha256(verifier)). */
export function generatePkce(randomBytes: (n: number) => Buffer = crypto.randomBytes): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));
  return { verifier, challenge, state };
}

export function buildAuthorizeUrl(o: { redirectUri: string; scopes: string; pkce: Pkce; loginHint?: string; orgUuid?: string }): string {
  const url = new URL(AUTHORIZE_URL);
  const q = url.searchParams;
  q.set('code', 'true');
  q.set('client_id', CLIENT_ID);
  q.set('response_type', 'code');
  q.set('redirect_uri', o.redirectUri);
  q.set('scope', o.scopes);
  q.set('code_challenge', o.pkce.challenge);
  q.set('code_challenge_method', 'S256');
  q.set('state', o.pkce.state);
  // Pre-selects the right login / organization on the consent page. Advisory
  // only — the identity is still verified against the response afterwards.
  if (o.loginHint) q.set('login_hint', o.loginHint);
  if (o.orgUuid) q.set('orgUUID', o.orgUuid);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Local callback server
// ---------------------------------------------------------------------------

export interface CallbackServer {
  port: number;
  redirectUri: string;
  waitForCode(timeoutMs: number, signal?: AbortSignal): Promise<{ code: string; state: string }>;
  close(): void;
}

function page(res: http.ServerResponse, status: number, text: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>Peers Flow</title>`
    + `<body style="font:16px -apple-system,system-ui,sans-serif;padding:48px;text-align:center">${text}</body>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/**
 * Listens on `listenHost`, port 0. The first `/callback` that carries a code
 * (or an error) settles the flow; it is buffered, so a redirect that lands
 * before `waitForCode` is called is not lost. The state is NOT checked here —
 * the caller compares it with its PKCE state.
 */
export function startCallbackServer(listenHost = '127.0.0.1'): Promise<CallbackServer> {
  let settle!: (r: { code: string; state: string } | OAuthFlowError) => void;
  const result = new Promise<{ code: string; state: string } | OAuthFlowError>((resolve) => { settle = resolve; });
  let settled = false;

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return page(res, 400, 'Bad request.');
    }
    if (req.method !== 'GET' || url.pathname !== '/callback') return page(res, 404, 'Not found.');
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') ?? '';
    if (error) {
      page(res, 200, 'Authorization was not granted. You can close this tab and return to Peers Flow.');
      if (!settled) {
        settled = true;
        settle(error === 'access_denied'
          ? new OAuthFlowError('denied', 'The authorization was declined in the browser.')
          : new OAuthFlowError('unknown', `The browser returned an authorization error (${error.slice(0, 60)}).`));
      }
      return;
    }
    if (!code) return page(res, 400, 'Missing authorization code.');
    page(res, 200, 'Authorized — you can close this tab and return to Peers Flow.');
    if (!settled) {
      settled = true;
      settle({ code, state });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new OAuthFlowError('unknown', `Could not start the local sign-in listener (${(err as NodeJS.ErrnoException).code ?? err.message}).`)));
    server.listen(0, listenHost, () => {
      const port = (server.address() as AddressInfo).port;
      let closed = false;
      resolve({
        port,
        // `localhost` literally: it is what the CLI registers and what the
        // authorize endpoint accepts for a loopback redirect.
        redirectUri: `http://localhost:${port}/callback`,
        waitForCode(timeoutMs, signal) {
          return new Promise((res, rej) => {
            if (signal?.aborted) return rej(new OAuthFlowError('cancelled', 'Token generation was cancelled.'));
            const timer = setTimeout(() => {
              cleanup();
              rej(new OAuthFlowError('timeout', 'Timed out waiting for the browser authorization.'));
            }, timeoutMs);
            const onAbort = () => {
              cleanup();
              rej(new OAuthFlowError('cancelled', 'Token generation was cancelled.'));
            };
            const cleanup = () => {
              clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            void result.then((r) => {
              cleanup();
              if (r instanceof OAuthFlowError) rej(r);
              else res(r);
            });
          });
        },
        close() {
          if (closed) return;
          closed = true;
          server.close();
          // The browser may hold a keep-alive socket open; don't let it keep
          // the listener (and its port) alive.
          server.closeAllConnections?.();
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Code → token exchange
// ---------------------------------------------------------------------------

export interface TokenResponse {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
  refreshToken?: string;
  account?: { uuid?: string; email?: string };
  organization?: { uuid?: string; name?: string };
}
export type PostJson = (url: string, body: Record<string, unknown>) => Promise<{ status: number; body: string }>;

function httpPostJson(url: string, body: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'application/json',
        },
        timeout: EXCHANGE_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('token request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Pure mapping of the token endpoint's JSON. `expiresAt` is 0 when the
 * response states no lifetime (exchangeCode then assumes the requested one).
 */
export function parseTokenResponse(json: unknown, now: number = Date.now()): TokenResponse {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, any>;
  const accessToken = str(j.access_token);
  if (!accessToken) throw new OAuthFlowError('unknown', 'The token endpoint returned no token.');
  const expiresIn = Number(j.expires_in);
  const out: TokenResponse = {
    accessToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : 0,
    scopes: typeof j.scope === 'string' ? j.scope.split(/\s+/).filter(Boolean) : [],
  };
  const refreshToken = str(j.refresh_token);
  if (refreshToken) out.refreshToken = refreshToken;
  if (j.account && typeof j.account === 'object') {
    out.account = { uuid: str(j.account.uuid), email: str(j.account.email_address) };
  }
  if (j.organization && typeof j.organization === 'object') {
    out.organization = { uuid: str(j.organization.uuid), name: str(j.organization.name) };
  }
  return out;
}

export async function exchangeCode(o: { code: string; state: string; redirectUri: string; verifier: string; expiresInS: number; post?: PostJson }): Promise<TokenResponse> {
  const post = o.post ?? httpPostJson;
  let resp: { status: number; body: string };
  try {
    resp = await post(TOKEN_URL, {
      grant_type: 'authorization_code',
      code: o.code,
      redirect_uri: o.redirectUri,
      client_id: CLIENT_ID,
      code_verifier: o.verifier,
      state: o.state,
      expires_in: o.expiresInS,
    });
  } catch (err) {
    throw new OAuthFlowError('network', `Could not reach the token endpoint (${(err as Error)?.message ?? 'network error'}).`);
  }
  if (resp.status < 200 || resp.status >= 300) {
    // 429/5xx are worth a retry; 4xx means the code/verifier was refused.
    const transient = resp.status === 0 || resp.status === 429 || resp.status >= 500;
    throw new OAuthFlowError(transient ? 'network' : 'unknown', `The token endpoint refused the exchange (HTTP ${resp.status}).`);
  }
  let json: unknown;
  try {
    json = JSON.parse(resp.body);
  } catch {
    throw new OAuthFlowError('unknown', 'The token endpoint returned unparseable data.');
  }
  const now = Date.now();
  const parsed = parseTokenResponse(json, now);
  if (!parsed.expiresAt) parsed.expiresAt = now + o.expiresInS * 1000;
  return parsed;
}

// ---------------------------------------------------------------------------
// The whole flow
// ---------------------------------------------------------------------------

export async function runAuthorizationCodeFlow(o: { scopes: string; expiresInS: number; loginHint?: string; orgUuid?: string; openUrl: (url: string) => Promise<void>; timeoutMs: number; signal?: AbortSignal; listenHost?: string; post?: PostJson }): Promise<TokenResponse> {
  const cancelled = () => new OAuthFlowError('cancelled', 'Token generation was cancelled.');
  if (o.signal?.aborted) throw cancelled();
  const pkce = generatePkce();
  const server = await startCallbackServer(o.listenHost);
  try {
    const url = buildAuthorizeUrl({ redirectUri: server.redirectUri, scopes: o.scopes, pkce, loginHint: o.loginHint, orgUuid: o.orgUuid });
    try {
      await o.openUrl(url);
    } catch (err) {
      throw new OAuthFlowError('unknown', `Could not open the browser (${(err as Error)?.message ?? err}).`);
    }
    const { code, state } = await server.waitForCode(o.timeoutMs, o.signal);
    if (state !== pkce.state) {
      throw new OAuthFlowError('unknown', 'The browser returned a mismatched sign-in state — start again.');
    }
    if (o.signal?.aborted) throw cancelled();
    const token = await exchangeCode({ code, state, redirectUri: server.redirectUri, verifier: pkce.verifier, expiresInS: o.expiresInS, post: o.post });
    // Cancelled while the exchange was in flight: drop the token on the floor.
    if (o.signal?.aborted) throw cancelled();
    return token;
  } finally {
    server.close();
  }
}
