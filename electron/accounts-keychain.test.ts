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
import { configureTokenSource, freshenAccountToken, keepWarm, reconcileActive, serviceNameFor, switchTo } from './accounts';
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
  // A second vault, for the switch cases (created lazily by them).
  let vaultDir2 = '';
  let VAULT2 = '';
  const BACKUP = 'Claude Code-credentials-agentsflow-backup';

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
    account = { accountUuid: 'test-person', orgId: 'test-org', id: 'test-1', email: 'test@gmail.com', configDir: vaultDir, addedAt: '2026-01-01T00:00:00.000Z' };
  });

  after(() => {
    configureTokenSource(() => undefined);
    drop(MAIN);
    drop(VAULT);
    drop(BACKUP);
    if (VAULT2) drop(VAULT2);
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (vaultDir2) try { fs.rmSync(vaultDir2, { recursive: true, force: true }); } catch { /* ignore */ }
    if (realUser === undefined) delete process.env.USER;
    else process.env.USER = realUser;
  });

  test('restores the main slot when keep-warm rotated the token out from under it', async () => {
    // The reported bug, exactly: the vault holds the live chain, the main slot
    // the CLI reads is left on the token that rotation already killed. Left
    // alone, the CLI's next refresh is rejected and it demands `/login`.
    write(MAIN, { claudeAiOauth: creds('access-old', 'refresh-SPENT', 0), mcpOAuth: { 'srv|h': { accessToken: 'mcp-keep' } } });
    write(VAULT, { claudeAiOauth: creds('access-new', 'refresh-LIVE', 100) });

    const result = await reconcileActive(account, [account], () => ({ accountUuid: account.accountUuid, orgId: account.orgId }));
    assert.equal(result.outcome, 'repaired-main');
    assert.equal(read(MAIN).claudeAiOauth.refreshToken, 'refresh-LIVE');
    // Invariant 1: the main slot also holds MCP server tokens.
    assert.equal(read(MAIN).mcpOAuth['srv|h'].accessToken, 'mcp-keep');

    // And it settles — a repair that re-fires every tick would be a write loop.
    assert.equal((await reconcileActive(account, [account], () => ({ accountUuid: account.accountUuid, orgId: account.orgId }))).outcome, 'in-sync');
  });

  test('adopts the CLI\'s own rotation into the vault instead of overwriting it', async () => {
    // The other direction, and the one that must never install the vault's copy:
    // the newer token belongs to a session running right now.
    write(MAIN, { claudeAiOauth: creds('cli-new', 'refresh-CLI', 100) });
    write(VAULT, { claudeAiOauth: creds('access-old', 'refresh-OLD', 0) });

    const result = await reconcileActive(account, [account], () => ({ accountUuid: account.accountUuid, orgId: account.orgId }));
    assert.equal(result.outcome, 'adopted-main');
    assert.equal(read(VAULT).claudeAiOauth.refreshToken, 'refresh-CLI');
    assert.equal(read(MAIN).claudeAiOauth.accessToken, 'cli-new', 'the live session must be left alone');
  });

  test('puts credentials back after the CLI has cleared its own', async () => {
    // What the CLI actually does when a refresh is rejected: it does not just
    // fail, it wipes claudeAiOauth. That empty slot must lose to the vault.
    write(MAIN, { mcpOAuth: { 'srv|h': { accessToken: 'mcp-keep' } } });
    write(VAULT, { claudeAiOauth: creds('survivor', 'refresh-SURVIVOR', 0) });

    const result = await reconcileActive(account, [account], () => ({ accountUuid: account.accountUuid, orgId: account.orgId }));
    assert.equal(result.outcome, 'repaired-main');
    assert.equal(read(MAIN).claudeAiOauth.accessToken, 'survivor');
    assert.equal(read(MAIN).mcpOAuth['srv|h'].accessToken, 'mcp-keep');
  });

  test('same person in another organization is foreign and neither credential slot is overwritten', async () => {
    const other = { ...account, id: 'other-org', orgId: 'work-org' };
    write(MAIN, { claudeAiOauth: creds('work-token', 'work-refresh', 200) });
    write(VAULT, { claudeAiOauth: creds('personal-token', 'personal-refresh', 0) });
    const result = await reconcileActive(account, [account, other], () => ({ accountUuid: account.accountUuid, orgId: other.orgId }));
    assert.deepEqual(result, { outcome: 'foreign', ownerAccountId: 'other-org' });
    assert.equal(read(VAULT).claudeAiOauth.accessToken, 'personal-token');
    assert.equal(read(MAIN).claudeAiOauth.accessToken, 'work-token');
  });

  test('missing organization identity cannot merge two different credential chains', async () => {
    write(MAIN, { claudeAiOauth: creds('unknown-org-token', 'unknown-refresh', 200) });
    write(VAULT, { claudeAiOauth: creds('personal-token', 'personal-refresh', 0) });
    const result = await reconcileActive(account, [account], () => ({ accountUuid: account.accountUuid }));
    assert.equal(result.outcome, 'foreign');
    assert.equal(read(VAULT).claudeAiOauth.accessToken, 'personal-token');
  });

  test('reports signed-out rather than healthy when both copies are gone', async () => {
    // Two empty slots do "agree". Calling that in-sync would leave the user
    // staring at an ACTIVE account that cannot authenticate, with no explanation.
    write(MAIN, {});
    write(VAULT, {});
    const result = await reconcileActive(account, [account], () => ({ accountUuid: account.accountUuid, orgId: account.orgId }));
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

  // -------------------------------------------------------------------------
  // Token-slot mode — the main slot holds a one-year token, not a login
  // -------------------------------------------------------------------------
  // The token source is injected exactly as main.ts does it; every case sets
  // its own (which also forgets earlier installs), and `after` puts back the
  // default that makes every other case above behave as before.

  const tokens = new Map<string, string>();
  const tokenMode = (entries: Array<[string, string]>) => {
    tokens.clear();
    for (const [id, t] of entries) tokens.set(id, t);
    configureTokenSource((id) => tokens.get(id));
  };
  const me = () => ({ accountUuid: account.accountUuid, orgId: account.orgId });
  const YEAR = Date.now() + 365 * 864e5;
  const MCP = { 'srv|h': { accessToken: 'mcp-keep' } };

  /** A clean second vault for a switch target. Never has a .claude.json, so no switch here touches ~/.claude.json. */
  const secondVault = () => {
    if (!vaultDir2) {
      vaultDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsflow-keychain-test2-'));
      VAULT2 = serviceNameFor(vaultDir2);
    }
    drop(VAULT2);
    return vaultDir2;
  };

  test('token: main already on the token is in-sync and nothing is written', async () => {
    tokenMode([[account.id, 'TOKEN-A']]);
    // Off-contract expiry and scopes: any rewrite of main would normalise them.
    write(MAIN, { claudeAiOauth: { accessToken: 'TOKEN-A', expiresAt: 123, scopes: ['marker'] }, mcpOAuth: MCP });
    write(VAULT, { claudeAiOauth: creds('vault-access', 'refresh-VAULT', 0) });
    const mainBefore = read(MAIN);
    const vaultBefore = read(VAULT);

    const result = await reconcileActive(account, [account], me);

    assert.deepEqual(result, { outcome: 'in-sync', onToken: true });
    assert.deepEqual(read(MAIN), mainBefore);
    assert.deepEqual(read(VAULT), vaultBefore, 'the +1y token must never be adopted into the vault');
  });

  test('token: main holding the newer login keeps its refresh family in the vault, then gets the token', async () => {
    tokenMode([[account.id, 'TOKEN-A']]);
    write(MAIN, { claudeAiOauth: creds('cli-new', 'refresh-CLI', 100), mcpOAuth: MCP });
    write(VAULT, { claudeAiOauth: creds('access-old', 'refresh-OLD', 0) });

    const result = await reconcileActive(account, [account], me);

    assert.equal(result.outcome, 'installed-token');
    assert.equal(read(VAULT).claudeAiOauth.refreshToken, 'refresh-CLI', 'the live refresh family must survive the install');
    const main = read(MAIN);
    assert.equal(main.claudeAiOauth.accessToken, 'TOKEN-A');
    assert.equal(main.claudeAiOauth.refreshToken, undefined);
    assert.ok(Math.abs(main.claudeAiOauth.expiresAt - YEAR) < 864e5);
    assert.equal(main.mcpOAuth['srv|h'].accessToken, 'mcp-keep');

    // And it settles: the next tick is read-only.
    assert.deepEqual(await reconcileActive(account, [account], me), { outcome: 'in-sync', onToken: true });
  });

  test('token: an empty main gets the token; emptied again right after, it reads as rejected', async () => {
    tokenMode([[account.id, 'TOKEN-A']]);
    write(MAIN, { mcpOAuth: MCP });
    write(VAULT, { claudeAiOauth: creds('survivor', 'refresh-SURVIVOR', 0) });

    assert.equal((await reconcileActive(account, [account], me)).outcome, 'installed-token');
    assert.equal(read(MAIN).claudeAiOauth.accessToken, 'TOKEN-A');

    // What the CLI does with a token the server refuses: it clears the slot.
    write(MAIN, { mcpOAuth: MCP });
    const rejected = await reconcileActive(account, [account], me);
    assert.equal(rejected.outcome, 'token-rejected');
    assert.equal(read(MAIN).claudeAiOauth, undefined, 'the dead token must not be put back');

    // main.ts then stops offering it, and the next tick is today's repair.
    tokens.delete(account.id);
    assert.equal((await reconcileActive(account, [account], me)).outcome, 'repaired-main');
    assert.equal(read(MAIN).claudeAiOauth.refreshToken, 'refresh-SURVIVOR');
  });

  test('token: main on another pooled account\'s token is foreign, with that owner', async () => {
    const other: Account = { ...account, id: 'other-tok', accountUuid: 'other-person', email: 'other@gmail.com' };
    tokenMode([[account.id, 'TOKEN-A'], [other.id, 'TOKEN-B']]);
    write(MAIN, { claudeAiOauth: { accessToken: 'TOKEN-B', expiresAt: YEAR } });
    write(VAULT, { claudeAiOauth: creds('vault-access', 'refresh-VAULT', 0) });

    const result = await reconcileActive(account, [account, other], me);

    assert.deepEqual(result, { outcome: 'foreign', ownerAccountId: 'other-tok' });
    assert.equal(read(MAIN).claudeAiOauth.accessToken, 'TOKEN-B');
    assert.equal(read(VAULT).claudeAiOauth.accessToken, 'vault-access');
  });

  test('token: switching to a tokenised account whose stored sign-in is gone still works', async () => {
    const target: Account = {
      ...account, id: 'switch-target', accountUuid: 'switch-person', email: 'target@gmail.com',
      configDir: secondVault(), tokenExpiresAt: '2027-10-24T00:00:00.000Z', tokenScopes: ['user:inference', 'user:profile'],
    };
    tokenMode([[target.id, 'TOKEN-T']]);
    write(MAIN, { claudeAiOauth: creds('prev', 'refresh-PREV', 0), mcpOAuth: MCP });
    let switched = '';

    await switchTo(target.id, { accounts: [target], activeId: null, onSwitched: (a) => { switched = a.id; } });

    assert.equal(switched, 'switch-target');
    const main = read(MAIN);
    assert.equal(main.claudeAiOauth.accessToken, 'TOKEN-T');
    assert.equal(main.claudeAiOauth.refreshToken, undefined);
    assert.equal(main.claudeAiOauth.expiresAt, Date.parse('2027-10-24T00:00:00.000Z'));
    assert.deepEqual(main.claudeAiOauth.scopes, ['user:inference', 'user:profile']);
    assert.equal(main.mcpOAuth['srv|h'].accessToken, 'mcp-keep');
    assert.equal(read(VAULT2), null, 'the empty vault stays empty');
  });

  // The outgoing account is found the way doSwitch finds it — by the recorded
  // login in ~/.claude.json, read here (never written) for its uuid and org.
  const realLogin = (() => {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'))?.oauthAccount;
      return typeof a?.accountUuid === 'string' && typeof a?.organizationUuid === 'string'
        ? { accountUuid: a.accountUuid as string, orgId: a.organizationUuid as string } : null;
    } catch { return null; }
  })();

  test('token: switching away from a token-mode main never syncs the token into the outgoing vault',
    { skip: realLogin ? false : 'needs a recorded login in ~/.claude.json to identify the outgoing account' }, async () => {
      const outgoing: Account = { ...account, id: 'outgoing', ...realLogin! };
      const target: Account = { ...account, id: 'plain-target', accountUuid: 'plain-person', email: 'plain@gmail.com', configDir: secondVault() };
      tokenMode([[outgoing.id, 'TOKEN-OUT']]);
      // The token's +1y expiry is "newer" than any vault copy — today's
      // sync-back would copy it over the outgoing login.
      write(MAIN, { claudeAiOauth: { accessToken: 'TOKEN-OUT', expiresAt: YEAR }, mcpOAuth: MCP });
      write(VAULT, { claudeAiOauth: creds('out-access', 'refresh-OUT', 0) });
      write(VAULT2, { claudeAiOauth: creds('target-access', 'refresh-TARGET', 0) });

      await switchTo(target.id, { accounts: [outgoing, target], activeId: outgoing.id, onSwitched: () => {} });

      assert.equal(read(VAULT).claudeAiOauth.accessToken, 'out-access');
      assert.equal(read(VAULT).claudeAiOauth.refreshToken, 'refresh-OUT');
      assert.equal(read(MAIN).claudeAiOauth.accessToken, 'target-access');
      assert.equal(read(MAIN).mcpOAuth['srv|h'].accessToken, 'mcp-keep');
    });

  test('token: freshen refreshes the ACTIVE vault while main is a token — no CLI races it',
    { skip: realLogin ? false : 'needs a recorded login in ~/.claude.json to be the active account' }, async () => {
    // The recorded login's identity: without the token rule, holdsMainSlot
    // refuses this account by identity alone and the vault freezes.
    const active: Account = { ...standby('token-active'), ...realLogin! };
    tokenMode([[active.id, 'TOKEN-ACT']]);
    write(MAIN, { claudeAiOauth: { accessToken: 'TOKEN-ACT', expiresAt: YEAR } });
    // No refresh token, so the attempt fails before any socket opens.
    write(VAULT, { claudeAiOauth: { accessToken: 'vault-access', expiresAt: Date.now() - 3600_000 } });

    const { minted, tried } = await attempted(() => freshenAccountToken(active, { force: true }));

    assert.equal(tried, true, 'a refresh-less main slot must not freeze the active vault');
    assert.equal(minted, false);
    assert.equal(read(MAIN).claudeAiOauth.accessToken, 'TOKEN-ACT');
  });

  test('token: keep-warm takes the active vault down the standby branch while main is a token', async () => {
    const active = standby('token-warm');
    tokenMode([[active.id, 'TOKEN-ACT']]);
    write(MAIN, { claudeAiOauth: { accessToken: 'TOKEN-ACT', expiresAt: YEAR } });
    write(VAULT, { claudeAiOauth: { accessToken: 'vault-access', expiresAt: FAR } });

    const { tried } = await watchRefreshes('keep-warm failed', () => keepWarm([active], active.id));

    assert.equal(tried, true, 'the daily refresh the CLI no longer gives this vault');
    assert.equal(read(MAIN).claudeAiOauth.accessToken, 'TOKEN-ACT', 'the token itself is never touched');
  });
});
