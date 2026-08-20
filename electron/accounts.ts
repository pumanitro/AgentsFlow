// Switchable pool of Anthropic accounts.
//
// The problem: one account's 5-hour session window runs out, and the only way
// back to work is `/login` in the CLI plus a browser round-trip. The fix here is
// to sign each account in ONCE, into its own isolated credential home, and then
// switch between them by moving credentials into the single keychain slot Claude
// Code actually reads. A switch is a keychain write — no browser, no login.
//
// How the isolation works (verified against CLI 2.1.220, not assumed):
//   • Claude Code reads OAuth credentials from keychain service
//     "Claude Code-credentials", account = $USER.
//   • With CLAUDE_CONFIG_DIR set, that service name gains a suffix derived from
//     the config dir: `Claude Code-credentials-<sha256(NFC(dir)).hex[0..8]>`,
//     and the config JSON moves to `<dir>/.claude.json`. So each config dir is
//     a completely separate login.
// We exploit that twice: as the per-account vault, and as the switch mechanism.
//
// CONSEQUENCE — `configDir` is permanent. The keychain slot name is derived from
// the path, so moving or renaming a vault dir orphans that account's credentials
// and forces a fresh login. Never "tidy up" these paths.
//
// Three invariants this module must never break:
//   1. The main slot's JSON also holds `mcpOAuth` (tokens for MCP servers, which
//      are NOT account-scoped). Every write MERGES — only `claudeAiOauth` is
//      ever replaced. Overwriting wholesale would silently sign the user out of
//      every OAuth MCP server they use.
//   2. Before overwriting the main slot we sync it back to the outgoing
//      account's vault, so a token rotation that happened while it was active is
//      preserved. Skipping this strands the vault on a dead refresh token.
//   3. The ACTIVE account's credentials exist in two slots at once — the main
//      one and its own vault — and a refresh invalidates the token it was bought
//      with. So only ONE party may ever refresh them: the CLI. We mirror; we do
//      not rotate behind its back. See "Reconciliation" below, which is the
//      whole of the fix for the "Login expired · Please run /login" bug.
//
// Nothing here logs token material — accounts are identified in logs by email
// and uuid only.

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import type { Account, ProbeAccountResult } from '../shared/types';

const MAIN_SERVICE = 'Claude Code-credentials';
// Pre-switch snapshot of the main slot. Lives in the keychain rather than a file
// so recovery never puts a token on disk.
const BACKUP_SERVICE = 'Claude Code-credentials-agentsflow-backup';

// Claude Code's public OAuth client, and the endpoint that exchanges a refresh
// token for a fresh access token. Both extracted from the CLI itself.
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// Refresh when the access token has less than this left. Access tokens live ~3h.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
// Refresh tokens are good for ~30 days and each use resets that clock, so a
// daily sweep keeps every pooled account permanently signed in.
const KEEP_WARM_INTERVAL_MS = 24 * 60 * 60 * 1000;

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

// ---------------------------------------------------------------------------
// Keychain naming — must match the CLI exactly or we read/write the wrong slot
// ---------------------------------------------------------------------------

/**
 * The keychain service name Claude Code uses for a given config dir. Pass
 * undefined for the default (`~/.claude`) home, which carries no suffix.
 * Mirrors the CLI: `Claude Code-credentials` + `-sha256(NFC(dir))[0..8]`.
 */
export function serviceNameFor(configDir?: string | null): string {
  if (!configDir) return MAIN_SERVICE;
  const normalized = configDir.normalize('NFC');
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 8);
  return `${MAIN_SERVICE}-${hash}`;
}

/** The keychain *account* the CLI files credentials under. */
export function keychainAccount(): string {
  let user: string;
  try {
    user = process.env.USER || os.userInfo().username;
  } catch {
    user = 'claude-code-user';
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user';
}

// ---------------------------------------------------------------------------
// Small process/HTTP helpers
// ---------------------------------------------------------------------------

function execFileP(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function httpPostForm(url: string, form: Record<string, string>): Promise<{ status: number; body: string }> {
  const payload = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'application/json',
        },
        timeout: 15_000,
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

// ---------------------------------------------------------------------------
// Keychain slot access
// ---------------------------------------------------------------------------

/** Full JSON blob of a keychain slot (claudeAiOauth + mcpOAuth + anything else). */
async function readSlotRaw(service: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await execFileP('security', ['find-generic-password', '-a', keychainAccount(), '-s', service, '-w'], 5000);
    const parsed = JSON.parse(raw.trim());
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function writeSlotRaw(service: string, blob: Record<string, unknown>): Promise<void> {
  await execFileP('security', [
    'add-generic-password', '-U',
    '-a', keychainAccount(),
    '-s', service,
    '-w', JSON.stringify(blob),
  ], 8000);
}

async function deleteSlot(service: string): Promise<void> {
  try {
    await execFileP('security', ['delete-generic-password', '-a', keychainAccount(), '-s', service], 5000);
  } catch {
    /* already gone */
  }
}

function parseOAuth(blob: Record<string, unknown> | null): OAuthCredentials | null {
  const o = blob?.claudeAiOauth as Record<string, unknown> | undefined;
  if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return null;
  return {
    accessToken: o.accessToken,
    refreshToken: typeof o.refreshToken === 'string' ? o.refreshToken : undefined,
    expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : undefined,
    refreshTokenExpiresAt: typeof o.refreshTokenExpiresAt === 'number' ? o.refreshTokenExpiresAt : undefined,
    scopes: Array.isArray(o.scopes) ? (o.scopes as string[]) : undefined,
    subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : undefined,
    rateLimitTier: typeof o.rateLimitTier === 'string' ? o.rateLimitTier : undefined,
  };
}

/**
 * Replace ONLY `claudeAiOauth` in a slot, preserving every sibling key.
 * See invariant (1) at the top of the file — `mcpOAuth` lives here too.
 */
export function mergeOAuthInto(
  existing: Record<string, unknown> | null,
  oauth: OAuthCredentials,
): Record<string, unknown> {
  return { ...(existing ?? {}), claudeAiOauth: oauth };
}

async function writeOAuthToSlot(service: string, oauth: OAuthCredentials): Promise<void> {
  const existing = await readSlotRaw(service);
  await writeSlotRaw(service, mergeOAuthInto(existing, oauth));
}

/** Credentials of a pooled account, straight from its own vault slot. */
export async function readAccountCreds(account: Account): Promise<OAuthCredentials | null> {
  return parseOAuth(await readSlotRaw(serviceNameFor(account.configDir)));
}

// ---------------------------------------------------------------------------
// Token refresh — headless, no browser
// ---------------------------------------------------------------------------

function isExpiring(creds: OAuthCredentials): boolean {
  if (!creds.expiresAt) return false;
  return creds.expiresAt - Date.now() < REFRESH_SKEW_MS;
}

/**
 * Exchange the refresh token for a fresh access token. The response rotates the
 * refresh token too, so the caller MUST persist the result or the account is
 * left holding a spent one.
 */
export async function refreshCredentials(creds: OAuthCredentials): Promise<OAuthCredentials> {
  if (!creds.refreshToken) throw new Error('no refresh token stored for this account');
  const form: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: creds.refreshToken,
  };
  if (creds.scopes?.length) form.scope = creds.scopes.join(' ');

  const resp = await httpPostForm(TOKEN_URL, form);
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`token refresh rejected (HTTP ${resp.status})`);
  }
  let json: any;
  try {
    json = JSON.parse(resp.body);
  } catch {
    throw new Error('token refresh returned unparseable data');
  }
  if (typeof json?.access_token !== 'string') throw new Error('token refresh returned no access token');

  const expiresIn = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : creds.refreshToken,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
    // The refresh response doesn't restate these, so carry the stored values.
    refreshTokenExpiresAt: creds.refreshTokenExpiresAt,
    scopes: typeof json.scope === 'string' ? json.scope.split(' ') : creds.scopes,
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
  };
}

/** Refresh-if-needed, persisting any rotation back into the account's vault. */
export async function ensureFresh(account: Account, creds: OAuthCredentials): Promise<OAuthCredentials> {
  if (!isExpiring(creds)) return creds;
  const fresh = await refreshCredentials(creds);
  await writeOAuthToSlot(serviceNameFor(account.configDir), fresh);
  console.log('[agentsflow][accounts] refreshed token', { email: account.email });
  return fresh;
}

// ---------------------------------------------------------------------------
// On-demand freshen — how a STANDBY account stays readable around the clock
// ---------------------------------------------------------------------------
// Access tokens live only a few hours; the daily keep-warm sweep exists for the
// 30-day refresh token, not for them. So by night every standby account's token
// is dead, the usage endpoint rejects it, and rotation reads "no other account
// is below 95%" while accounts with real headroom sit unreadable (2026-08-20).
// Refreshing at the moment a meter is about to be read closes that hole.
//
// MUST NOT re-mint the ACTIVE account's token: the CLI holds the main-slot copy
// of its refresh token, and rotating it under a running session is the exact
// sequence that ends in "Login expired". The active vault stays fresh via
// mirroring instead. Callers pass their idea of which account is active, but
// the invariant does not rely on them — an account whose credentials ARE the
// ones in the main slot is refused here, whatever the caller believed.

// A refresh that failed must not be retried on every 60s tick all night.
const FRESHEN_RETRY_MS = 10 * 60 * 1000;

/** A pass in flight, tagged with whether it doubts the stored expiry. */
interface FreshenRun { p: Promise<boolean>; distrust: boolean }

const freshenInflight = new Map<string, FreshenRun>();
const freshenFailedAt = new Map<string, number>();
const freshenDistrustedAt = new Map<string, number>();

/**
 * Whether these are the credentials the CLI is running on — the one account
 * whose refresh token must never be re-minted behind its back.
 *
 * Asked two ways because either alone has a hole. Identity is definitive but
 * absent for an account added before the pool recorded uuids; the token
 * comparison catches the mirrored copy but not one that has already diverged
 * (the CLI rotated main and our vault copy is stale). Together they cover
 * every case a caller's `activeId` could be wrong about.
 */
async function holdsMainSlot(account: Account, creds: OAuthCredentials): Promise<boolean> {
  const signedInAs = cachedLoginAccountUuid();
  if (signedInAs && account.accountUuid === signedInAs) return true;
  return sameCreds(parseOAuth(await readSlotRaw(MAIN_SERVICE)), creds);
}

/**
 * Positive proof that this account is NOT the login the CLI is running on.
 *
 * For the caller that has no recorded active account and must still decide.
 * Absence of proof is never proof: an unknown uuid on either side answers
 * false, which callers must read as "leave this one alone". Token equality is
 * deliberately not consulted here — it goes stale the moment the CLI rotates
 * its own copy, and a stale comparison is exactly how the active account gets
 * mistaken for a standby one.
 */
export function provablyNotTheLogin(account: Account): boolean {
  const signedInAs = cachedLoginAccountUuid();
  return Boolean(signedInAs && account.accountUuid && account.accountUuid !== signedInAs);
}

export interface FreshenOptions {
  /** Retry through the post-failure back-off (a manual refresh, an urgent pass). */
  force?: boolean;
  /**
   * Re-mint even though the stored expiry still looks valid. For use after the
   * server has actually rejected the token — a rejection outranks our own
   * bookkeeping, which is the only witness `isExpiring` consults.
   */
  distrustStoredExpiry?: boolean;
}

/**
 * Make a standby account's access token usable if it isn't. Returns whether a
 * new token was actually minted, so a caller can tell "nothing needed doing"
 * from "try that read again".
 *
 * Failures are swallowed: the caller is about to read usage, and a failed
 * refresh simply leaves that read unreadable — as it was before, minus the
 * silence in the log.
 */
export function freshenAccountToken(account: Account, opts: FreshenOptions = {}): Promise<boolean> {
  const { force = false, distrustStoredExpiry = false } = opts;
  const running = freshenInflight.get(account.id);
  if (running) {
    // Sharing a pass in flight is right only when it answers the same question.
    // A plain freshen BELIEVES the stored expiry, which is the one thing a
    // rejection-driven pass exists to doubt — riding it would return its
    // "nothing needed doing" and silently skip the re-mint that the endpoint
    // just told us was needed. Wait for it instead, then ask properly.
    if (!distrustStoredExpiry || running.distrust) return running.p;
    return running.p.then((minted) => (minted ? true : freshenAccountToken(account, opts)));
  }
  if (!force && Date.now() - (freshenFailedAt.get(account.id) ?? 0) < FRESHEN_RETRY_MS) {
    return Promise.resolve(false);
  }
  // Distrusting the stored expiry means nothing else limits the rate, so this
  // path carries its own back-off: otherwise a token the server keeps refusing
  // for some other reason would be re-minted on every tick all night.
  if (distrustStoredExpiry && Date.now() - (freshenDistrustedAt.get(account.id) ?? 0) < FRESHEN_RETRY_MS) {
    return Promise.resolve(false);
  }

  const p = (async () => {
    try {
      const creds = await readAccountCreds(account);
      if (!creds) return false;
      // No stored expiry at all means we cannot forecast; treat that as stale
      // rather than as healthy, or the account stays invisible forever.
      if (!distrustStoredExpiry && creds.expiresAt && !isExpiring(creds)) return false;

      // The safety net for the invariant above, independent of any caller.
      if (await holdsMainSlot(account, creds)) return false;

      if (distrustStoredExpiry) freshenDistrustedAt.set(account.id, Date.now());
      const fresh = await refreshCredentials(creds);
      await writeOAuthToSlot(serviceNameFor(account.configDir), fresh);
      freshenFailedAt.delete(account.id);
      console.log('[agentsflow][accounts] freshened a standby token', {
        email: account.email,
        afterRejection: distrustStoredExpiry,
      });
      return true;
    } catch (err) {
      freshenFailedAt.set(account.id, Date.now());
      console.warn('[agentsflow][accounts] token freshen failed — meters stay unreadable', {
        email: account.email,
        error: (err as Error)?.message ?? String(err),
      });
      return false;
    }
  })().finally(() => { freshenInflight.delete(account.id); });
  freshenInflight.set(account.id, { p, distrust: distrustStoredExpiry });
  return p;
}

// ---------------------------------------------------------------------------
// ~/.claude.json — swap the recorded account identity alongside the tokens
// ---------------------------------------------------------------------------

function mainConfigJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

function vaultConfigJsonPath(configDir: string): string {
  return path.join(configDir, '.claude.json');
}

/**
 * The CLI guards `.claude.json` with a mkdir-based mutex. Honour it so we never
 * interleave with a concurrent CLI write. A lock older than STALE_MS is assumed
 * abandoned (a crashed CLI would otherwise block switching forever).
 */
async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockDir = `${mainConfigJsonPath()}.lock`;
  const STALE_MS = 10_000;
  const DEADLINE_MS = 5_000;
  const start = Date.now();
  let held = false;
  while (Date.now() - start < DEADLINE_MS) {
    try {
      fs.mkdirSync(lockDir);
      held = true;
      break;
    } catch {
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {
        continue; // vanished between mkdir and stat — retry immediately
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    if (held) {
      try { fs.rmdirSync(lockDir); } catch { /* someone else cleaned up */ }
    }
  }
}

/**
 * Copy `oauthAccount` from the target vault's config into the main one, leaving
 * every other key of that (large) file untouched. Exported for testing.
 */
export function mergeOAuthAccount(mainJson: any, vaultJson: any): any {
  const account = vaultJson?.oauthAccount;
  if (!account) return mainJson;
  return { ...mainJson, oauthAccount: account };
}

async function patchMainConfigIdentity(configDir: string): Promise<void> {
  let vaultJson: any = null;
  try {
    vaultJson = JSON.parse(fs.readFileSync(vaultConfigJsonPath(configDir), 'utf8'));
  } catch {
    return; // vault has no recorded identity — tokens alone still switch fine
  }
  if (!vaultJson?.oauthAccount) return;

  await withConfigLock(async () => {
    const target = mainConfigJsonPath();
    let mainJson: any = {};
    try {
      mainJson = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      mainJson = {};
    }
    const merged = mergeOAuthAccount(mainJson, vaultJson);
    const tmp = `${target}.agentsflow.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
    fs.renameSync(tmp, target);
  });
}

// ---------------------------------------------------------------------------
// Vault lifecycle
// ---------------------------------------------------------------------------

export function vaultRoot(): string {
  return path.join(os.homedir(), '.agentsflow', 'accounts');
}

// Any real address, not just gmail.com: a Google Workspace account signs in
// through the same Google flow but carries its own domain, and Anthropic logins
// are not Google-bound anyway. Shape-check only — whether the address can
// actually authorise is settled by the login itself, not by a regex.
const EMAIL_RE = /^[a-zA-Z0-9._%+'-]+@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

/** Address shape, checked before anything is created. */
export function isEmailAddress(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

/** Filesystem-safe, collision-resistant vault directory name for an address. */
export function slugForEmail(email: string): string {
  const local = email.trim().toLowerCase().replace(/@.*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hash = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').substring(0, 6);
  return `${local || 'account'}-${hash}`;
}

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  orgId?: string;
  subscriptionType?: string;
}

export function parseAuthStatus(stdout: string): AuthStatus {
  try {
    const j = JSON.parse(stdout.trim());
    return {
      loggedIn: Boolean(j?.loggedIn),
      email: typeof j?.email === 'string' ? j.email : undefined,
      orgId: typeof j?.orgId === 'string' ? j.orgId : undefined,
      subscriptionType: typeof j?.subscriptionType === 'string' ? j.subscriptionType : undefined,
    };
  } catch {
    return { loggedIn: false };
  }
}

/**
 * `claude auth status --json` scoped to a vault via CLAUDE_CONFIG_DIR — this is
 * the login-completed signal the add flow polls on.
 */
export function authStatusIn(configDir: string): Promise<AuthStatus> {
  return new Promise((resolve) => {
    execFile(
      CLAUDE_BIN,
      ['auth', 'status', '--json'],
      {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, NO_COLOR: '1' },
      },
      (err, stdout) => {
        if (err && !stdout) resolve({ loggedIn: false });
        else resolve(parseAuthStatus(stdout));
      },
    );
  });
}

/** The `accountUuid` a vault recorded at login — the duplicate-detection key. */
export function readVaultAccountUuid(configDir: string): string | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(vaultConfigJsonPath(configDir), 'utf8'));
    const uuid = j?.oauthAccount?.accountUuid;
    return typeof uuid === 'string' ? uuid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The account Claude Code is signed in as right now. Lets a freshly added
 * account be recognised as already-active when it happens to be the login that
 * predates the pool — otherwise the pool would look like nobody is signed in
 * until the user pointlessly switches to the account they are already on.
 */
export function currentLoginAccountUuid(): string | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(mainConfigJsonPath(), 'utf8'));
    const uuid = j?.oauthAccount?.accountUuid;
    return typeof uuid === 'string' ? uuid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Same, memoised on the file's mtime. `~/.claude.json` is a large file that the
 * CLI rewrites constantly, and the reconcile loop below asks this question on a
 * timer — parsing megabytes every tick to answer "still the same account?" is
 * exactly the kind of thing that shows up in the perf log as a stall.
 */
let identityCache: { mtimeMs: number; uuid?: string } | null = null;
function cachedLoginAccountUuid(): string | undefined {
  try {
    const { mtimeMs } = fs.statSync(mainConfigJsonPath());
    if (identityCache && identityCache.mtimeMs === mtimeMs) return identityCache.uuid;
    const uuid = currentLoginAccountUuid();
    identityCache = { mtimeMs, uuid };
    return uuid;
  } catch {
    return undefined;
  }
}

/** The command run in the login terminal. One browser round-trip, once ever. */
export function loginCommandFor(configDir: string, email: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `CLAUDE_CONFIG_DIR=${q(configDir)} ${CLAUDE_BIN} auth login --email ${q(email)}`;
}

export function createVaultDir(email: string): string {
  const dir = path.join(vaultRoot(), slugForEmail(email));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Remove a vault directory and its keychain slot — used on reject and remove. */
export async function destroyVault(configDir: string): Promise<void> {
  await deleteSlot(serviceNameFor(configDir));
  try {
    fs.rmSync(configDir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[agentsflow][accounts] vault cleanup failed', (err as Error)?.message ?? err);
  }
}

/**
 * Decide whether a just-completed login may join the pool. Rejects the two ways
 * a browser already signed into another account silently returns the wrong one.
 * Pure, so the policy is unit-testable.
 */
export function evaluateLogin(opts: {
  status: AuthStatus;
  expectedEmail: string;
  accountUuid?: string;
  existing: Account[];
}): { verdict: 'pending' } | { verdict: 'ok' } | { verdict: 'mismatch' | 'duplicate'; error: string } {
  const { status, expectedEmail, accountUuid, existing } = opts;
  if (!status.loggedIn) return { verdict: 'pending' };

  const got = (status.email ?? '').trim().toLowerCase();
  const want = expectedEmail.trim().toLowerCase();
  if (got && got !== want) {
    return {
      verdict: 'mismatch',
      error: `That browser was signed in as ${status.email}, not ${expectedEmail}. Sign out of claude.ai (or use an incognito window / separate Chrome profile) and try again.`,
    };
  }
  if (accountUuid && existing.some((a) => a.accountUuid && a.accountUuid === accountUuid)) {
    const dupe = existing.find((a) => a.accountUuid === accountUuid)!;
    return {
      verdict: 'duplicate',
      error: `This authorised the same Anthropic account as ${dupe.email}, so it would not add any headroom. Use an incognito window or a separate Chrome profile to sign in as a different account.`,
    };
  }
  return { verdict: 'ok' };
}

// ---------------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------------

let switchInFlight: Promise<Account> | null = null;

export interface SwitchDeps {
  accounts: Account[];
  activeId: string | null;
  onSwitched: (account: Account) => void;
}

/**
 * Move `target`'s credentials into the slot Claude Code reads.
 *
 * Ordered so that a failure at any step leaves the current account working:
 * sync-back → backup → refresh → write → verify → identity → commit.
 */
export async function switchTo(targetId: string, deps: SwitchDeps): Promise<Account> {
  if (switchInFlight) throw new Error('a switch is already in progress');
  const run = doSwitch(targetId, deps).finally(() => { switchInFlight = null; });
  switchInFlight = run;
  return run;
}

async function doSwitch(targetId: string, deps: SwitchDeps): Promise<Account> {
  const target = deps.accounts.find((a) => a.id === targetId);
  if (!target) throw new Error('account not found');

  // Switching to the account already in the main slot is a reconcile, not a
  // switch: its vault copy may well be the older of the two, and installing that
  // over the CLI's live token would break the very session doing the asking.
  if (deps.activeId === target.id) {
    await reconcileActive(target, deps.accounts);
    deps.onSwitched(target);
    return target;
  }

  const targetService = serviceNameFor(target.configDir);
  let targetCreds = parseOAuth(await readSlotRaw(targetService));
  if (!targetCreds) {
    throw new Error(`${target.email} is not signed in any more — remove it and add it again.`);
  }

  // 1. Sync-back: whatever the CLI rotated into the main slot belongs to the
  //    outgoing account. Losing it would strand that vault on a spent token.
  //    Only when main is genuinely the newer copy, though — a main slot that has
  //    gone stale must not be allowed to overwrite live credentials on its way
  //    out, which would turn one broken account into two.
  const mainBlob = await readSlotRaw(MAIN_SERVICE);
  const mainCreds = parseOAuth(mainBlob);
  const outgoing = deps.activeId ? deps.accounts.find((a) => a.id === deps.activeId) : undefined;
  if (mainCreds && outgoing && outgoing.id !== target.id) {
    const outgoingService = serviceNameFor(outgoing.configDir);
    const outgoingVault = parseOAuth(await readSlotRaw(outgoingService));
    if (newerCreds(mainCreds, outgoingVault) === 'main') {
      await writeOAuthToSlot(outgoingService, mainCreds);
    }
  }

  // 2. Backup — recovery without ever writing a token to disk.
  if (mainBlob) await writeSlotRaw(BACKUP_SERVICE, mainBlob);

  // 3. Refresh if the stored token is stale. Abort the whole switch on failure
  //    so we never install credentials that would 401 on first use.
  targetCreds = await ensureFresh(target, targetCreds);

  // 4. Write — merging, so MCP server tokens in the same blob survive.
  await writeSlotRaw(MAIN_SERVICE, mergeOAuthInto(mainBlob, targetCreds));

  // 5. Verify the slot really holds what we intended before committing.
  const readback = parseOAuth(await readSlotRaw(MAIN_SERVICE));
  if (!readback || readback.accessToken !== targetCreds.accessToken) {
    if (mainBlob) await writeSlotRaw(MAIN_SERVICE, mainBlob); // put it back
    throw new Error('keychain write could not be verified — nothing was changed');
  }

  // 6. Swap the recorded identity so the CLI agrees about who is signed in.
  await patchMainConfigIdentity(target.configDir);

  console.log('[agentsflow][accounts] switched', {
    to: target.email,
    uuid: target.accountUuid,
    from: outgoing?.email ?? '(pre-existing login)',
  });
  deps.onSwitched(target);
  return target;
}

// ---------------------------------------------------------------------------
// Reconciliation — keeping the active account's two copies in agreement
// ---------------------------------------------------------------------------
//
// THE BUG THIS EXISTS TO KILL. While an account is active its credentials sit
// in two keychain slots: the main one, which the Claude Code CLI both reads and
// WRITES, and its own vault. A refresh mints a new access token *and* rotates
// the refresh token, invalidating the one it was bought with. So the instant
// those two copies diverge, one of them holds a refresh token that is already
// dead server-side — and if that one is the main slot, the CLI's next refresh is
// rejected, at which point it does not merely fail: it CLEARS its stored
// credentials and prints "Login expired · Please run /login".
//
// That is precisely what the old keep-warm sweep did. It refreshed every pooled
// account including the active one, through the vault, leaving the CLI holding a
// spent token — a time bomb armed 60s after every launch (which is why "close
// and reopen the app" was the reliable way to trigger it) and detonating up to
// eight hours later when the access token finally expired. The only repair was
// switching away and back, because doSwitch is the one path that copies the
// vault's live tokens into the main slot.
//
// The rule that makes it safe: FOR THE ACTIVE ACCOUNT THE MAIN SLOT IS THE
// SOURCE OF TRUTH AND THE VAULT IS A MIRROR. We never rotate its tokens behind
// the CLI's back — we only copy the newer of the two copies over the older one,
// in whichever direction that turns out to be, so they can never disagree for
// longer than one tick.

/** The same login state — same tokens, so neither copy can be the spent one. */
export function sameCreds(a: OAuthCredentials | null, b: OAuthCredentials | null): boolean {
  if (!a || !b) return a === b;
  return a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
}

/**
 * Which copy was refreshed most recently — equivalently, which one's refresh
 * token is still live. Every refresh mints an access token with a later expiry
 * and kills the token that bought it, so "later `expiresAt`" is exactly the test.
 *
 * Ties and missing expiries go to main. The CLI is the only other writer, and
 * when we cannot tell who is newer, deferring to it is the answer that cannot
 * break a session that is running right now.
 */
export function newerCreds(
  main: OAuthCredentials | null,
  vault: OAuthCredentials | null,
): 'main' | 'vault' | 'neither' {
  if (!main && !vault) return 'neither';
  if (!main) return 'vault';
  if (!vault) return 'main';
  return (vault.expiresAt ?? 0) > (main.expiresAt ?? 0) ? 'vault' : 'main';
}

export type ReconcileResult =
  /** The two copies already agree — the overwhelmingly common case, and free. */
  | { outcome: 'in-sync' }
  /** The CLI rotated the tokens; the vault has been re-mirrored from main. */
  | { outcome: 'adopted-main' }
  /** Main was stale or wiped; the live credentials have been put back. */
  | { outcome: 'repaired-main' }
  /** Main belongs to a login that is not the account we think is active. */
  | { outcome: 'foreign'; ownerAccountId?: string }
  /** Neither copy has credentials left — only a real sign-in fixes this. */
  | { outcome: 'signed-out'; error: string }
  /** We knew what to do and could not do it (keychain refused the write). */
  | { outcome: 'failed'; error: string };

/**
 * Bring the active account's two copies back into agreement, repairing the main
 * slot when it is the stale one. This is the "switch away and back" the user had
 * to do by hand, done automatically and in the correct direction.
 *
 * Read-only on the happy path: two keychain reads and nothing else, so it is
 * cheap enough to run on a timer.
 */
let reconcileChain: Promise<void> = Promise.resolve();

export function reconcileActive(account: Account, pool: Account[] = []): Promise<ReconcileResult> {
  // Serialised: the minute timer and the daily keep-warm sweep both land here,
  // and each pass is a read-then-write. Interleaving two of them could decide
  // "vault is newer" against a main slot the other one has already repaired.
  const run = reconcileChain.then(() => doReconcile(account, pool));
  reconcileChain = run.then(() => undefined, () => undefined);
  return run;
}

async function doReconcile(account: Account, pool: Account[]): Promise<ReconcileResult> {
  const vaultService = serviceNameFor(account.configDir);
  const mainBlob = await readSlotRaw(MAIN_SERVICE);
  const mainCreds = parseOAuth(mainBlob);
  const vaultCreds = parseOAuth(await readSlotRaw(vaultService));

  const source = newerCreds(mainCreds, vaultCreds);
  // Tested before the agreement check below: two empty slots technically agree,
  // and calling that "in sync" would report an account with no credentials
  // anywhere as perfectly healthy — the one state that does need the user.
  if (source === 'neither') {
    return {
      outcome: 'signed-out',
      error: `${account.email} has no stored credentials any more. Remove it and add it again.`,
    };
  }
  if (sameCreds(mainCreds, vaultCreds)) return { outcome: 'in-sync' };

  // Only past this point do we write anything, and a write to the wrong account
  // is worse than the divergence we came to fix — so this is where (and only
  // where) it is worth reading the recorded identity.
  const loginUuid = cachedLoginAccountUuid();
  if (loginUuid && account.accountUuid && loginUuid !== account.accountUuid) {
    const owner = pool.find((a) => a.accountUuid === loginUuid);
    return { outcome: 'foreign', ownerAccountId: owner?.id };
  }

  switch (source) {
    case 'main':
      // The CLI refreshed while it was active — adopt that into the vault so a
      // later switch back to this account does not install a spent token.
      await writeOAuthToSlot(vaultService, mainCreds!);
      return { outcome: 'adopted-main' };

    case 'vault': {
      // Main is stranded (stale, or cleared by the CLI after a rejected
      // refresh). The vault holds the live chain, so put it back.
      let creds = vaultCreds!;
      try {
        // Hand the CLI something usable *now* rather than something it has to
        // refresh on first use — it just failed doing exactly that.
        creds = await ensureFresh(account, creds);
      } catch (err) {
        console.warn('[agentsflow][accounts] could not pre-refresh during repair', {
          email: account.email,
          error: (err as Error)?.message ?? String(err),
        });
      }
      await writeSlotRaw(MAIN_SERVICE, mergeOAuthInto(mainBlob, creds));
      const readback = parseOAuth(await readSlotRaw(MAIN_SERVICE));
      if (!readback || readback.accessToken !== creds.accessToken) {
        return { outcome: 'failed', error: 'The keychain would not accept the restored credentials.' };
      }
      await patchMainConfigIdentity(account.configDir);
      console.log('[agentsflow][accounts] repaired the signed-in credentials', { email: account.email });
      return { outcome: 'repaired-main' };
    }
  }
}

// The loop. Runs in the main process so it keeps the login healthy with the
// window closed — the same reason rotation lives there.
const SYNC_INTERVAL_MS = 60_000;

export interface SyncDeps {
  getAccounts: () => Account[];
  getActiveId: () => string | null;
  /** Told about every pass, including the boring ones, so policy stays in main.ts. */
  onResult: (account: Account, result: ReconcileResult) => void;
}

let syncTimer: NodeJS.Timeout | null = null;
let syncing = false;

/** One pass. Exported so startup, wake-from-sleep and the UI can force it. */
export async function syncActiveCredentials(deps: SyncDeps): Promise<ReconcileResult | null> {
  if (syncing) return null;
  const activeId = deps.getActiveId();
  if (!activeId) return null;
  const account = deps.getAccounts().find((a) => a.id === activeId);
  if (!account) return null;

  syncing = true;
  try {
    const result = await reconcileActive(account, deps.getAccounts());
    deps.onResult(account, result);
    return result;
  } catch (err) {
    console.warn('[agentsflow][accounts] credential sync failed', (err as Error)?.message ?? err);
    return null;
  } finally {
    syncing = false;
  }
}

export function startCredentialSync(deps: SyncDeps): void {
  if (syncTimer) return;
  // Immediately, not on the first tick: a launch after the app has been closed
  // for hours is the single most likely moment to find the main slot stranded,
  // and sessions spawn seconds later.
  void syncActiveCredentials(deps);
  syncTimer = setInterval(() => { void syncActiveCredentials(deps); }, SYNC_INTERVAL_MS);
  syncTimer.unref?.();
}

export function stopCredentialSync(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

/** Restore the pre-switch snapshot. The escape hatch if a switch goes wrong. */
export async function restoreBackup(): Promise<boolean> {
  const backup = await readSlotRaw(BACKUP_SERVICE);
  if (!backup || !parseOAuth(backup)) return false;
  await writeSlotRaw(MAIN_SERVICE, backup);
  console.log('[agentsflow][accounts] restored pre-switch credentials from backup');
  return true;
}

// ---------------------------------------------------------------------------
// Keep-warm — what makes "sign in once" literally true
// ---------------------------------------------------------------------------

let keepWarmTimer: NodeJS.Timeout | null = null;

/**
 * The active account is the one this sweep must NOT touch. Its tokens are also
 * in the main slot, so refreshing them here would invalidate the copy the CLI is
 * holding — the exact sequence that used to end in "Login expired". Its refresh
 * token is kept alive by the CLI's own use instead, which is what a refresh
 * token is for.
 *
 * The one case that still needs us: an account left active but unused long
 * enough for the refresh token's own ~30-day clock to run down. Then we renew it
 * once and write BOTH copies in the same breath, so they never diverge.
 */
const ACTIVE_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function keepActiveWarm(account: Account): Promise<void> {
  const result = await reconcileActive(account);
  if (result.outcome === 'foreign' || result.outcome === 'signed-out') return;

  const creds = parseOAuth(await readSlotRaw(MAIN_SERVICE));
  if (!creds?.refreshTokenExpiresAt) return;
  if (creds.refreshTokenExpiresAt - Date.now() > ACTIVE_RENEWAL_WINDOW_MS) return;
  // An access token that is still live means the CLI is using this account and
  // refreshing it perfectly well on its own — so there is nothing to rescue, and
  // stepping in would only take a token away from a running session. (We also
  // cannot trust `refreshTokenExpiresAt` to be current: the token endpoint does
  // not restate it, so our copy decays even as the server extends the real one.
  // Requiring an idle account keeps that staleness from causing daily churn.)
  if (!creds.expiresAt || creds.expiresAt > Date.now()) return;

  const fresh = await refreshCredentials(creds);
  await writeOAuthToSlot(serviceNameFor(account.configDir), fresh);
  await writeSlotRaw(MAIN_SERVICE, mergeOAuthInto(await readSlotRaw(MAIN_SERVICE), fresh));
  console.log('[agentsflow][accounts] renewed the active refresh token', { email: account.email });
}

/**
 * Refresh every pooled account on a daily timer so no refresh token ever lapses
 * into a re-login — every account except the active one, which is mirrored
 * rather than rotated (see keepActiveWarm above and invariant 3 at the top).
 */
export async function keepWarm(accounts: Account[], activeId?: string | null): Promise<void> {
  for (const account of accounts) {
    try {
      if (activeId && account.id === activeId) {
        await keepActiveWarm(account);
        continue;
      }
      const creds = await readAccountCreds(account);
      if (!creds) continue;
      // "Not the active id" is not the same as "nobody else holds these": with
      // no active id recorded, the branch above never runs and the signed-in
      // account arrives here like any other. Ask the login itself instead.
      if (await holdsMainSlot(account, creds)) continue;
      // Deliberately refresh well before expiry so an account that is never
      // switched to still exercises (and therefore extends) its refresh token.
      // Safe here precisely because nothing else holds a copy of these.
      const fresh = await refreshCredentials(creds);
      await writeOAuthToSlot(serviceNameFor(account.configDir), fresh);
      console.log('[agentsflow][accounts] kept warm', { email: account.email });
    } catch (err) {
      console.warn('[agentsflow][accounts] keep-warm failed', {
        email: account.email,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }
}

export function startKeepWarm(getAccounts: () => Account[], getActiveId: () => string | null): void {
  if (keepWarmTimer) return;
  const tick = () => { void keepWarm(getAccounts(), getActiveId()); };
  // First sweep a minute after launch so it never competes with startup work.
  setTimeout(tick, 60_000).unref?.();
  keepWarmTimer = setInterval(tick, KEEP_WARM_INTERVAL_MS);
  keepWarmTimer.unref?.();
}

// ---------------------------------------------------------------------------
// In-progress adds
// ---------------------------------------------------------------------------

export interface PendingAdd {
  pendingId: string;
  email: string;
  configDir: string;
  shellId: string;
  startedAt: number;
}

const pending = new Map<string, PendingAdd>();

export function beginAdd(email: string): PendingAdd {
  const configDir = createVaultDir(email);
  const pendingId = crypto.randomUUID();
  const entry: PendingAdd = {
    pendingId,
    email: email.trim(),
    configDir,
    shellId: `account-login-${pendingId.slice(0, 8)}`,
    startedAt: Date.now(),
  };
  pending.set(pendingId, entry);
  return entry;
}

export function getPending(pendingId: string): PendingAdd | undefined {
  return pending.get(pendingId);
}

export function clearPending(pendingId: string): void {
  pending.delete(pendingId);
}

/**
 * Poll an in-progress add. Returns 'pending' until the browser flow lands, then
 * either the finished Account or a rejection (which tears the vault down).
 */
export async function probeAdd(
  pendingId: string,
  existing: Account[],
): Promise<ProbeAccountResult> {
  const entry = pending.get(pendingId);
  if (!entry) return { status: 'pending' };

  const status = await authStatusIn(entry.configDir);
  const accountUuid = readVaultAccountUuid(entry.configDir);
  const verdict = evaluateLogin({ status, expectedEmail: entry.email, accountUuid, existing });

  if (verdict.verdict === 'pending') return { status: 'pending' };

  if (verdict.verdict !== 'ok') {
    console.warn('[agentsflow][accounts] rejected login', { email: entry.email, verdict: verdict.verdict });
    await destroyVault(entry.configDir);
    pending.delete(pendingId);
    return { status: verdict.verdict, error: verdict.error };
  }

  const account: Account = {
    id: crypto.randomUUID(),
    email: status.email || entry.email,
    configDir: entry.configDir,
    accountUuid,
    orgId: status.orgId,
    subscriptionType: status.subscriptionType,
    addedAt: new Date().toISOString(),
  };
  pending.delete(pendingId);
  console.log('[agentsflow][accounts] added', { email: account.email, uuid: account.accountUuid });
  return { status: 'ok', account };
}
