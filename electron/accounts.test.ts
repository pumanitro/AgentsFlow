import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as crypto from 'crypto';
import {
  evaluateLogin,
  isGmail,
  mergeOAuthAccount,
  mergeOAuthInto,
  parseAuthStatus,
  serviceNameFor,
  slugForEmail,
} from './accounts';
import type { Account } from '../shared/types';

function account(over: Partial<Account> = {}): Account {
  return {
    id: 'id-1',
    email: 'first@gmail.com',
    configDir: '/tmp/vault/first',
    accountUuid: 'uuid-1',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Keychain service naming — if this drifts from the CLI we read/write the wrong
// slot, which is the difference between switching accounts and silently doing
// nothing. The expected value is recomputed the same way the CLI does it.
// ---------------------------------------------------------------------------

test('serviceNameFor: no config dir means the default (unsuffixed) slot', () => {
  assert.equal(serviceNameFor(), 'Claude Code-credentials');
  assert.equal(serviceNameFor(null), 'Claude Code-credentials');
  assert.equal(serviceNameFor(''), 'Claude Code-credentials');
});

test('serviceNameFor: a config dir appends the first 8 hex of its sha256', () => {
  const dir = '/Users/someone/.agentsflow/accounts/alpha-abc123';
  const expected = crypto.createHash('sha256').update(dir).digest('hex').substring(0, 8);
  assert.equal(serviceNameFor(dir), `Claude Code-credentials-${expected}`);
});

test('serviceNameFor: NFC-normalises so a decomposed path maps to one slot', () => {
  // "é" composed vs. decomposed — the same directory to the filesystem, and it
  // must be the same keychain slot too.
  const composed = '/tmp/café';
  const decomposed = '/tmp/café';
  assert.equal(serviceNameFor(composed), serviceNameFor(decomposed));
});

test('serviceNameFor: distinct dirs never collide', () => {
  assert.notEqual(serviceNameFor('/tmp/a'), serviceNameFor('/tmp/b'));
});

// ---------------------------------------------------------------------------
// Slot merging — the main slot also holds MCP server tokens. Replacing the blob
// wholesale would sign the user out of every OAuth MCP server they use.
// ---------------------------------------------------------------------------

test('mergeOAuthInto: replaces claudeAiOauth and preserves siblings', () => {
  const existing = {
    mcpOAuth: { 'server|hash': { accessToken: 'keep-me' } },
    somethingElse: 42,
    claudeAiOauth: { accessToken: 'old' },
  };
  const merged = mergeOAuthInto(existing, { accessToken: 'new' });
  assert.deepEqual(merged.mcpOAuth, { 'server|hash': { accessToken: 'keep-me' } });
  assert.equal(merged.somethingElse, 42);
  assert.deepEqual(merged.claudeAiOauth, { accessToken: 'new' });
});

test('mergeOAuthInto: tolerates an empty slot', () => {
  const merged = mergeOAuthInto(null, { accessToken: 'new' });
  assert.deepEqual(merged, { claudeAiOauth: { accessToken: 'new' } });
});

// ---------------------------------------------------------------------------
// ~/.claude.json identity merge — that file is ~190 KB of unrelated state.
// ---------------------------------------------------------------------------

test('mergeOAuthAccount: swaps only oauthAccount', () => {
  const main = { projects: { a: 1 }, numStartups: 7, oauthAccount: { emailAddress: 'old@gmail.com' } };
  const vault = { oauthAccount: { emailAddress: 'new@gmail.com', accountUuid: 'u2' } };
  const merged = mergeOAuthAccount(main, vault);
  assert.deepEqual(merged.oauthAccount, { emailAddress: 'new@gmail.com', accountUuid: 'u2' });
  assert.deepEqual(merged.projects, { a: 1 });
  assert.equal(merged.numStartups, 7);
});

test('mergeOAuthAccount: a vault with no identity leaves the file untouched', () => {
  const main = { oauthAccount: { emailAddress: 'old@gmail.com' }, other: true };
  assert.deepEqual(mergeOAuthAccount(main, {}), main);
  assert.deepEqual(mergeOAuthAccount(main, null), main);
});

// ---------------------------------------------------------------------------
// Gmail enforcement + vault naming
// ---------------------------------------------------------------------------

test('isGmail: accepts gmail/googlemail, rejects everything else', () => {
  assert.ok(isGmail('someone@gmail.com'));
  assert.ok(isGmail('Someone.Else+tag@googlemail.com'));
  assert.ok(isGmail('  padded@gmail.com  '));
  assert.equal(isGmail('someone@anthropic.com'), false);
  assert.equal(isGmail('someone@gmail.com.evil.co'), false);
  assert.equal(isGmail('not-an-email'), false);
  assert.equal(isGmail(''), false);
});

test('slugForEmail: stable, filesystem-safe, and distinct per address', () => {
  const a = slugForEmail('First.Last@gmail.com');
  assert.equal(a, slugForEmail('first.last@gmail.com'), 'case-insensitive');
  assert.match(a, /^[a-z0-9-]+$/);
  assert.notEqual(a, slugForEmail('other@gmail.com'));
});

// ---------------------------------------------------------------------------
// The login guard — a browser holds one claude.ai session, so the most likely
// failure is authorising the account you were already signed in as.
// ---------------------------------------------------------------------------

test('evaluateLogin: still pending until the CLI reports a login', () => {
  const v = evaluateLogin({
    status: { loggedIn: false },
    expectedEmail: 'new@gmail.com',
    existing: [],
  });
  assert.equal(v.verdict, 'pending');
});

test('evaluateLogin: accepts the address we asked for', () => {
  const v = evaluateLogin({
    status: { loggedIn: true, email: 'New@Gmail.com' },
    expectedEmail: 'new@gmail.com',
    accountUuid: 'uuid-2',
    existing: [account()],
  });
  assert.equal(v.verdict, 'ok');
});

test('evaluateLogin: rejects a different address than the one requested', () => {
  const v = evaluateLogin({
    status: { loggedIn: true, email: 'already@gmail.com' },
    expectedEmail: 'new@gmail.com',
    accountUuid: 'uuid-2',
    existing: [],
  });
  assert.equal(v.verdict, 'mismatch');
  assert.match((v as { error: string }).error, /already@gmail\.com/);
  assert.match((v as { error: string }).error, /incognito/i);
});

test('evaluateLogin: rejects a re-authorisation of an account already pooled', () => {
  const v = evaluateLogin({
    status: { loggedIn: true, email: 'new@gmail.com' },
    expectedEmail: 'new@gmail.com',
    accountUuid: 'uuid-1', // same real account as the existing entry
    existing: [account()],
  });
  assert.equal(v.verdict, 'duplicate');
  assert.match((v as { error: string }).error, /first@gmail\.com/);
});

test('evaluateLogin: no uuid available cannot false-positive as duplicate', () => {
  const v = evaluateLogin({
    status: { loggedIn: true, email: 'new@gmail.com' },
    expectedEmail: 'new@gmail.com',
    accountUuid: undefined,
    existing: [account()],
  });
  assert.equal(v.verdict, 'ok');
});

// ---------------------------------------------------------------------------
// CLI output parsing
// ---------------------------------------------------------------------------

test('parseAuthStatus: reads the signed-in shape', () => {
  const s = parseAuthStatus(JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    email: 'me@gmail.com',
    orgId: 'org-1',
    subscriptionType: 'max',
  }));
  assert.deepEqual(s, { loggedIn: true, email: 'me@gmail.com', orgId: 'org-1', subscriptionType: 'max' });
});

test('parseAuthStatus: signed-out and garbage both read as not logged in', () => {
  assert.equal(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}').loggedIn, false);
  assert.equal(parseAuthStatus('not json at all').loggedIn, false);
  assert.equal(parseAuthStatus('').loggedIn, false);
});
