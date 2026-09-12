import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CodexAccount } from '../shared/types';
import {
  __resetForTests, beginAdd, codexHome, codexVaultRoot, currentIdentity,
  identityFromAuthJson, probeAdd, readIdentity, sameIdentity, saveCurrentLogin, switchTo,
} from './codex-accounts';

// Never point a test at the real ~/.codex: both the Codex home the CLI reads
// and the vault root the pool writes are redirected into a temp tree.
function sandbox(): { home: string; vaults: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-accounts-test-'));
  const home = path.join(root, 'codex-home');
  const vaults = path.join(root, 'vaults');
  fs.mkdirSync(home, { recursive: true });
  const before = { CODEX_HOME: process.env.CODEX_HOME, AGENTSFLOW_CODEX_VAULTS: process.env.AGENTSFLOW_CODEX_VAULTS };
  process.env.CODEX_HOME = home;
  process.env.AGENTSFLOW_CODEX_VAULTS = vaults;
  __resetForTests();
  return {
    home, vaults,
    cleanup: () => {
      for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      __resetForTests();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** An unsigned JWT: only the payload is ever read, and nothing verifies it. */
function jwt(payload: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(payload)}.`;
}

function authJson(email: string, accountId: string, plan = 'pro'): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan } }),
      access_token: 'access', refresh_token: 'refresh', account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  });
}

/** A vault's saved sign-in. Read uncached, so nothing has to be invalidated. */
function writeVault(dir: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), body);
}

/** The live login. `currentIdentity()` memoises on mtime, so drop its cache. */
function writeHome(body: string): void {
  writeVault(codexHome(), body);
  __resetForTests();
}

test('identity comes out of the id_token, and a file with no sign-in yields nothing', () => {
  const s = sandbox();
  try {
    const identity = identityFromAuthJson(authJson('dev@company.com', 'acct-1', 'plus'))!;
    assert.deepEqual(identity, { email: 'dev@company.com', plan: 'plus', accountId: 'acct-1', authMode: 'chatgpt' });
    assert.equal(identityFromAuthJson('not json'), null);
    assert.equal(identityFromAuthJson('{"tokens":{}}'), null);
    const key = identityFromAuthJson('{"OPENAI_API_KEY":"sk-test"}')!;
    assert.equal(key.authMode, 'apikey');
    assert.equal(key.email, undefined);
    // A malformed id_token must not throw; the account id still comes through.
    const broken = identityFromAuthJson('{"tokens":{"id_token":"garbage","account_id":"acct-2"}}')!;
    assert.equal(broken.accountId, 'acct-2');
    assert.equal(broken.email, undefined);

    writeHome(authJson('dev@company.com', 'acct-1'));
    assert.equal(readIdentity(s.home)!.accountId, 'acct-1');
    assert.equal(currentIdentity()!.email, 'dev@company.com');
    assert.equal(readIdentity(path.join(s.home, 'missing')), null);
  } finally { s.cleanup(); }
});

test('two logins are the same one when the account id matches, else the e-mail decides', () => {
  assert.equal(sameIdentity({ accountId: 'a', email: 'x@y.z' }, { accountId: 'a', email: 'other@y.z' }), true);
  assert.equal(sameIdentity({ accountId: 'a', email: 'x@y.z' }, { accountId: 'b', email: 'x@y.z' }), false);
  assert.equal(sameIdentity({ email: 'X@Y.Z' }, { email: 'x@y.z' }), true);
  assert.equal(sameIdentity({ email: 'x@y.z' }, { accountId: 'a' }), false);
  assert.equal(sameIdentity({}, {}), false);
  assert.equal(sameIdentity(null, { accountId: 'a' }), false);
  assert.equal(sameIdentity({ accountId: 'a' }, undefined), false);
});

test('an add stays pending until the login lands, then refuses a second copy of the same account', () => {
  const s = sandbox();
  try {
    const first = beginAdd('Work');
    assert.ok(first.configDir.startsWith(codexVaultRoot()));
    assert.deepEqual(probeAdd(first.pendingId, []), { status: 'pending' });

    writeVault(first.configDir, authJson('work@company.com', 'acct-work'));
    const ok = probeAdd(first.pendingId, []);
    assert.equal(ok.status, 'ok');
    assert.ok(ok.status === 'ok');
    assert.equal(ok.account.email, 'work@company.com');
    assert.equal(ok.account.plan, 'pro');
    assert.equal(ok.account.accountId, 'acct-work');
    assert.equal(ok.account.label, 'Work');
    const pool = [ok.account];

    const second = beginAdd();
    writeVault(second.configDir, authJson('work@company.com', 'acct-work'));
    const dupe = probeAdd(second.pendingId, pool);
    assert.equal(dupe.status, 'duplicate');
    assert.equal(fs.existsSync(second.configDir), false); // The half-made vault is torn back down.
    assert.deepEqual(probeAdd(second.pendingId, pool), { status: 'pending' }); // Already consumed.
    assert.deepEqual(probeAdd('never-started', pool), { status: 'pending' });
  } finally { s.cleanup(); }
});

test('switching copies the chosen vault into the Codex home and rescues an unpooled outgoing login', () => {
  const s = sandbox();
  try {
    const target = beginAdd('Second');
    writeVault(target.configDir, authJson('second@company.com', 'acct-second'));
    const added = probeAdd(target.pendingId, []);
    assert.ok(added.status === 'ok');
    const account = added.account;

    // The login already in place belongs to no pooled account.
    writeHome(authJson('original@company.com', 'acct-original'));
    const outcome = switchTo(account, [account]);

    assert.equal(currentIdentity()!.accountId, 'acct-second');
    assert.equal(readIdentity(codexHome())!.email, 'second@company.com');
    assert.ok(outcome.savedOutgoing, 'the outgoing login must be saved before it is overwritten');
    const saved = outcome.savedOutgoing as CodexAccount;
    assert.equal(saved.email, 'original@company.com');
    assert.equal(saved.label, 'Previous login');
    assert.equal(readIdentity(saved.configDir)!.accountId, 'acct-original');
    assert.equal((fs.statSync(path.join(codexHome(), 'auth.json')).mode & 0o777), 0o600);

    // Switching back writes the now-current login into its own pooled vault
    // rather than making a second "Previous login" row.
    __resetForTests();
    const back = switchTo(saved, [account, saved]);
    assert.equal(back.savedOutgoing, undefined);
    assert.equal(currentIdentity()!.accountId, 'acct-original');
    assert.equal(readIdentity(account.configDir)!.accountId, 'acct-second');
  } finally { s.cleanup(); }
});

test('a vault with no saved sign-in is refused instead of clearing the current login', () => {
  const s = sandbox();
  try {
    writeHome(authJson('original@company.com', 'acct-original'));
    const empty: CodexAccount = { id: 'x', email: 'gone@company.com', configDir: path.join(s.vaults, 'nothing'), addedAt: new Date().toISOString() };
    assert.throws(() => switchTo(empty, [empty]), /no saved sign-in/);
    assert.equal(currentIdentity()!.accountId, 'acct-original');
  } finally { s.cleanup(); }
});

test('the current login can be pooled by hand, once', () => {
  const s = sandbox();
  try {
    assert.deepEqual(saveCurrentLogin('Main', []), { ok: false, error: 'Codex is not signed in. Run `codex login` first, or use “Add Codex account”.' });
    writeHome(authJson('main@company.com', 'acct-main'));
    const saved = saveCurrentLogin('Main', []);
    assert.ok(saved.ok);
    assert.equal(saved.account.email, 'main@company.com');
    assert.equal(readIdentity(saved.account.configDir)!.accountId, 'acct-main');
    const again = saveCurrentLogin('Main again', [saved.account]);
    assert.equal(again.ok, false);
    assert.ok(!again.ok && /already saved/.test(again.error));
  } finally { s.cleanup(); }
});
