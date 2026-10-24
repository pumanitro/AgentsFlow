import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as http from 'http';
import type { Account } from '../shared/types';
import type { PostJson, TokenResponse } from './oauth-pkce';
import { cancelMint, mintTokenFor, verifyMintedIdentity } from './token-mint';

// Placeholder strings only — no real token material in fixtures.
const FAKE_ACCESS = 'fake-access-value';

const account = (over: Partial<Account> = {}): Account => ({
  id: 'acct-1',
  email: 'me@example.com',
  configDir: '/tmp/never-used',
  accountUuid: 'uuid-me',
  orgId: 'org-me',
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const resp = (over: Partial<TokenResponse> = {}): TokenResponse => ({
  accessToken: FAKE_ACCESS,
  expiresAt: 1,
  scopes: ['user:inference'],
  account: { uuid: 'uuid-me', email: 'me@example.com' },
  organization: { uuid: 'org-me', name: 'Mine' },
  ...over,
});

function get(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => { res.resume(); res.on('end', () => resolve()); }).on('error', reject);
  });
}

/** Plays the browser: approves immediately by hitting the callback with the right state. */
const approve = async (url: string) => {
  const q = new URL(url).searchParams;
  await get(`${q.get('redirect_uri')}?code=c&state=${encodeURIComponent(q.get('state')!)}`);
};

const post = (json: Record<string, unknown>): PostJson => async () => ({ status: 200, body: JSON.stringify(json) });
const goodBody = {
  access_token: FAKE_ACCESS,
  expires_in: 31_536_000,
  scope: 'user:inference',
  account: { uuid: 'uuid-me', email_address: 'me@example.com' },
  organization: { uuid: 'org-me', name: 'Mine' },
};

test('verifyMintedIdentity: same identity → ok, nothing learned', () => {
  assert.deepEqual(verifyMintedIdentity(account(), resp()), { ok: true });
});

test('verifyMintedIdentity: different account uuid → mismatch naming both emails', () => {
  const v = verifyMintedIdentity(account(), resp({ account: { uuid: 'uuid-other', email: 'other@example.com' } }));
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.error,
    'That browser was signed in as other@example.com, not me@example.com. Sign in to claude.ai as me@example.com (or use the browser profile you added it with) and try again.');
});

test('verifyMintedIdentity: different organization → org mismatch', () => {
  const v = verifyMintedIdentity(account(), resp({ organization: { uuid: 'org-other', name: 'Theirs' } }));
  assert.equal(v.ok, false);
  assert.match(!v.ok ? v.error : '', /authorised a different Claude organization/);
});

test('verifyMintedIdentity: legacy account learns ids; email still checked', () => {
  const legacy = account({ accountUuid: undefined, orgId: undefined });
  assert.deepEqual(verifyMintedIdentity(legacy, resp({ account: { uuid: 'uuid-me', email: 'ME@example.com' } })),
    { ok: true, learned: { accountUuid: 'uuid-me', orgId: 'org-me' } });
  assert.equal(verifyMintedIdentity(legacy, resp({ account: { uuid: 'u2', email: 'other@example.com' } })).ok, false);
  // Unknown on the response side is not a mismatch.
  assert.deepEqual(verifyMintedIdentity(account(), resp({ account: undefined, organization: undefined })), { ok: true });
});

test('mintTokenFor: approved round-trip → ok outcome, hint + org on the URL', async () => {
  let authorize = '';
  const out = await mintTokenFor(account(), {
    openUrl: async (url) => { authorize = url; await approve(url); },
    post: post(goodBody),
    timeoutMs: 2000,
  });
  assert.equal(out.ok, true);
  assert.ok(out.ok && out.token === FAKE_ACCESS);
  assert.ok(out.ok && out.expiresAt > Date.now());
  assert.deepEqual(out.ok && out.scopes, ['user:inference']);
  assert.equal(out.ok && out.learned, undefined);
  const q = new URL(authorize).searchParams;
  assert.equal(q.get('login_hint'), 'me@example.com');
  assert.equal(q.get('orgUUID'), 'org-me');
  assert.equal(q.get('scope'), 'user:inference');
});

test('mintTokenFor: identity mismatch → mismatch, token not returned', async () => {
  const out = await mintTokenFor(account(), {
    openUrl: approve,
    post: post({ ...goodBody, account: { uuid: 'uuid-other', email_address: 'other@example.com' } }),
    timeoutMs: 2000,
  });
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.reason, 'mismatch');
  assert.ok(!JSON.stringify(out).includes(FAKE_ACCESS));
});

test('mintTokenFor: second concurrent call → busy; cancelMint → cancelled; slot frees after', async () => {
  const a = account({ id: 'acct-busy' });
  let opened!: () => void;
  const openedP = new Promise<void>((r) => { opened = r; });
  const first = mintTokenFor(a, { openUrl: async () => { opened(); }, post: post(goodBody), timeoutMs: 5000 });
  await openedP;
  const second = await mintTokenFor(a, { openUrl: approve, post: post(goodBody), timeoutMs: 2000 });
  assert.deepEqual(second.ok === false && second.reason, 'busy');
  assert.equal(cancelMint(a.id), true);
  const out = await first;
  assert.equal(!out.ok && out.reason, 'cancelled');
  assert.equal(cancelMint(a.id), false);
  const again = await mintTokenFor(a, { openUrl: approve, post: post(goodBody), timeoutMs: 2000 });
  assert.equal(again.ok, true);
});

test('mintTokenFor: never throws — timeout and failing openUrl become outcomes', async () => {
  const t = await mintTokenFor(account({ id: 'acct-t' }), { openUrl: async () => {}, post: post(goodBody), timeoutMs: 30 });
  assert.equal(!t.ok && t.reason, 'timeout');
  const o = await mintTokenFor(account({ id: 'acct-o' }), { openUrl: async () => { throw new Error('no browser'); }, timeoutMs: 1000 });
  assert.equal(!o.ok && o.reason, 'unknown');
});
