import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  evaluateLogin,
  isEmailAddress,
  mergeOAuthAccount,
  mergeOAuthInto,
  newerCreds,
  parseAuthStatus,
  provablyNotTheLogin,
  revocationVerdict,
  sameCreds,
  serviceNameFor,
  slugForEmail,
  TokenRefreshError,
} from './accounts';
import type { OAuthCredentials } from './accounts';
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
// Address validation + vault naming
// ---------------------------------------------------------------------------

test('isEmailAddress: accepts any real domain, rejects malformed input', () => {
  assert.ok(isEmailAddress('someone@gmail.com'));
  assert.ok(isEmailAddress('Someone.Else+tag@googlemail.com'));
  assert.ok(isEmailAddress('  padded@gmail.com  '));
  // Google Workspace and other custom domains — the case this replaced.
  assert.ok(isEmailAddress('patryk.janik@abilitie.com'));
  assert.ok(isEmailAddress('first.last@mail.corp.co.uk'));
  assert.equal(isEmailAddress('not-an-email'), false);
  assert.equal(isEmailAddress('someone@localhost'), false);
  assert.equal(isEmailAddress('someone@company.'), false);
  assert.equal(isEmailAddress('two words@company.com'), false);
  assert.equal(isEmailAddress(''), false);
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

// ---------------------------------------------------------------------------
// Credential reconciliation
//
// The active account's tokens sit in two keychain slots at once, and a refresh
// kills the token it was bought with. Pick the wrong copy as authoritative and
// the CLI is left holding a spent refresh token — which it answers by wiping its
// credentials and printing "Login expired · Please run /login". These two
// functions are the whole of that decision, so they are worth pinning down.
// ---------------------------------------------------------------------------

function creds(over: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 1_000, ...over };
}

test('sameCreds: identical token pairs need no reconciliation', () => {
  assert.equal(sameCreds(creds(), creds()), true);
});

test('sameCreds: a rotated refresh token counts as divergence even at the same access token', () => {
  // This is the dangerous shape: same access token, so nothing looks wrong until
  // the refresh that follows is rejected.
  assert.equal(sameCreds(creds(), creds({ refreshToken: 'refresh-2' })), false);
});

test('sameCreds: a missing copy is never "the same" as a present one', () => {
  assert.equal(sameCreds(creds(), null), false);
  assert.equal(sameCreds(null, creds()), false);
  // Two empty slots do agree — which is why reconcileActive asks newerCreds()
  // FIRST. Reaching this predicate with both gone would report an account with
  // no credentials anywhere as healthy.
  assert.equal(sameCreds(null, null), true);
  assert.equal(newerCreds(null, null), 'neither');
});

test('newerCreds: the later expiry is the copy that was refreshed last', () => {
  assert.equal(newerCreds(creds({ expiresAt: 2_000 }), creds({ expiresAt: 1_000 })), 'main');
  assert.equal(newerCreds(creds({ expiresAt: 1_000 }), creds({ expiresAt: 2_000 })), 'vault');
});

test('newerCreds: the keep-warm bug shape resolves to the vault', () => {
  // Exactly what used to happen: keep-warm refreshed the ACTIVE account through
  // its vault, leaving the main slot on the spent token. The live chain is the
  // vault's, so that is what has to go back into the main slot.
  const mainStranded = creds({ accessToken: 'old', refreshToken: 'spent', expiresAt: 100 });
  const vaultLive = creds({ accessToken: 'new', refreshToken: 'live', expiresAt: 900 });
  assert.equal(newerCreds(mainStranded, vaultLive), 'vault');
});

test('newerCreds: the CLI having rotated resolves to main, so the vault gets mirrored', () => {
  const mainRotatedByCli = creds({ accessToken: 'new', refreshToken: 'live', expiresAt: 900 });
  const vaultStale = creds({ accessToken: 'old', refreshToken: 'spent', expiresAt: 100 });
  assert.equal(newerCreds(mainRotatedByCli, vaultStale), 'main');
});

test('newerCreds: a wiped main slot loses to any surviving vault copy', () => {
  // The CLI clears its own credentials after a rejected refresh. That empty slot
  // must never win, or the repair would install nothing.
  assert.equal(newerCreds(null, creds()), 'vault');
  assert.equal(newerCreds(creds(), null), 'main');
  assert.equal(newerCreds(null, null), 'neither');
});

test('newerCreds: ties and unknown expiries defer to main', () => {
  // When we cannot tell who is newer, the safe answer is the one that cannot
  // yank a token out from under a session that is running right now.
  assert.equal(newerCreds(creds({ expiresAt: 500 }), creds({ expiresAt: 500 })), 'main');
  assert.equal(newerCreds(creds({ expiresAt: undefined }), creds({ expiresAt: undefined })), 'main');
  // ...but a dated copy still beats an undated one.
  assert.equal(newerCreds(creds({ expiresAt: undefined }), creds({ expiresAt: 1 })), 'vault');
});

// ---------------------------------------------------------------------------
// "Is this definitely NOT the account the CLI is signed in as?"
// ---------------------------------------------------------------------------
// The question asked when no active account is recorded — a state that does not
// self-heal, so answering it wrongly is not a transient. Wrong in one direction
// re-mints the running session's refresh token and ends in "Login expired";
// wrong in the other leaves every standby account unreadable and rotation
// parked all night. Only a positive, identity-based "not it" may say yes.

/** Runs `fn` with $HOME pointed at a throwaway dir holding this `.claude.json`. */
function withLogin<T>(config: unknown | null, fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsflow-home-'));
  if (config !== null) fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(config));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const signedIn = (uuid: string) => ({ oauthAccount: { accountUuid: uuid } });

test('provablyNotTheLogin: a different uuid than the login is proof', () => {
  assert.equal(
    withLogin(signedIn('uuid-LOGIN'), () => provablyNotTheLogin(account({ accountUuid: 'uuid-OTHER' }))),
    true,
  );
});

test('provablyNotTheLogin: the login itself is never "not the login"', () => {
  assert.equal(
    withLogin(signedIn('uuid-LOGIN'), () => provablyNotTheLogin(account({ accountUuid: 'uuid-LOGIN' }))),
    false,
  );
});

test('provablyNotTheLogin: an unknown uuid on either side abstains', () => {
  // Absence of proof is not proof. Both of these must fail SAFE — refusing to
  // touch an account we cannot identify — rather than defaulting to "standby".
  assert.equal(
    withLogin(signedIn('uuid-LOGIN'), () => provablyNotTheLogin(account({ accountUuid: undefined }))),
    false,
    'an account with no recorded uuid could be the login',
  );
  assert.equal(
    withLogin({ oauthAccount: {} }, () => provablyNotTheLogin(account({ accountUuid: 'uuid-OTHER' }))),
    false,
    'a login we cannot identify could be any account',
  );
});

test('provablyNotTheLogin: no config file at all abstains rather than throwing', () => {
  assert.equal(withLogin(null, () => provablyNotTheLogin(account({ accountUuid: 'uuid-OTHER' }))), false);
});

// ---------------------------------------------------------------------------
// Revocation — when "unreadable" becomes "dead"
// ---------------------------------------------------------------------------
// 2026-08-21, 03:49–05:14: the active account's refresh token was rejected
// with HTTP 400 on every one of 85 minute-ticks, and the app's only reaction
// was to write the same dead credentials back into the keychain each time.

test('TokenRefreshError: 400 and 401 from the token endpoint are rejections', () => {
  assert.equal(new TokenRefreshError(400).rejected, true);
  assert.equal(new TokenRefreshError(401).rejected, true);
  assert.match(new TokenRefreshError(400).message, /token refresh rejected \(HTTP 400\)/);
});

test('TokenRefreshError: 429, 5xx and the like are weather, not a verdict', () => {
  assert.equal(new TokenRefreshError(429).rejected, false);
  assert.equal(new TokenRefreshError(500).rejected, false);
  assert.equal(new TokenRefreshError(503).rejected, false);
  assert.equal(new TokenRefreshError(0).rejected, false);
});

test('revocationVerdict: three rejections in a row mean the account is dead', () => {
  assert.equal(revocationVerdict({ strikes: 1, accessTokenExpired: false }), false);
  assert.equal(revocationVerdict({ strikes: 2, accessTokenExpired: false }), false);
  assert.equal(revocationVerdict({ strikes: 3, accessTokenExpired: false }), true);
  assert.equal(revocationVerdict({ strikes: 7, accessTokenExpired: false }), true);
});

test('revocationVerdict: one rejection with nothing usable left is enough', () => {
  // A dead refresh token AND an expired access token: there is no credential
  // anywhere that could work, so waiting for two more strikes only postpones
  // the switch that gets the agents moving again.
  assert.equal(revocationVerdict({ strikes: 1, accessTokenExpired: true }), true);
});
