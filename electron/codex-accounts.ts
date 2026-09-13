// The Codex side of the account pool.
//
// Codex keeps its sign-in in `$CODEX_HOME/auth.json` (default `~/.codex`). A
// pooled Codex account is a vault directory holding a copy of that file, made
// by running `CODEX_HOME=<vault> codex login` once. Switching copies the chosen
// vault's auth.json into the real Codex home — the same "move the credentials
// into the slot the CLI reads" model the Claude pool uses with the keychain —
// after saving the outgoing login back into its own vault so its freshest
// refresh token is not lost.
//
// Identity comes from the id_token inside auth.json (a JWT): e-mail, the
// ChatGPT plan and account id. Nothing is verified — it is only used to label
// rows and to tell two logins apart.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CodexAccount } from '../shared/types';

const CODEX_BIN = process.env.CODEX_BIN || 'codex';

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Beside the Claude vaults (`~/.agentsflow/accounts`). Env override is a test seam. */
export function codexVaultRoot(): string {
  return process.env.AGENTSFLOW_CODEX_VAULTS || path.join(os.homedir(), '.agentsflow', 'codex-accounts');
}

export interface CodexIdentity {
  email?: string;
  plan?: string;
  accountId?: string;
  authMode?: string;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Pure: the identity recorded in an auth.json body, or null if it holds no sign-in. */
export function identityFromAuthJson(raw: string): CodexIdentity | null {
  let j: any;
  try { j = JSON.parse(raw); } catch { return null; }
  const tokens = j?.tokens;
  const hasApiKey = typeof j?.OPENAI_API_KEY === 'string' && j.OPENAI_API_KEY.length > 0;
  if (!tokens?.id_token && !hasApiKey) return null;
  const claims = tokens?.id_token ? decodeJwtPayload(String(tokens.id_token)) : null;
  const auth = (claims?.['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const identity: CodexIdentity = {
    email: typeof claims?.email === 'string' ? claims.email : undefined,
    plan: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined,
    accountId: typeof tokens?.account_id === 'string' ? tokens.account_id
      : typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined,
    authMode: typeof j?.auth_mode === 'string' ? j.auth_mode : hasApiKey ? 'apikey' : undefined,
  };
  return identity;
}

export function readIdentity(dir: string): CodexIdentity | null {
  try {
    return identityFromAuthJson(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Same login? The account id decides when both sides have one; else the e-mail. */
export function sameIdentity(a: CodexIdentity | null | undefined, b: CodexIdentity | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.accountId && b.accountId) return a.accountId === b.accountId;
  return Boolean(a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase());
}

// Memoised on the file's mtime: the accounts snapshot asks on every broadcast.
let currentCache: { file: string; mtimeMs: number; identity: CodexIdentity | null } | null = null;

/** Whoever is signed in to the Codex CLI right now. */
export function currentIdentity(): CodexIdentity | null {
  const file = path.join(codexHome(), 'auth.json');
  try {
    const { mtimeMs } = fs.statSync(file);
    if (currentCache && currentCache.file === file && currentCache.mtimeMs === mtimeMs) return currentCache.identity;
    const identity = identityFromAuthJson(fs.readFileSync(file, 'utf8'));
    currentCache = { file, mtimeMs, identity };
    return identity;
  } catch {
    currentCache = null;
    return null;
  }
}

/** The pooled account whose saved login is the one the CLI is using, if any. */
export function currentAccountId(pool: CodexAccount[]): string | null {
  const current = currentIdentity();
  if (!current) return null;
  return pool.find((a) => sameIdentity(current, a))?.id ?? null;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command run in the login terminal: a browser round-trip into the vault. */
export function loginCommandFor(configDir: string): string {
  return `CODEX_HOME=${q(configDir)} ${q(CODEX_BIN)} login`;
}

export interface PendingCodexAdd {
  pendingId: string;
  label?: string;
  configDir: string;
  shellId: string;
  startedAt: number;
}

const pending = new Map<string, PendingCodexAdd>();

function newVaultDir(): string {
  const root = codexVaultRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(root, 'codex-'));
}

export function beginAdd(label?: string): PendingCodexAdd {
  const pendingId = crypto.randomUUID();
  const entry: PendingCodexAdd = {
    pendingId,
    label: label?.trim().slice(0, 80) || undefined,
    configDir: newVaultDir(),
    shellId: `codex-login-${pendingId.slice(0, 8)}`,
    startedAt: Date.now(),
  };
  pending.set(pendingId, entry);
  return entry;
}

export function getPending(pendingId: string): PendingCodexAdd | undefined {
  return pending.get(pendingId);
}

export function clearPending(pendingId: string): void {
  pending.delete(pendingId);
}

export function destroyVault(configDir: string): void {
  try {
    fs.rmSync(configDir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[agentsflow][codex-accounts] vault cleanup failed', (err as Error)?.message ?? err);
  }
}

export type ProbeCodexResult =
  | { status: 'pending' }
  | { status: 'ok'; account: CodexAccount }
  | { status: 'duplicate'; error: string };

function accountFrom(identity: CodexIdentity, configDir: string, label?: string): CodexAccount {
  return {
    id: crypto.randomUUID(),
    email: identity.email || (identity.authMode === 'apikey' ? 'API key' : 'Codex login'),
    label,
    plan: identity.plan,
    accountId: identity.accountId,
    configDir,
    addedAt: new Date().toISOString(),
  };
}

/** Poll an in-progress add: pending until the browser login lands in the vault. */
export function probeAdd(pendingId: string, existing: CodexAccount[]): ProbeCodexResult {
  const entry = pending.get(pendingId);
  if (!entry) return { status: 'pending' };
  const identity = readIdentity(entry.configDir);
  if (!identity) return { status: 'pending' };
  const dupe = existing.find((a) => sameIdentity(identity, a));
  if (dupe) {
    destroyVault(entry.configDir);
    pending.delete(pendingId);
    return { status: 'duplicate', error: `This Codex login is already saved as ${dupe.label || dupe.email}. Sign in with a different ChatGPT account to add another.` };
  }
  pending.delete(pendingId);
  const account = accountFrom(identity, entry.configDir, entry.label);
  console.log('[agentsflow][codex-accounts] added', { email: account.email, plan: account.plan });
  return { status: 'ok', account };
}

/** Put the CLI's current login into the pool by copying its auth.json into a fresh vault. */
export function saveCurrentLogin(label: string | undefined, existing: CodexAccount[]): { ok: true; account: CodexAccount } | { ok: false; error: string } {
  const identity = currentIdentity();
  if (!identity) return { ok: false, error: 'Codex is not signed in. Run `codex login` first, or use “Add Codex account”.' };
  const dupe = existing.find((a) => sameIdentity(identity, a));
  if (dupe) return { ok: false, error: `The current Codex login is already saved as ${dupe.label || dupe.email}.` };
  const configDir = newVaultDir();
  try {
    fs.copyFileSync(path.join(codexHome(), 'auth.json'), path.join(configDir, 'auth.json'));
    fs.chmodSync(path.join(configDir, 'auth.json'), 0o600);
  } catch (err) {
    destroyVault(configDir);
    return { ok: false, error: `Could not copy the Codex sign-in: ${(err as Error)?.message ?? err}` };
  }
  return { ok: true, account: accountFrom(identity, configDir, label?.trim().slice(0, 80) || undefined) };
}

export interface SwitchCodexOutcome {
  // Set when the login being replaced belonged to nobody in the pool: it was
  // copied into a vault of its own first, and the caller must persist this row
  // or the user has just lost a sign-in the app never had a copy of.
  savedOutgoing?: CodexAccount;
}

/**
 * Make `account` the login the Codex CLI uses. The outgoing login is saved
 * first — back into the vault of whichever pooled account it belongs to, so
 * switching back later restores its newest tokens rather than a stale copy, or
 * into a brand-new vault when it belongs to no pooled account at all (the
 * pre-existing `codex login`, which is otherwise overwritten and gone).
 */
export function switchTo(account: CodexAccount, pool: CodexAccount[]): SwitchCodexOutcome {
  const home = codexHome();
  const mainFile = path.join(home, 'auth.json');
  const src = path.join(account.configDir, 'auth.json');
  if (!fs.existsSync(src)) throw new Error('This Codex account has no saved sign-in. Remove it and add it again.');
  const outgoing = currentIdentity();
  const owner = outgoing ? pool.find((a) => sameIdentity(outgoing, a)) : undefined;
  let savedOutgoing: CodexAccount | undefined;
  if (owner && owner.id !== account.id) {
    try { fs.copyFileSync(mainFile, path.join(owner.configDir, 'auth.json')); } catch { /* keep the vault's older copy */ }
  } else if (outgoing && !owner && !sameIdentity(outgoing, account)) {
    const saved = saveCurrentLogin('Previous login', pool);
    if (saved.ok) savedOutgoing = saved.account;
  }
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${mainFile}.agentsflow-tmp`;
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, mainFile);
  currentCache = null;
  return { savedOutgoing };
}

/** Test seam. */
export function __resetForTests(): void {
  pending.clear();
  currentCache = null;
}
