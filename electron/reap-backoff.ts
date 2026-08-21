// How long the daemon reaper waits before trying `claude stop` on the same
// daemon again.
//
// The reaper used to retry every poll tick — 30 seconds — for as long as a
// daemon refused to die, which on the night of 2026-08-21 meant ~1,000 `claude`
// processes launched against one stuck daemon. Each launch reads the shared
// login and can refresh its token; with a single-use refresh token, that many
// concurrent readers is how a token family gets revoked. A daemon that survived
// the first stop is not going to fall to the thirtieth; back off and let the
// next attempt be rare.

export const REAP_BACKOFF_BASE_MS = 60 * 1000;
export const REAP_BACKOFF_MAX_MS = 60 * 60 * 1000;

/** Delay to wait after the `attempt`-th (1-based) stop before the next one. */
export function nextReapDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(REAP_BACKOFF_MAX_MS, REAP_BACKOFF_BASE_MS * 2 ** (n - 1));
}
