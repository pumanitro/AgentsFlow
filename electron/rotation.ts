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
// chat actually reports a rate-limit wall — same switch, but on proof rather
// than a forecast (and past the cooldown, because a 429 is not a meter hovering
// on a boundary).
//
// Proof outranks the meter. The night of 2026-08-21 a chat reported "You've hit
// your session limit" while the active account's worst meter read 43%, and the
// urgent pass still answered "active at 43% (below 90%)" — walls exist that no
// row of `limits[]` reports. So a forced pass (a wall, or a login that has been
// unreadable for minutes) no longer asks the active meter's permission at all;
// it only asks whether there is somewhere readable to go. The same night the
// active login was revoked server-side and its meters went unreadable for 87
// minutes; "unreadable active ⇒ do nothing" held rotation still with four
// healthy accounts beside it. Blindness about the TARGET is a reason not to
// switch; blindness about the SOURCE is, after a grace, the reason to.

import type { Account, AgentProvider, RotationPolicy, RotationStatus, UsageResult } from '../shared/types';
import { bindingPercent } from '../shared/usage';

export { bindingPercent };

// How often the active account's meters are re-evaluated.
const TICK_MS = 60_000;
// Minimum gap between two switches — guards against a meter that hovers on the
// threshold and against a target whose own usage has not caught up yet.
const COOLDOWN_MS = 5 * 60 * 1000;
// After this many consecutive failed switches we stop trying and surface it.
const MAX_CONSECUTIVE_FAILURES = 3;
// How long the active account's meters may stay unreadable before that, by
// itself, is treated as "this login is broken — move". Long enough to ride out
// a 429 burst from the usage endpoint; short enough that a revoked token costs
// minutes, not the night. A switch only happens if some OTHER account reads
// fine, which is what separates a broken login from the endpoint being down.
const BLIND_SWITCH_AFTER_MS = 5 * 60 * 1000;
// An account a chat just proved full is not a target for a while, whatever its
// meter claims — the meter is what was wrong. Without this an urgent switch
// a→b followed by a wall on b would pick a straight back.
const PROVEN_FULL_MS = 30 * 60 * 1000;

// Injectable clock — the grace periods above are the point of several tests.
let now: () => number = () => Date.now();

export const DEFAULT_POLICY: RotationPolicy = {
  enabled: false,
  threshold: 95,
  // On by default, because it only ever fires on a wall that has already been
  // hit: by then the alternative to acting is a chat that sits dead until
  // someone wakes up.
  resumeOnLimit: true,
  // Off by default: switching provider hands every unfinished conversation to
  // a different agent, which is a bigger step than moving to another account.
  crossProvider: false,
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
 *
 * `force` is the one way past the active meter: a short statement of what is
 * KNOWN to be wrong with the active account ("a chat hit the wall", "login
 * unreadable for 6 min"). With it set, the meter is reported but not consulted
 * — the decision is purely whether a readable account with headroom exists.
 */
export function decide(opts: {
  activePercent: number | null;
  candidates: CandidateUsage[];
  threshold: number;
  force?: string | null;
}): RotationDecision {
  const { activePercent, candidates, threshold, force = null } = opts;

  if (!force) {
    if (activePercent === null) {
      return { action: 'none', reason: 'active account usage unreadable' };
    }
    if (activePercent < threshold) {
      return { action: 'none', reason: `active at ${activePercent}% (below ${threshold}%)` };
    }
  }
  const meter = activePercent === null ? 'meter unreadable' : `meter at ${activePercent}%`;
  const active = force ? `${force} (${meter})` : `active at ${activePercent}%`;

  const withHeadroom = candidates
    .filter((c): c is { accountId: string; percent: number } => c.percent !== null && c.percent < threshold)
    .sort((a, b) => a.percent - b.percent);

  if (withHeadroom.length === 0) {
    const unreadable = candidates.filter((c) => c.percent === null).length;
    if (unreadable === 0) {
      return {
        action: 'exhausted',
        reason: `${active}, but no other account is below ${threshold}%`,
      };
    }
    // "Full" and "meters we cannot read" are different emergencies — the second
    // one the user can fix (or upstream freshening should have prevented), so
    // it must not hide behind a message about percentages, which is how a night
    // of expired standby tokens read as "everything is full" (2026-08-20).
    const full = candidates.length - unreadable;
    const parts = [
      full > 0 ? `${full} at/above ${threshold}%` : null,
      `${unreadable} unreadable`,
    ].filter(Boolean);
    return {
      action: 'exhausted',
      reason: `${active}, but no other account is usable — ${parts.join(', ')}`,
    };
  }
  const best = withHeadroom[0];
  return {
    action: 'switch',
    targetId: best.accountId,
    reason: `${active} → switching to the account at ${best.percent}%`,
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
  // ---- Cross-provider rotation (all optional: a Claude-only host omits them) ----
  getActiveProvider?: () => AgentProvider;
  /** Usage of a provider's current login — Codex has one login, not a pool. */
  getProviderUsage?: (provider: AgentProvider, force: boolean) => Promise<UsageResult>;
  /** Make `provider` the active one and hand unfinished conversations over. */
  switchProvider?: (provider: AgentProvider, reason: string) => Promise<void>;
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
  | { switched: true; account?: Account; provider?: AgentProvider; reason: string };

/**
 * One evaluation pass. Exported so the loop's guards — cooldown, the
 * failure stop, the once-only "no headroom" message — are testable without
 * waiting on real timers. An unattended feature that retries a broken switch
 * every minute all night is the failure mode worth having tests for.
 *
 * `urgent` is the limit-watch path: a chat has hit a real wall, so the meters
 * are re-read past their cache, the cooldown does not apply, and the active
 * meter is not consulted (see `decide`'s `force`). `cause` names the proof for
 * the log and status line; it defaults to the wall. Everything else — the
 * failure stop, the headroom requirement, never choosing an account whose
 * usage we could not read — is identical, because those guards exist to stop
 * thrashing and a real wall does not make thrashing safe.
 */
export async function runOnce(
  deps: RotationDeps,
  opts: { urgent?: boolean; cause?: string } = {},
): Promise<RunOutcome> {
  const urgent = Boolean(opts.urgent);
  if (running) return { switched: false, reason: 'a pass is already running' };
  const policy = deps.getPolicy();
  if (!policy.enabled) return { switched: false, reason: 'automatic switching is off' };
  if (status.disabledReason) return { switched: false, reason: status.disabledReason };

  const accounts = deps.getAccounts();
  const crossProvider = Boolean(policy.crossProvider && deps.getProviderUsage && deps.switchProvider);
  const provider: AgentProvider = deps.getActiveProvider?.() ?? 'claude';
  if (provider === 'claude' && accounts.length < 2 && !crossProvider) {
    return { switched: false, reason: 'only one account in the pool' };
  }
  if (!urgent && now() - lastSwitchAt < COOLDOWN_MS) {
    return { switched: false, reason: 'switched too recently' };
  }

  running = true;
  try {
    if (provider === 'codex') return await runOnceOnCodex(deps, policy, urgent, opts.cause, crossProvider);

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
    // once per spell, not once a minute — and after BLIND_SWITCH_AFTER_MS of
    // it, no longer a "do nothing" at all.
    if (activePercent === null) noteUnreadable(activeUsage);
    else clearUnreadable();

    const blindFor = activePercent === null && unreadableSince ? now() - unreadableSince : 0;
    const force = urgent
      ? (opts.cause ?? 'a chat hit the wall')
      : blindFor >= BLIND_SWITCH_AFTER_MS
        ? `active login unreadable for ${Math.round(blindFor / 60_000)} min`
        : null;

    const others = accounts.filter((a) => a.id !== activeId);
    const preview = decide({
      activePercent,
      candidates: others.map((a) => ({ accountId: a.id, percent: null })),
      threshold: policy.threshold,
      force,
    });
    if (preview.action === 'none') return { switched: false, reason: preview.reason };

    // Only now is it worth spending a request per candidate. An account a chat
    // proved full recently is reported as full, whatever its meter says now —
    // the meter is the thing that was wrong about it.
    const candidates: CandidateUsage[] = await Promise.all(
      others.map(async (a) => {
        if (now() - (provenFullAt.get(a.id) ?? 0) < PROVEN_FULL_MS) return { accountId: a.id, percent: 100 };
        try {
          return { accountId: a.id, percent: bindingPercent(await deps.getAccountUsage(a, urgent)) };
        } catch {
          return { accountId: a.id, percent: null };
        }
      }),
    );

    const decision = decide({ activePercent, candidates, threshold: policy.threshold, force });
    if (decision.action === 'none') return { switched: false, reason: decision.reason };

    if (decision.action === 'exhausted') {
      // Nothing left on the Claude side. With provider rotation on, Codex is
      // the next place to go — if its own meter reads and has headroom.
      if (crossProvider) {
        const moved = await tryProviderSwitch(deps, 'codex', policy.threshold, urgent, decision.reason);
        if (moved) return moved;
      }
      // Say it once, not every minute.
      if (status.lastEvent !== decision.reason) {
        console.warn('[agentsflow][rotation] no headroom anywhere', { reason: decision.reason });
        setStatus(deps, { lastEvent: decision.reason });
      }
      return { switched: false, reason: decision.reason };
    }

    const target = accounts.find((a) => a.id === decision.targetId)!;
    console.log('[agentsflow][rotation] auto-switching', { to: target.email, reason: decision.reason, urgent, forced: Boolean(force) });
    try {
      await deps.switchTo(target.id);
      lastSwitchAt = now();
      consecutiveFailures = 0;
      // A wall is proof about the account we are leaving; a blind spell is
      // about a login we are no longer on. Neither carries over to the target.
      if (urgent && activeId) provenFullAt.set(activeId, now());
      unreadableSince = 0;
      unreadableReason = '';
      setStatus(deps, { lastEvent: `Switched to ${target.label || target.orgName || target.email} — ${decision.reason}`, disabledReason: null });
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
// Provider rotation
// ---------------------------------------------------------------------------
// Codex is one login rather than a pool, so "rotate" on that side means one
// question: is its meter past the threshold (or did a chat just prove it), and
// is there somewhere on the Claude side to go? Symmetric with the Claude side
// falling through to Codex when its pool is exhausted.

async function tryProviderSwitch(
  deps: RotationDeps,
  target: AgentProvider,
  threshold: number,
  urgent: boolean,
  because: string,
): Promise<RunOutcome | null> {
  if (!deps.getProviderUsage || !deps.switchProvider) return null;
  let percent: number | null = null;
  try {
    percent = bindingPercent(await deps.getProviderUsage(target, urgent));
  } catch {
    percent = null;
  }
  const name = target === 'codex' ? 'Codex' : 'Claude';
  if (percent === null) {
    console.warn('[agentsflow][rotation] other provider unreadable, staying put', { target, because });
    return null;
  }
  if (percent >= threshold) {
    console.warn('[agentsflow][rotation] other provider has no headroom either', { target, percent, because });
    return null;
  }
  const reason = `${because} → switching to ${name} (at ${percent}%)`;
  console.log('[agentsflow][rotation] switching provider', { to: target, reason, urgent });
  try {
    await deps.switchProvider(target, reason);
    lastSwitchAt = now();
    consecutiveFailures = 0;
    unreadableSince = 0;
    unreadableReason = '';
    setStatus(deps, { lastEvent: `Switched to ${name} — ${reason}`, disabledReason: null });
    return { switched: true, provider: target, reason };
  } catch (err) {
    consecutiveFailures += 1;
    const error = (err as Error)?.message ?? String(err);
    console.error('[agentsflow][rotation] provider switch failed', { to: target, error, consecutiveFailures });
    setStatus(deps, consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
      ? { lastEvent: `Switching to ${name} failed ${consecutiveFailures}× (${error})`, disabledReason: 'Switching kept failing, so rotation stopped. Fix the sign-in, then re-enable.' }
      : { lastEvent: `Switching to ${name} failed (${error}) — will retry` });
    return { switched: false, reason: `provider switch failed: ${error}` };
  }
}

/** The pass while Codex is the active provider. */
async function runOnceOnCodex(
  deps: RotationDeps,
  policy: RotationPolicy,
  urgent: boolean,
  cause: string | undefined,
  crossProvider: boolean,
): Promise<RunOutcome> {
  if (!deps.getProviderUsage) return { switched: false, reason: 'Codex usage is not readable here' };
  let percent: number | null = null;
  let usage: UsageResult | null = null;
  try {
    usage = await deps.getProviderUsage('codex', urgent);
    percent = bindingPercent(usage);
  } catch {
    percent = null;
  }
  if (percent === null) noteUnreadable(usage);
  else clearUnreadable();
  const blindFor = percent === null && unreadableSince ? now() - unreadableSince : 0;
  const force = urgent ? (cause ?? 'a chat hit the wall') : blindFor >= BLIND_SWITCH_AFTER_MS ? `Codex login unreadable for ${Math.round(blindFor / 60_000)} min` : null;
  if (!force) {
    if (percent === null) return { switched: false, reason: 'Codex usage unreadable' };
    if (percent < policy.threshold) return { switched: false, reason: `Codex at ${percent}% (below ${policy.threshold}%)` };
  }
  const because = force ? `${force} (${percent === null ? 'meter unreadable' : `meter at ${percent}%`})` : `Codex at ${percent}%`;
  if (!crossProvider) {
    const reason = `${because}, and provider rotation is off`;
    if (status.lastEvent !== reason) setStatus(deps, { lastEvent: reason });
    return { switched: false, reason };
  }
  // The Claude side: the best pooled account with headroom, else the login in
  // the main slot when there is no pool.
  const accounts = deps.getAccounts();
  let best: { accountId: string; percent: number } | null = null;
  if (accounts.length > 0) {
    const candidates = await Promise.all(accounts.map(async (a) => {
      if (now() - (provenFullAt.get(a.id) ?? 0) < PROVEN_FULL_MS) return { accountId: a.id, percent: 100 };
      try { return { accountId: a.id, percent: bindingPercent(await deps.getAccountUsage(a, urgent)) }; }
      catch { return { accountId: a.id, percent: null }; }
    }));
    const withHeadroom = candidates
      .filter((c): c is { accountId: string; percent: number } => c.percent !== null && c.percent < policy.threshold)
      .sort((a, b) => a.percent - b.percent);
    best = withHeadroom[0] ?? null;
    if (!best) {
      const reason = `${because}, but no Claude account is below ${policy.threshold}%`;
      if (status.lastEvent !== reason) { console.warn('[agentsflow][rotation] no headroom anywhere', { reason }); setStatus(deps, { lastEvent: reason }); }
      return { switched: false, reason };
    }
  }
  // With a pool, the account with headroom is what makes Claude usable — its
  // own meter is the one to consult rather than whatever sits in the main slot.
  const moved = best
    ? await switchProviderDirect(deps, 'claude', `${because} → switching to Claude`)
    : await tryProviderSwitch(deps, 'claude', policy.threshold, urgent, because);
  if (!moved || !moved.switched) {
    const reason = moved?.reason ?? `${because}, but Claude has no headroom or could not be read`;
    if (status.lastEvent !== reason) setStatus(deps, { lastEvent: reason });
    return { switched: false, reason };
  }
  if (best && best.accountId !== deps.getActiveId()) {
    try {
      const account = await deps.switchTo(best.accountId);
      setStatus(deps, { lastEvent: `Switched to Claude, ${account.label || account.orgName || account.email} (at ${best.percent}%) — ${because}` });
      return { switched: true, provider: 'claude', account, reason: moved.reason };
    } catch (err) {
      console.error('[agentsflow][rotation] account switch after provider switch failed', { error: (err as Error)?.message ?? err });
    }
  }
  return moved;
}

/** Switch provider without consulting its meter (a pooled account already vouched). */
async function switchProviderDirect(deps: RotationDeps, target: AgentProvider, reason: string): Promise<RunOutcome> {
  if (!deps.switchProvider) return { switched: false, reason: 'provider switching unavailable' };
  const name = target === 'codex' ? 'Codex' : 'Claude';
  try {
    await deps.switchProvider(target, reason);
    lastSwitchAt = now();
    consecutiveFailures = 0;
    unreadableSince = 0;
    unreadableReason = '';
    setStatus(deps, { lastEvent: `Switched to ${name} — ${reason}`, disabledReason: null });
    return { switched: true, provider: target, reason };
  } catch (err) {
    consecutiveFailures += 1;
    const error = (err as Error)?.message ?? String(err);
    return { switched: false, reason: `provider switch failed: ${error}` };
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
// Accounts a chat has proved full, by when — see PROVEN_FULL_MS.
const provenFullAt = new Map<string, number>();

function noteUnreadable(result: Awaited<ReturnType<RotationDeps['getActiveUsage']>> | null): void {
  const reason = result && !result.ok ? `${result.reason}: ${result.error}` : 'no meters returned';
  // The spell started when the meters first went dark, not when the error text
  // last changed — a 429 that turns into a 401 is the same outage, and the
  // blind-switch grace must not restart on it.
  if (!unreadableSince) unreadableSince = now();
  if (reason === unreadableReason) return;
  unreadableReason = reason;
  console.warn('[agentsflow][rotation] active account usage is unreadable — switching after a grace if another account reads fine', {
    reason,
    graceMs: BLIND_SWITCH_AFTER_MS,
  });
}

function clearUnreadable(): void {
  if (!unreadableSince) return;
  console.log('[agentsflow][rotation] usage readable again', { blindForMs: now() - unreadableSince });
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
  provenFullAt.clear();
  now = () => Date.now();
  status = { lastEvent: null, lastEventAt: null, disabledReason: null };
}

/** Test seam: drive the clock the grace periods are measured on. */
export function __setNowForTests(fn: () => number): void {
  now = fn;
}
