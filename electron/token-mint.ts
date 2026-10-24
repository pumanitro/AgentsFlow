// Mints one pool account's long-lived token: runs the PKCE flow
// (oauth-pkce.ts) with that account's email as the login hint, then checks the
// browser really signed in as THAT account before the token is handed back.
//
// One flow per account at a time — a second request while one is waiting for
// the browser answers 'busy' instead of opening another consent tab. A flow
// can be cancelled from the UI (cancelMint) and gives up on its own after
// `timeoutMs`.
//
// Never throws, never logs the token: log lines carry the email and the
// failure reason only. Storing the token is the caller's job (main.ts →
// long-lived-token.ts), so a mismatched identity never reaches the keychain.

import type { Account, MintTokenReason } from '../shared/types';
import { OAuthFlowError, runAuthorizationCodeFlow, type PostJson, type TokenResponse } from './oauth-pkce';
import { CALLBACK_LISTEN_HOST, TOKEN_EXPIRES_IN_S, TOKEN_SCOPES } from './token-policy';

const DEFAULT_TIMEOUT_MS = 300_000;

export interface MintDeps { openUrl: (url: string) => Promise<void>; scopes?: string; expiresInS?: number; timeoutMs?: number; post?: PostJson; listenHost?: string }
export type MintOutcome =
  | { ok: true; token: string; expiresAt: number; scopes: string[]; learned?: { accountUuid?: string; orgId?: string } }
  | { ok: false; reason: MintTokenReason; error: string };

const inFlight = new Map<string, AbortController>();

const sameEmail = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Pure. Mismatch when the response's account uuid differs from the stored
 * `accountUuid`, or its organization uuid from the stored `orgId` (each only
 * when both sides are known). A legacy account with no stored uuid falls back
 * to comparing emails, and on a match `learned` backfills the ids it lacks.
 */
export function verifyMintedIdentity(account: Pick<Account, 'email' | 'accountUuid' | 'orgId'>, resp: TokenResponse): { ok: true; learned?: { accountUuid?: string; orgId?: string } } | { ok: false; error: string } {
  const respUuid = resp.account?.uuid;
  const respEmail = resp.account?.email;
  const respOrg = resp.organization?.uuid;
  const signedInAs = () =>
    `That browser was signed in as ${respEmail || 'another account'}, not ${account.email}. Sign in to claude.ai as ${account.email} (or use the browser profile you added it with) and try again.`;

  if (account.accountUuid && respUuid) {
    if (account.accountUuid !== respUuid) return { ok: false, error: signedInAs() };
  } else if (respEmail && account.email && !sameEmail(respEmail, account.email)) {
    return { ok: false, error: signedInAs() };
  }
  if (account.orgId && respOrg && account.orgId !== respOrg) {
    return {
      ok: false,
      error: `That browser authorised a different Claude organization than the one ${account.email} was added with${resp.organization?.name ? ` (${resp.organization.name})` : ''}. Sign in to claude.ai as ${account.email}, choose the same organization, and try again.`,
    };
  }

  const learned: { accountUuid?: string; orgId?: string } = {};
  if (!account.accountUuid && respUuid) learned.accountUuid = respUuid;
  if (!account.orgId && respOrg) learned.orgId = respOrg;
  return Object.keys(learned).length ? { ok: true, learned } : { ok: true };
}

/** One flow per account at a time ('busy'); never throws; never logs the token; logs email + reason only. */
export async function mintTokenFor(account: Account, deps: MintDeps): Promise<MintOutcome> {
  if (inFlight.has(account.id)) {
    return { ok: false, reason: 'busy', error: 'A token is already being generated for this account — finish or cancel it in the browser first.' };
  }
  const controller = new AbortController();
  inFlight.set(account.id, controller);
  console.log('[agentsflow][token-mint] generating a long-lived token', { email: account.email });
  try {
    const resp = await runAuthorizationCodeFlow({
      scopes: deps.scopes ?? TOKEN_SCOPES,
      expiresInS: deps.expiresInS ?? TOKEN_EXPIRES_IN_S,
      loginHint: account.email,
      orgUuid: account.orgId,
      openUrl: deps.openUrl,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: controller.signal,
      listenHost: deps.listenHost ?? CALLBACK_LISTEN_HOST,
      post: deps.post,
    });
    const verdict = verifyMintedIdentity(account, resp);
    if (!verdict.ok) {
      console.warn('[agentsflow][token-mint] minted token belongs to another login — discarded', { email: account.email, got: resp.account?.email, reason: 'mismatch' });
      return { ok: false, reason: 'mismatch', error: verdict.error };
    }
    console.log('[agentsflow][token-mint] long-lived token generated', { email: account.email, expiresAt: new Date(resp.expiresAt).toISOString() });
    const out: MintOutcome = { ok: true, token: resp.accessToken, expiresAt: resp.expiresAt, scopes: resp.scopes };
    if (verdict.learned) out.learned = verdict.learned;
    return out;
  } catch (err) {
    const reason: MintTokenReason = err instanceof OAuthFlowError ? err.reason : 'unknown';
    const error = err instanceof OAuthFlowError ? err.message : `Token generation failed (${(err as Error)?.message ?? 'unknown error'}).`;
    console.warn('[agentsflow][token-mint] token generation failed', { email: account.email, reason });
    return { ok: false, reason, error };
  } finally {
    if (inFlight.get(account.id) === controller) inFlight.delete(account.id);
  }
}

/** Aborts this account's flow if one is waiting; true when there was one. */
export function cancelMint(accountId: string): boolean {
  const controller = inFlight.get(accountId);
  if (!controller) return false;
  controller.abort();
  return true;
}
