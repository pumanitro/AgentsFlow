// Reconciliation against a real keychain.
//
// accounts.test.ts pins down the *decision* (newerCreds/sameCreds). This file
// pins down what the decision actually does to the slots, because the bug it
// guards against was never a wrong decision — it was two writers rotating the
// same token behind each other's backs, which only shows up once real writes
// are involved.
//
// It is safe to run: `keychainAccount()` derives the keychain *account* from
// $USER, so overriding that here puts every slot this touches — main included —
// in a namespace of its own. The user's real login is never read or written.
// Nothing hits the network either: every credential is minted with a far-future
// expiry, so the refresh-if-stale path never fires.

import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { freshenAccountToken, keepWarm, reconcileActive, serviceNameFor } from './accounts';
import type { OAuthCredentials } from './accounts';
import type { Account } from '../shared/types';

const TEST_KEYCHAIN_ACCOUNT = 'agentsflow-selftest';
const MAIN = 'Claude Code-credentials';

function keychainUsable(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('security', ['-h'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('credential reconciliation (keychain)', { skip: keychainUsable() ? false : 'needs macOS `security`' }, () => {
  let realUser: string | undefined;
  let vaultDir: string;
  let VAULT: string;
  let account: Account;

  const write = (service: string, blob: unknown) =>
    execFileSync('security', ['add-generic-password', '-U', '-a', TEST_KEYCHAIN_ACCOUNT, '-s', service, '-w', JSON.stringify(blob)]);
  const read = (service: string): any => {
    try {
      return JSON.parse(execFileSync('security', ['find-generic-password', '-a', TEST_KEYCHAIN_ACCOUNT, '-s', service, '-w'], { encoding: 'utf8' }).trim());
    } catch {
      return null;
    }
  };
  const drop = (service: string) => {
    try {
      execFileSync('security', ['delete-generic-password', '-a', TEST_KEYCHAIN_ACCOUNT, '-s', service], { stdio: 'ignore' });
    } catch { /* already gone */ }
  };

  // Far-future expiries keep every case off the network; the relative order of
  // the two `expiresAt` values is the only thing under test.
  const FAR = Date.now() + 30 * 864e5;
  const creds = (accessToken: string, refreshToken: string, ageRank: number): OAuthCredentials =>
    ({ accessToken, refreshToken, expiresAt: FAR + ageRank, refreshTokenExpiresAt: FAR });

  before(() => {
    realUser = process.env.USER;
    process.env.USER = TEST_KEYCHAIN_ACCOUNT;
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsflow-keychain-test-'));
    VAULT = serviceNameFor(vaultDir);
    account = { id: 'test-1', email: 'test@gmail.com', configDir: vaultDir, addedAt: '2026-01-01T00:00:00.000Z' };
  });

  after(() => {
    drop(MAIN);
    drop(VAULT);
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (realUser === undefined) delete process.env.USER;
    else process.env.USER = realUser;
  });

  test('restores the main slot when keep-warm rotated the token out from under it', async () => {
    // The reported bug, exactly: the vault holds the live chain, the main slot
    // the CLI reads is left on the token that rotation already killed. Left
    // alone, the CLI's next refresh is rejected and it demands `/login`.
    write(MAIN, { claudeAiOauth: creds('access-old', 'refresh-SPENT', 0), mcpOAuth: { 'srv|h': { accessToken: 'mcp-keep' } } });
    write(VAULT, { claudeAiOauth: creds('access-new', 'refresh-LIVE', 100) });

    const result = await reconcileActive(account, [account]);
    assert.equal(result.outcome, 'repaired-main');
    assert.equal(read(MAIN).claudeAiOauth.refreshToken, 'refresh-LIVE');
    // Invariant 1: the main slot also holds MCP server tokens.
    assert.equal(read(MAIN).mcpOAuth['srv|h'].accessToken, 'mcp-keep');

    // And it settles — a repair that re-fires every tick would be a write loop.
    assert.equal((await reconcileActive(account, [account])).outcome, 'in-sync');
  });

  test('adopts the CLI\'s own rotation into the vault instead of overwriting it', async () => {
    // The other direction, and the one that must never install the vault's copy:
    // the newer token belongs to a session running right now.
    write(MAIN, { claudeAiOauth: creds('cli-new', 'refresh-CLI', 100) });
    write(VAULT, { claudeAiOauth: creds('access-old', 'refresh-OLD', 0) });

    const result = await reconcileActive(account, [account]);
    assert.equal(result.outcome, 'adopted-main');
    assert.equal(read(VAULT).claudeAiOauth.refreshToken, 'refresh-CLI');
    assert.equal(read(MAIN).claudeAiOauth.accessToken, 'cli-new', 'the live session must be left alone');
  });

  test('puts credentials back after the CLI has cleared its own', async () => {
    // What the CLI actually does when a refresh is rejected: it does not just
    // fail, it wipes claudeAiOauth. That empty slot must lose to the vault.
    write(MAIN, { mcpOAuth: { 'srv|h': { accessToken: 'mcp-keep' } } });
    write(VAULT, { claudeAiOauth: creds('survivor', 'refresh-SURVIVOR', 0) });

    const result = await reconcileActive(account, [account]);
    assert.equal(result.outcome, 'repaired-main');
    assert.equal(read(MAIN).claudeAiOauth.accessToken, 'survivor');
    assert.equal(read(MAIN).mcpOAuth['srv|h'].accessToken, 'mcp-keep');
  });

  test('reports signed-out rather than healthy when both copies are gone', async () => {
    // Two empty slots do "agree". Calling that in-sync would leave the user
    // staring at an ACTIVE account that cannot authenticate, with no explanation.
    write(MAIN, {});
    write(VAULT, {});
    const result = await reconcileActive(account, [account]);
    assert.equal(result.outcome, 'signed-out');
    assert.match((result as { error: string }).error, /add it again/);
  });

  test('keep-warm does not rotate the active account (the regression itself)', async () => {
    // The whole bug in one assertion: the sweep that keeps unused accounts
    // signed in must not touch the account whose tokens the CLI is holding.
    const live = creds('active-token', 'refresh-ACTIVE', 0);
    write(MAIN, { claudeAiOauth: live });
    write(VAULT, { claudeAiOauth: live });

    await keepWarm([account], account.id);

    assert.equal(read(MAIN).claudeAiOauth.refreshToken, 'refresh-ACTIVE');
    assert.equal(read(VAULT).claudeAiOauth.refreshToken, 'refresh-ACTIVE');
  });

  // -------------------------------------------------------------------------
  // Proving a refresh was NOT attempted
  // -------------------------------------------------------------------------
  // "The tokens are unchanged" is too weak to guard these paths: a refresh of a
  // token this suite invented would be REJECTED, so nothing gets written and the
  // assertion holds whether or not the guard fired. The observable that actually
  // separates the two is whether the endpoint was called at all — which every
  // one of these paths reports by warning when it fails.
  //
  // It is also what keeps the file's no-network promise under a regression:
  // every credential below either has no refresh token (so refreshCredentials
  // throws before opening a socket) or belongs to a case that must not refresh.

  /** Runs `fn`, reporting whether a refresh was attempted, by the warning it logs. */
  async function watchRefreshes<T>(marker: string, fn: () => Promise<T>): Promise<{ result: T; tried: boolean }> {
    const realWarn = console.warn;
    let tried = false;
    console.warn = (...args: unknown[]) => {
      if (String(args[0] ?? '').includes(marker)) tried = true;
    };
    try {
      return { result: await fn(), tried };
    } finally {
      console.warn = realWarn;
    }
  }

  const attempted = async (fn: () => Promise<boolean>) => {
    const { result, tried } = await watchRefreshes('token freshen failed', fn);
    return { minted: result, tried };
  };

  test('keep-warm spares the signed-in account even with no active id recorded', async () => {
    // `activeId && account.id === activeId` fails OPEN: with no id recorded the
    // branch above never runs and the signed-in account arrives in the standby
    // path like any other. Nothing re-records the id on its own, so this state
    // persists — and every sweep would spend the CLI's refresh token.
    const live = { accessToken: 'active-token', expiresAt: FAR };
    write(MAIN, { claudeAiOauth: live });
    write(VAULT, { claudeAiOauth: live });

    const { tried } = await watchRefreshes('keep-warm failed', () => keepWarm([account], null));

    assert.equal(tried, false, 'the CLI is holding this refresh token — the sweep must not spend it');
    assert.equal(read(MAIN).claudeAiOauth.accessToken, 'active-token');
    assert.equal(read(VAULT).claudeAiOauth.accessToken, 'active-token');
  });

  // -------------------------------------------------------------------------
  // On-demand freshening — the standby account rotation could not see
  // -------------------------------------------------------------------------

  /** A fresh id per case: the module throttles retries per account for 10 minutes. */
  const standby = (id: string): Account => ({ ...account, id, email: `${id}@gmail.com` });

  test('freshen: a healthy standby token is left alone', async () => {
    write(MAIN, { claudeAiOauth: creds('someone-else', 'refresh-OTHER', 0) });
    write(VAULT, { claudeAiOauth: creds('standby', 'refresh-STANDBY', 0) });

    const { minted, tried } = await attempted(() => freshenAccountToken(standby('healthy')));

    assert.equal(minted, false);
    assert.equal(tried, false, 'a token good for 30 days must not be re-minted');
    assert.equal(read(VAULT).claudeAiOauth.refreshToken, 'refresh-STANDBY');
  });

  test('freshen: an expired standby token is taken to the refresh endpoint', async () => {
    // The overnight bug: this token is hours dead, the usage endpoint rejects
    // it, and rotation reads the account as having no headroom.
    write(MAIN, { claudeAiOauth: creds('someone-else', 'refresh-OTHER', 0) });
    write(VAULT, { claudeAiOauth: { accessToken: 'dead', expiresAt: Date.now() - 3600_000 } });

    const { minted, tried } = await attempted(() => freshenAccountToken(standby('expired')));

    assert.equal(tried, true, 'an expired standby token must be re-minted, not ignored');
    assert.equal(minted, false, 'no refresh token here, so the attempt fails — harmlessly');
  });

  test('freshen: an unknown expiry counts as stale rather than healthy', async () => {
    // isExpiring() answers false when expiresAt is absent. Reading that as
    // "healthy" is how an account stays invisible to rotation forever.
    write(MAIN, { claudeAiOauth: creds('someone-else', 'refresh-OTHER', 0) });
    write(VAULT, { claudeAiOauth: { accessToken: 'no-expiry-recorded' } });

    const { tried } = await attempted(() => freshenAccountToken(standby('no-expiry')));

    assert.equal(tried, true);
  });

  test('freshen: the account holding the main slot is refused, whatever the caller believed', async () => {
    // The safety net. The caller here is wrong — it has passed the account the
    // CLI is actually running on — and the answer must still be "no".
    const live: OAuthCredentials = { accessToken: 'active-token', expiresAt: Date.now() - 3600_000 };
    write(MAIN, { claudeAiOauth: live });
    write(VAULT, { claudeAiOauth: live });

    const { minted, tried } = await attempted(() => freshenAccountToken(standby('is-really-active'), { force: true }));

    assert.equal(minted, false);
    assert.equal(tried, false, 'the CLI is holding this refresh token — re-minting it ends in "Login expired"');
    assert.equal(read(MAIN).claudeAiOauth.accessToken, 'active-token');
  });

  test('freshen: distrusting the stored expiry re-mints a token that only looks healthy', async () => {
    // What a rejection from the endpoint means: our bookkeeping is wrong. The
    // expiry here is 30 days out and the token is still to be replaced.
    write(MAIN, { claudeAiOauth: creds('someone-else', 'refresh-OTHER', 0) });
    write(VAULT, { claudeAiOauth: { accessToken: 'looks-fine', expiresAt: FAR } });

    const plain = await attempted(() => freshenAccountToken(standby('lying-expiry')));
    assert.equal(plain.tried, false, 'without the rejection, the stored expiry is believed');

    const distrusted = await attempted(() =>
      freshenAccountToken(standby('lying-expiry-2'), { distrustStoredExpiry: true }));
    assert.equal(distrusted.tried, true, 'the endpoint outranks our own expiry');
  });

  test('freshen: a rejection-driven pass does not ride a plain one already in flight', async () => {
    // Sharing an in-flight pass is only right when it answers the same
    // question. The plain pass believes the stored expiry and returns "nothing
    // needed doing"; handing that answer to a caller who just watched the
    // endpoint REJECT the token silently skips the re-mint. The second call
    // below is issued in the same tick, so the first is guaranteed in flight.
    write(MAIN, { claudeAiOauth: creds('someone-else', 'refresh-OTHER', 0) });
    write(VAULT, { claudeAiOauth: { accessToken: 'looks-fine', expiresAt: FAR } });

    const acct = standby('concurrent');
    const { tried } = await attempted(async () => {
      const plain = freshenAccountToken(acct);
      const rejected = freshenAccountToken(acct, { distrustStoredExpiry: true });
      const [, second] = await Promise.all([plain, rejected]);
      return second;
    });

    assert.equal(tried, true, 'the rejection-driven pass must still reach the endpoint');
  });
});
