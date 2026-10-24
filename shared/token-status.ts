// What the Accounts panel says about an account's one-year token, in one place
// so the badge, its hover text and the tests can never disagree.
import type { Account } from './types';

export type TokenState = 'none' | 'missing' | 'ok' | 'expiring' | 'expired' | 'rejected';
export interface TokenStatus { state: TokenState; label: string; title: string; daysLeft: number | null }
export const TOKEN_EXPIRING_DAYS = 30;

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "24 Oct 2027" — fixed English months, so the label does not shift with the locale. */
export function formatTokenDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * rejected: Claude refused the token — wins over everything else, since no date
 * or keychain entry makes a refused token usable ·
 * none: never minted · missing: minted, but the keychain no longer holds it ·
 * expired: held and past its date · expiring: held, ≤ 30 days left · ok otherwise.
 * An unreadable expiry on a held token counts as ok — the keychain is the
 * truth about whether chats can run, the date is only bookkeeping.
 */
export function tokenStatus(a: Pick<Account, 'hasToken' | 'tokenExpiresAt' | 'tokenRejected'>, now: number = Date.now()): TokenStatus {
  if (a.tokenRejected) {
    return { state: 'rejected', label: 'token rejected', title: a.tokenRejected, daysLeft: null };
  }
  const parsed = a.tokenExpiresAt ? Date.parse(a.tokenExpiresAt) : NaN;
  const expiresAt = Number.isFinite(parsed) ? parsed : null;

  if (!a.hasToken) {
    if (!a.tokenExpiresAt) {
      return {
        state: 'none',
        label: 'no token',
        title: 'No one-year token yet. Chats on this account use its normal sign-in, which can expire and ask you to sign in again. Generate a token to stop that.',
        daysLeft: null,
      };
    }
    return {
      state: 'missing',
      label: 'token missing',
      title: 'A token was made for this account, but it is no longer in the keychain. Generate a new one so chats keep running without a sign-in.',
      daysLeft: null,
    };
  }

  if (expiresAt === null) {
    return { state: 'ok', label: 'token', title: 'Chats on this account run on its one-year token — no sign-in needed.', daysLeft: null };
  }

  const msLeft = expiresAt - now;
  if (msLeft <= 0) {
    return {
      state: 'expired',
      label: 'token expired',
      title: `This account's token ran out on ${formatTokenDate(expiresAt)}. Generate a new one so chats keep running without a sign-in.`,
      daysLeft: 0,
    };
  }

  const daysLeft = Math.ceil(msLeft / DAY_MS);
  if (daysLeft <= TOKEN_EXPIRING_DAYS) {
    return {
      state: 'expiring',
      label: `token · ${daysLeft} d left`,
      title: `This account's token runs out on ${formatTokenDate(expiresAt)} (${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left). Renew it to keep chats running without a sign-in.`,
      daysLeft,
    };
  }
  return {
    state: 'ok',
    label: `token · until ${formatTokenDate(expiresAt)}`,
    title: `Chats on this account run on its one-year token until ${formatTokenDate(expiresAt)} — no sign-in needed.`,
    daysLeft,
  };
}
