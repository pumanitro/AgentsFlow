// Long-lived (one-year, inference-only) tokens, one per pooled account.
//
// A minted token lives in the keychain under its own service, keyed by the pool
// `Account.id` - never in the store and never in a log line (accounts are
// identified by id only). The keychain is read once at startup
// (`loadTokenCache`) and the in-memory cache is the source of truth from then
// on; `storeToken`/`forgetToken` keep both in step.
//
// A token Claude Code rejected is remembered as a verdict: `hasToken` and
// `tokenFor` then report nothing, so every consumer falls back to the stored
// OAuth sign-in on its own.

import { execFile } from 'child_process';
import type { Account } from '../shared/types';

export const TOKEN_SERVICE = 'Peers Flow-longlived-token';

let service = TOKEN_SERVICE;
const cache = new Map<string, string>();
const rejected = new Map<string, string>();

/** Point the module at a self-test keychain service (null restores the real one). Also empties the cache. */
export function __setServiceForTests(name: string | null): void {
  service = name ?? TOKEN_SERVICE;
  cache.clear();
  rejected.clear();
}

/** Seed or drop a cache entry without touching the keychain. */
export function __setTokenForTests(accountId: string, token: string | undefined): void {
  if (token) cache.set(accountId, token);
  else cache.delete(accountId);
}

function execFileP(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function readToken(accountId: string): Promise<string | null> {
  try {
    const raw = (await execFileP('security', ['find-generic-password', '-a', accountId, '-s', service, '-w'], 5000)).trim();
    return raw || null;
  } catch {
    return null; // no item for this account
  }
}

/** Keychain → memory for every pooled account; called once at startup, before any spawn. */
export async function loadTokenCache(accounts: ReadonlyArray<Pick<Account, 'id'>>): Promise<void> {
  const found = await Promise.all(accounts.map(async (a) => [a.id, await readToken(a.id)] as const));
  for (const [id, token] of found) {
    if (token) cache.set(id, token);
    else cache.delete(id);
  }
  console.log('[agentsflow][token] cache loaded', { withToken: found.filter(([, t]) => t).map(([id]) => id) });
}

/** Keychain (-U) + cache. Throws if the keychain refuses. Never logs the token. */
export async function storeToken(accountId: string, token: string): Promise<void> {
  await execFileP('security', ['add-generic-password', '-U', '-a', accountId, '-s', service, '-w', token], 8000);
  cache.set(accountId, token);
  rejected.delete(accountId);
  console.log('[agentsflow][token] stored', { accountId });
}

export async function forgetToken(accountId: string): Promise<void> {
  cache.delete(accountId);
  rejected.delete(accountId);
  try {
    await execFileP('security', ['delete-generic-password', '-a', accountId, '-s', service], 5000);
  } catch {
    /* already gone */
  }
  console.log('[agentsflow][token] forgotten', { accountId });
}

/** Cached AND not rejected. */
export function hasToken(accountId: string | null | undefined): boolean {
  return !!accountId && cache.has(accountId) && !rejected.has(accountId);
}

/** undefined when none or rejected, so consumers fall back to the OAuth path. */
export function tokenFor(accountId: string | null | undefined): string | undefined {
  return hasToken(accountId) ? cache.get(accountId as string) : undefined;
}

/** Claude Code refused this token; remembered until `storeToken` replaces it. */
export function markTokenRejected(accountId: string, reason: string): void {
  rejected.set(accountId, reason);
  console.log('[agentsflow][token] rejected', { accountId, reason });
}

export function tokenRejectedReason(accountId: string): string | undefined {
  return rejected.get(accountId);
}
