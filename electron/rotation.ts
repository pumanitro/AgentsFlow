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

import type { Account, RotationPolicy, RotationStatus, UsageMeter, UsageResult } from '../shared/types';

// How often the active account's meters are re-evaluated.
const TICK_MS = 60_000;
// Minimum gap between two switches — guards against a meter that hovers on the
// threshold and against a target whose own usage has not caught up yet.
const COOLDOWN_MS = 5 * 60 * 1000;
// After this many consecutive failed switches we stop trying and surface it.
const MAX_CONSECUTIVE_FAILURES = 3;

export const DEFAULT_POLICY: RotationPolicy = { enabled: false, threshold: 95 };

/**
 * The percent that decides an account's fate: the limit the API flags as
 * binding, else the worst one. Returns null when usage is unreadable — callers
 * must treat that as "unknown", never as "fine".
 */
export function bindingPercent(result: UsageResult | null | undefined): number | null {
  if (!result?.ok) return null;
  const meters: UsageMeter[] = result.snapshot.meters;
  if (meters.length === 0) return null;
  const binding = meters.find((m) => m.isActive) ?? meters.reduce((a, b) => (b.percent > a.percent ? b : a));
  return binding ? binding.percent : null;
}

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

function setStatus(deps: RotationDeps, patch: Partial<RotationStatus>): void {
  status = { ...status, ...patch, lastEventAt: new Date().toISOString() };
  deps.onStatus(status);
}

/**
 * One evaluation pass. Exported so the loop's guards — cooldown, the
 * failure stop, the once-only "no headroom" message — are testable without
 * waiting on real timers. An unattended feature that retries a broken switch
 * every minute all night is the failure mode worth having tests for.
 */
export async function runOnce(deps: RotationDeps): Promise<void> {
  if (running) return;
  const policy = deps.getPolicy();
  if (!policy.enabled || status.disabledReason) return;

  const accounts = deps.getAccounts();
  if (accounts.length < 2) return;
  if (Date.now() - lastSwitchAt < COOLDOWN_MS) return;

  running = true;
  try {
    const activeId = deps.getActiveId();
    const active = accounts.find((a) => a.id === activeId) ?? null;

    // Read the active account first — the common case is that it still has
    // headroom, and then no other account needs polling at all.
    const activeUsage = active
      ? await deps.getAccountUsage(active, false)
      : await deps.getActiveUsage(false);
    const activePercent = bindingPercent(activeUsage);

    const others = accounts.filter((a) => a.id !== activeId);
    const preview = decide({ activePercent, candidates: others.map((a) => ({ accountId: a.id, percent: null })), threshold: policy.threshold });
    if (preview.action === 'none') return;

    // Only now is it worth spending a request per candidate.
    const candidates: CandidateUsage[] = await Promise.all(
      others.map(async (a) => {
        try {
          return { accountId: a.id, percent: bindingPercent(await deps.getAccountUsage(a, false)) };
        } catch {
          return { accountId: a.id, percent: null };
        }
      }),
    );

    const decision = decide({ activePercent, candidates, threshold: policy.threshold });
    if (decision.action === 'none') return;

    if (decision.action === 'exhausted') {
      // Say it once, not every minute.
      if (status.lastEvent !== decision.reason) {
        console.warn('[agentsflow][rotation] no headroom anywhere', { reason: decision.reason });
        setStatus(deps, { lastEvent: decision.reason });
      }
      return;
    }

    const target = accounts.find((a) => a.id === decision.targetId)!;
    console.log('[agentsflow][rotation] auto-switching', { to: target.email, reason: decision.reason });
    try {
      await deps.switchTo(target.id);
      lastSwitchAt = Date.now();
      consecutiveFailures = 0;
      setStatus(deps, { lastEvent: `Switched to ${target.email} — ${decision.reason}`, disabledReason: null });
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
    }
  } finally {
    running = false;
  }
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
  status = { lastEvent: null, lastEventAt: null, disabledReason: null };
}
