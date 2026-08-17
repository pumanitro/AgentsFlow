// Automatic account rotation.
//
// The manual switch in accounts.ts solved "I can move to another account". This
// solves "I can leave it running overnight": a poll in the MAIN process (not the
// renderer, so it keeps working with the window closed or the app in the
// background) watches the active account's meters and switches before the wall
// is hit.
//
// Why the threshold is below 100: a session that actually exhausts its window
// gets rate-limit errors and has to be nursed back. Switching at ~95% rolls the
// work onto a fresh account while everything is still running normally, which is
// the entire point — nobody has to be awake for it.
//
// Failure policy is deliberately timid. Unattended automation that retries a
// broken switch every minute for eight hours is worse than one that stops and
// says so, therefore: a cooldown between switches, and consecutive failures
// disable rotation rather than looping.
//
// The threshold is a PREDICTION, and predictions miss: the meters lag, the
// usage endpoint 429s under a five-account poll, and a burst can cross 95→100
// inside one tick. So limit-watch.ts calls in here with `urgent` the moment a
// chat actually reports a rate-limit wall — same policy, same switch, but on
// proof rather than a forecast (and past the cooldown, because a 429 is not a
// meter hovering on a boundary).

import type { Account, RotationPolicy, RotationStatus, UsageResult } from '../shared/types';
import { bindingPercent } from '../shared/usage';

export { bindingPercent };

// How often the active account's meters are re-evaluated.
const TICK_MS = 60_000;
// Minimum gap between two switches — guards against a meter that hovers on the
// threshold and against a target whose own usage has not caught up yet.
const COOLDOWN_MS = 5 * 60 * 1000;
// After this many consecutive failed switches we stop trying and surface it.
const MAX_CONSECUTIVE_FAILURES = 3;

export const DEFAULT_POLICY: RotationPolicy = {
  enabled: false,
  threshold: 95,
  // On by default, because it only ever fires on a wall that has already been
  // hit: by then the alternative to acting is a chat that sits dead until
  // someone wakes up.
  resumeOnLimit: true,
};

export interface CandidateUsage {
  accountId: string;
  /** Binding percent, or null when this account's meters could not be read. */
  percent: number | null;
}

export type RotationDecision =
  | { action: 'none'; reason: string }
  | { action: 'switch'; targetId: string; reason: string }
  | { action: 'exhausted'; reason: string };

/**
 * Pure policy: given where the active account stands and what the alternatives
 * look like, decide whether to move and where to.
 *
 * An account whose meters we could not read is never chosen. Switching blind at
 * 3am onto an account that might also be exhausted just burns the cooldown and
 * leaves the user worse off than a clear "everything is full" message.
 */
export function decide(opts: {
  activePercent: number | null;
  candidates: CandidateUsage[];
  threshold: number;
}): RotationDecision {
  const { activePercent, candidates, threshold } = opts;

  if (activePercent === null) {
    return { action: 'none', reason: 'active account usage unreadable' };
  }
  if (activePercent < threshold) {
    return { action: 'none', reason: `active at ${activePercent}% (below ${threshold}%)` };
  }

  const withHeadroom = candidates
    .filter((c): c is { accountId: string; percent: number } => c.percent !== null && c.percent < threshold)
    .sort((a, b) => a.percent - b.percent);

  if (withHeadroom.length === 0) {
    return {
      action: 'exhausted',
      reason: `active at ${activePercent}%, but no other account is below ${threshold}%`,
    };
  }
  const best = withHeadroom[0];
  return {
    action: 'switch',
    targetId: best.accountId,
    reason: `active at ${activePercent}% → switching to the account at ${best.percent}%`,
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface RotationDeps {
  getPolicy: () => RotationPolicy;
  getAccounts: () => Account[];
  getActiveId: () => string | null;
  /** Usage for one pooled account, read with that account's own token. */
  getAccountUsage: (account: Account, force: boolean) => Promise<UsageResult>;
  /** Usage of whatever is in the main slot — used when the active login is not pooled. */
  getActiveUsage: (force: boolean) => Promise<UsageResult>;
  switchTo: (accountId: string) => Promise<Account>;
  onStatus: (status: RotationStatus) => void;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastSwitchAt = 0;
let consecutiveFailures = 0;
let status: RotationStatus = { lastEvent: null, lastEventAt: null, disabledReason: null };

export function getStatus(): RotationStatus {
  return status;
}

/** Called when the user flips the toggle — a manual re-enable clears a stop. */
export function clearDisabled(): void {
  consecutiveFailures = 0;
  status = { ...status, disabledReason: null };
}

function setStatus(deps: Pick<RotationDeps, 'onStatus'>, patch: Partial<RotationStatus>): void {
  status = { ...status, ...patch, lastEventAt: new Date().toISOString() };
  deps.onStatus(status);
}

/**
 * Put a message on the same status line rotation uses. The limit watchdog is
 * the other half of the same feature from the user's side — "what did the
 * account pool just do to my chats?" is one question, so it gets one answer.
 */
export function recordEvent(deps: Pick<RotationDeps, 'onStatus'>, message: string): void {
  setStatus(deps, { lastEvent: message });
}

/** What a pass actually did, for callers that need to act on the outcome. */
export type RunOutcome =
  | { switched: false; reason: string }
  | { switched: true; account: Account; reason: string };

/**
 * One evaluation pass. Exported so the loop's guards — cooldown, the
 * failure stop, the once-only "no headroom" message — are testable without
 * waiting on real timers. An unattended feature that retries a broken switch
 * every minute all night is the failure mode worth having tests for.
 *
 * `urgent` is the limit-watch path: a chat has hit a real 429, so the meters
 * are re-read past their cache and the cooldown does not apply. Everything else
 * — the failure stop, the headroom requirement, never choosing an account whose
 * usage we could not read — is identical, because those guards exist to stop
 * thrashing and a real wall does not make thrashing safe.
 */
export async function runOnce(deps: RotationDeps, opts: { urgent?: boolean } = {}): Promise<RunOutcome> {
  const urgent = Boolean(opts.urgent);
  if (running) return { switched: false, reason: 'a pass is already running' };
  const policy = deps.getPolicy();
  if (!policy.enabled) return { switched: false, reason: 'automatic switching is off' };
  if (status.disabledReason) return { switched: false, reason: status.disabledReason };

  const accounts = deps.getAccounts();
  if (accounts.length < 2) return { switched: false, reason: 'only one account in the pool' };
  if (!urgent && Date.now() - lastSwitchAt < COOLDOWN_MS) {
    return { switched: false, reason: 'switched too recently' };
  }

  running = true;
  try {
    const activeId = deps.getActiveId();
    const active = accounts.find((a) => a.id === activeId) ?? null;

    // Read the active account first — the common case is that it still has
    // headroom, and then no other account needs polling at all.
    const activeUsage = active
      ? await deps.getAccountUsage(active, urgent)
      : await deps.getActiveUsage(urgent);
    const activePercent = bindingPercent(activeUsage);

    // Unreadable usage is the one "do nothing" that is worth saying out loud:
    // it looks identical to a healthy account from outside, and it is how a
    // 429'd usage endpoint silently parks rotation for a whole night. Said
    // once per spell, not once a minute.
    if (activePercent === null) noteUnreadable(activeUsage);
    else clearUnreadable();

    const others = accounts.filter((a) => a.id !== activeId);
    const preview = decide({ activePercent, candidates: others.map((a) => ({ accountId: a.id, percent: null })), threshold: policy.threshold });
    if (preview.action === 'none') return { switched: false, reason: preview.reason };

    // Only now is it worth spending a request per candidate.
    const candidates: CandidateUsage[] = await Promise.all(
      others.map(async (a) => {
        try {
          return { accountId: a.id, percent: bindingPercent(await deps.getAccountUsage(a, urgent)) };
        } catch {
          return { accountId: a.id, percent: null };
        }
      }),
    );

    const decision = decide({ activePercent, candidates, threshold: policy.threshold });
    if (decision.action === 'none') return { switched: false, reason: decision.reason };

    if (decision.action === 'exhausted') {
      // Say it once, not every minute.
      if (status.lastEvent !== decision.reason) {
        console.warn('[agentsflow][rotation] no headroom anywhere', { reason: decision.reason });
        setStatus(deps, { lastEvent: decision.reason });
      }
      return { switched: false, reason: decision.reason };
    }

    const target = accounts.find((a) => a.id === decision.targetId)!;
    console.log('[agentsflow][rotation] auto-switching', { to: target.email, reason: decision.reason, urgent });
    try {
      await deps.switchTo(target.id);
      lastSwitchAt = Date.now();
      consecutiveFailures = 0;
      setStatus(deps, { lastEvent: `Switched to ${target.email} — ${decision.reason}`, disabledReason: null });
      return { switched: true, account: target, reason: decision.reason };
    } catch (err) {
      consecutiveFailures += 1;
      const error = (err as Error)?.message ?? String(err);
      console.error('[agentsflow][rotation] auto-switch failed', { to: target.email, error, consecutiveFailures });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        setStatus(deps, {
          lastEvent: `Auto-switch failed ${consecutiveFailures}× (${error})`,
          disabledReason: 'Switching kept failing, so rotation stopped. Fix the account, then re-enable.',
        });
      } else {
        setStatus(deps, { lastEvent: `Auto-switch failed (${error}) — will retry` });
      }
      return { switched: false, reason: `auto-switch failed: ${error}` };
    }
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// "Why didn't it switch?"
// ---------------------------------------------------------------------------
// A pass that decides to do nothing used to leave no trace at all, which made
// the two very different silences — "still has headroom" and "we cannot see the
// meters at all" — indistinguishable in main.log after the fact. The first is
// the system working; the second is the system blind. Only the second is
// logged, once per spell, so a night of 429s from the usage endpoint reads as
// one line rather than 480 or none.

let unreadableSince = 0;
let unreadableReason = '';

function noteUnreadable(result: Awaited<ReturnType<RotationDeps['getActiveUsage']>> | null): void {
  const reason = result && !result.ok ? `${result.reason}: ${result.error}` : 'no meters returned';
  if (unreadableSince && reason === unreadableReason) return;
  unreadableSince = Date.now();
  unreadableReason = reason;
  console.warn('[agentsflow][rotation] active account usage is unreadable — the threshold cannot fire', { reason });
}

function clearUnreadable(): void {
  if (!unreadableSince) return;
  console.log('[agentsflow][rotation] usage readable again', { blindForMs: Date.now() - unreadableSince });
  unreadableSince = 0;
  unreadableReason = '';
}

export function startRotation(deps: RotationDeps): void {
  if (timer) return;
  timer = setInterval(() => { void runOnce(deps); }, TICK_MS);
  timer.unref?.();
}

export function stopRotation(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: reset the module's loop state between cases. */
export function __resetForTests(): void {
  stopRotation();
  running = false;
  lastSwitchAt = 0;
  consecutiveFailures = 0;
  unreadableSince = 0;
  unreadableReason = '';
  status = { lastEvent: null, lastEventAt: null, disabledReason: null };
}
