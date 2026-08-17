// Which usage meter decides an account's fate.
//
// Shared by the main process (rotation) and the renderer (the Accounts panel's
// per-account percent) so the number you see is exactly the number rotation
// acts on. They used to have separate copies of this rule and both were wrong
// in the same way — see below.

import type { UsageMeter, UsageResult } from './types';

/**
 * The meter closest to its wall.
 *
 * DELIBERATELY NOT `meters.find(m => m.isActive)`. That was the original rule
 * and it is what let an overnight run hit "You've hit your session limit" with
 * auto-switching turned on: the API sets `is_active` on the WEEKLY limit and
 * never on the 5-hour session window (verified live across five accounts —
 * every one reported `session.is_active === false`, `weekly_all.is_active ===
 * true`). So the threshold was only ever compared against the weekly number,
 * and a session window at 100% was invisible to it. Observed: the active
 * account showed 43% in the sidebar while its session meter was at 100% and its
 * agent had been walled for 81 minutes.
 *
 * Every meter is a wall. The one that stops work is whichever is highest, so
 * that is the one the threshold has to watch. `isActive` stays in the data
 * because the API reports it, but it no longer decides anything.
 */
export function worstMeter(result: UsageResult | null | undefined): UsageMeter | null {
  if (!result?.ok) return null;
  const meters = result.snapshot.meters;
  if (meters.length === 0) return null;
  return meters.reduce((a, b) => (b.percent > a.percent ? b : a));
}

/**
 * The percent that decides an account's fate. Returns null when usage is
 * unreadable — callers must treat that as "unknown", never as "fine".
 */
export function bindingPercent(result: UsageResult | null | undefined): number | null {
  const m = worstMeter(result);
  return m ? m.percent : null;
}
