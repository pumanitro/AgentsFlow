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
import { keepWarm, reconcileActive, serviceNameFor } from './accounts';
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
});
