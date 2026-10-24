import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as crypto from 'crypto';
import * as http from 'http';
import {
  AUTHORIZE_URL,
  CLIENT_ID,
  OAuthFlowError,
  TOKEN_URL,
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  parseTokenResponse,
  runAuthorizationCodeFlow,
  startCallbackServer,
  type PostJson,
} from './oauth-pkce';

// Every fixture below is a placeholder string — no real token material.
const FAKE_ACCESS = 'fake-access-value';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

const okPost = (json: Record<string, unknown>, status = 200): PostJson => async () => ({ status, body: JSON.stringify(json) });

test('generatePkce: challenge is base64url(sha256(verifier)), fixed byte source', () => {
  let n = 0;
  const bytes = (len: number) => Buffer.alloc(len, ++n);
  const p = generatePkce(bytes);
  assert.equal(p.verifier, b64url(Buffer.alloc(32, 1)));
  assert.equal(p.state, b64url(Buffer.alloc(32, 2)));
  assert.equal(p.challenge, b64url(crypto.createHash('sha256').update(p.verifier).digest()));
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(p.challenge, /^[A-Za-z0-9_-]{43}$/);
});

test('generatePkce: default source is random', () => {
  const a = generatePkce();
  const b = generatePkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
});

test('buildAuthorizeUrl: every param present; hint/org only when given', () => {
  const pkce = { verifier: 'v', challenge: 'chal', state: 'st' };
  const bare = new URL(buildAuthorizeUrl({ redirectUri: 'http://localhost:1234/callback', scopes: 'user:inference', pkce }));
  assert.equal(`${bare.origin}${bare.pathname}`, AUTHORIZE_URL);
  const q = bare.searchParams;
  assert.equal(q.get('code'), 'true');
  assert.equal(q.get('client_id'), CLIENT_ID);
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('redirect_uri'), 'http://localhost:1234/callback');
  assert.equal(q.get('scope'), 'user:inference');
  assert.equal(q.get('code_challenge'), 'chal');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('state'), 'st');
  assert.equal(q.has('login_hint'), false);
  assert.equal(q.has('orgUUID'), false);

  const full = new URL(buildAuthorizeUrl({ redirectUri: 'http://localhost:1/callback', scopes: 'user:inference user:profile', pkce, loginHint: 'a+b@example.com', orgUuid: 'org-1' })).searchParams;
  assert.equal(full.get('scope'), 'user:inference user:profile');
  assert.equal(full.get('login_hint'), 'a+b@example.com');
  assert.equal(full.get('orgUUID'), 'org-1');
});

test('startCallbackServer: real round-trip resolves waitForCode', async () => {
  const s = await startCallbackServer('127.0.0.1');
  try {
    assert.equal(s.redirectUri, `http://localhost:${s.port}/callback`);
    const wait = s.waitForCode(2000);
    const r = await get(`${s.redirectUri}?code=abc&state=xyz`);
    assert.equal(r.status, 200);
    assert.match(r.body, /Authorized/);
    assert.deepEqual(await wait, { code: 'abc', state: 'xyz' });
  } finally {
    s.close();
  }
});

test('startCallbackServer: a redirect landing before waitForCode is buffered; other paths 404', async () => {
  const s = await startCallbackServer();
  try {
    assert.equal((await get(`http://localhost:${s.port}/elsewhere`)).status, 404);
    assert.equal((await get(`${s.redirectUri}?state=only`)).status, 400);
    await get(`${s.redirectUri}?code=early&state=s1`);
    assert.deepEqual(await s.waitForCode(1000), { code: 'early', state: 's1' });
  } finally {
    s.close();
  }
});

test('startCallbackServer: ?error=access_denied → denied', async () => {
  const s = await startCallbackServer();
  try {
    const denied = assert.rejects(s.waitForCode(2000), (e: unknown) => e instanceof OAuthFlowError && e.reason === 'denied');
    const r = await get(`${s.redirectUri}?error=access_denied&state=x`);
    assert.equal(r.status, 200);
    await denied;
  } finally {
    s.close();
  }
});

test('startCallbackServer: abort → cancelled, short timeout → timeout', async () => {
  const s = await startCallbackServer();
  try {
    const ac = new AbortController();
    const wait = s.waitForCode(5000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(wait, (e: unknown) => e instanceof OAuthFlowError && e.reason === 'cancelled');
    await assert.rejects(s.waitForCode(30), (e: unknown) => e instanceof OAuthFlowError && e.reason === 'timeout');
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(s.waitForCode(5000, pre.signal), (e: unknown) => e instanceof OAuthFlowError && e.reason === 'cancelled');
  } finally {
    s.close();
  }
});

test('parseTokenResponse: maps fields, email_address → email', () => {
  const r = parseTokenResponse({
    access_token: FAKE_ACCESS,
    expires_in: 100,
    scope: 'user:inference  user:profile',
    refresh_token: 'fake-refresh-value',
    account: { uuid: 'acc-1', email_address: 'a@example.com' },
    organization: { uuid: 'org-1', name: 'Org' },
  }, 1_000);
  assert.deepEqual(r, {
    accessToken: FAKE_ACCESS,
    expiresAt: 101_000,
    scopes: ['user:inference', 'user:profile'],
    refreshToken: 'fake-refresh-value',
    account: { uuid: 'acc-1', email: 'a@example.com' },
    organization: { uuid: 'org-1', name: 'Org' },
  });
  const min = parseTokenResponse({ access_token: FAKE_ACCESS }, 5);
  assert.deepEqual(min, { accessToken: FAKE_ACCESS, expiresAt: 0, scopes: [] });
  assert.throws(() => parseTokenResponse({}), (e: unknown) => e instanceof OAuthFlowError && e.reason === 'unknown');
  assert.throws(() => parseTokenResponse(null), (e: unknown) => e instanceof OAuthFlowError);
});

test('exchangeCode: posts the exact JSON body to the token URL', async () => {
  let seenUrl = '';
  let seen: Record<string, unknown> = {};
  const post: PostJson = async (url, body) => {
    seenUrl = url;
    seen = body;
    return { status: 200, body: JSON.stringify({ access_token: FAKE_ACCESS, expires_in: 31_536_000, scope: 'user:inference' }) };
  };
  const before = Date.now();
  const r = await exchangeCode({ code: 'c1', state: 's1', redirectUri: 'http://localhost:9/callback', verifier: 'v1', expiresInS: 31_536_000, post });
  assert.equal(seenUrl, TOKEN_URL);
  assert.deepEqual(seen, {
    grant_type: 'authorization_code',
    code: 'c1',
    redirect_uri: 'http://localhost:9/callback',
    client_id: CLIENT_ID,
    code_verifier: 'v1',
    state: 's1',
    expires_in: 31_536_000,
  });
  assert.equal(r.accessToken, FAKE_ACCESS);
  assert.deepEqual(r.scopes, ['user:inference']);
  assert.ok(r.expiresAt >= before + 31_536_000_000);
});

test('exchangeCode: no stated lifetime → requested one; failures map to reasons without echoing bodies', async () => {
  const r = await exchangeCode({ code: 'c', state: 's', redirectUri: 'r', verifier: 'v', expiresInS: 60, post: okPost({ access_token: FAKE_ACCESS }) });
  assert.ok(r.expiresAt > Date.now() + 50_000);

  const leaky: PostJson = async () => ({ status: 400, body: JSON.stringify({ error: 'invalid_grant', access_token: FAKE_ACCESS }) });
  await assert.rejects(exchangeCode({ code: 'c', state: 's', redirectUri: 'r', verifier: 'v', expiresInS: 60, post: leaky }), (e: unknown) =>
    e instanceof OAuthFlowError && e.reason === 'unknown' && /HTTP 400/.test(e.message) && !e.message.includes(FAKE_ACCESS));
  await assert.rejects(exchangeCode({ code: 'c', state: 's', redirectUri: 'r', verifier: 'v', expiresInS: 60, post: okPost({}, 503) }), (e: unknown) =>
    e instanceof OAuthFlowError && e.reason === 'network');
  await assert.rejects(exchangeCode({ code: 'c', state: 's', redirectUri: 'r', verifier: 'v', expiresInS: 60, post: async () => { throw new Error('ECONNRESET'); } }), (e: unknown) =>
    e instanceof OAuthFlowError && e.reason === 'network');
  await assert.rejects(exchangeCode({ code: 'c', state: 's', redirectUri: 'r', verifier: 'v', expiresInS: 60, post: async () => ({ status: 200, body: 'not json' }) }), (e: unknown) =>
    e instanceof OAuthFlowError && e.reason === 'unknown');
});

/** Plays the browser: reads redirect_uri + state off the authorize URL and hits the callback. */
const browser = (mutateState?: (s: string) => string) => async (url: string) => {
  const q = new URL(url).searchParams;
  const state = mutateState ? mutateState(q.get('state')!) : q.get('state')!;
  await get(`${q.get('redirect_uri')}?code=the-code&state=${encodeURIComponent(state)}`);
};

test('runAuthorizationCodeFlow: browser round-trip → exchanged token, server closed', async () => {
  let redirect = '';
  let body: Record<string, unknown> = {};
  const r = await runAuthorizationCodeFlow({
    scopes: 'user:inference',
    expiresInS: 100,
    loginHint: 'a@example.com',
    timeoutMs: 2000,
    openUrl: async (url) => { redirect = new URL(url).searchParams.get('redirect_uri')!; await browser()(url); },
    post: async (_u, b) => { body = b; return { status: 200, body: JSON.stringify({ access_token: FAKE_ACCESS, expires_in: 100, scope: 'user:inference' }) }; },
  });
  assert.equal(r.accessToken, FAKE_ACCESS);
  assert.equal(body.code, 'the-code');
  assert.equal(body.redirect_uri, redirect);
  await assert.rejects(get(redirect), (e: NodeJS.ErrnoException) => e.code === 'ECONNREFUSED');
});

test('runAuthorizationCodeFlow: wrong state → unknown, no exchange', async () => {
  let posted = false;
  await assert.rejects(runAuthorizationCodeFlow({
    scopes: 'user:inference',
    expiresInS: 100,
    timeoutMs: 2000,
    openUrl: browser((s) => `${s}-tampered`),
    post: async () => { posted = true; return { status: 200, body: '{}' }; },
  }), (e: unknown) => e instanceof OAuthFlowError && e.reason === 'unknown');
  assert.equal(posted, false);
});

test('runAuthorizationCodeFlow: timeout and pre-aborted signal', async () => {
  await assert.rejects(runAuthorizationCodeFlow({ scopes: 's', expiresInS: 1, timeoutMs: 30, openUrl: async () => {} }), (e: unknown) =>
    e instanceof OAuthFlowError && e.reason === 'timeout');
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(runAuthorizationCodeFlow({ scopes: 's', expiresInS: 1, timeoutMs: 1000, signal: ac.signal, openUrl: async () => {} }), (e: unknown) =>
    e instanceof OAuthFlowError && e.reason === 'cancelled');
});
