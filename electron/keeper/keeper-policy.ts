// The Keeper's decision, as a pure function of what is known about one chat.
//
// A chat carries a run contract (Once / Until done / Forever). The Keeper's
// loop (keeper.ts) gathers the facts every tick; this module turns them into
// exactly one of: leave it alone, mark it stalled, type a nudge, relaunch its
// dead daemon, or call it finished. Nothing here touches the disk, a PTY or
// Electron, so every line of the decision order can be pinned by a test.
//
// The order is the policy, and each line is there for a reason that cost
// something to learn elsewhere in this app:
//
//   - A chat that is waiting for the USER must never be nudged. "continue"
//     typed over a question answers the question — with nothing — and the
//     agent carries on down whichever branch it guessed. So a question, a
//     permission prompt or a blocked job is a STALL: a badge and one
//     notification, zero keystrokes.
//   - A rate-limited chat belongs to limit-watch, which has to switch accounts
//     before a nudge can do any good. Two loops typing into one session is how
//     a chat gets "continue" twice.
//   - A dead daemon is only dead when a FRESH listing says so, twice. A stale
//     or failed `claude agents --json` is "unknown", and unknown is not absent
//     (the same rule the poller's reaper uses).
//   - Everything that types is capped: at most MAX_NUDGES_PER_HOUR an hour and
//     never two within NUDGE_COOLDOWN_MS. A chat that keeps stopping is telling
//     us something a seventh "continue" will not fix.

import type { Conversation, DeferredMarker, KeeperCause, KeeperConvState, KillLogEntry, MemLevel } from '../../shared/types';
import type { ClaudeAgentJsonRow } from '../claude-cli';

export const KEEPER_TICK_MS = 30_000;
export const MAX_NUDGES_PER_HOUR = 6;
export const NUDGE_COOLDOWN_MS = 5 * 60_000;
export const IDLE_CONFIRM_MS = 90_000;
export const LIVE_ROWS_FRESH_MS = 120_000;
export const DEAD_CONFIRM_TICKS = 2;
export const CONTINUE_TEXT = 'continue';

const HOUR_MS = 60 * 60_000;

/** Local wall-clock "09:41" for an epoch-ms instant — the form every Keeper message uses. */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Memory is free again — retry the step that was deferred at 09:41 (spawn: probe)." */
export function memoryFreeText(what: string, atHHMM: string): string {
  return `Memory is free again — retry the step that was deferred at ${atHHMM} (${what}).`;
}

/**
 * process-group: "Your vitest run was stopped at 09:41 to protect the machine's memory — rerun it."
 * container: "The container postgres-arrow was stopped at 09:41 to free memory — run `docker start postgres-arrow` and retry."
 */
export function killedText(e: KillLogEntry, atHHMM: string): string {
  if (e.kind === 'container') {
    return `The container ${e.name} was stopped at ${atHHMM} to free memory — run \`docker start ${e.name}\` and retry.`;
  }
  return `Your ${e.family || e.name} run was stopped at ${atHHMM} to protect the machine's memory — rerun it.`;
}

export interface ChatFacts {
  conv: Pick<Conversation, 'id' | 'state' | 'status' | 'pinned' | 'provider' | 'host' | 'sessionId' | 'daemonShort' | 'contract' | 'keeper'>;
  liveRow: ClaudeAgentJsonRow | null; liveRowsFresh: boolean; deadTicks: number;
  walled: boolean; lastAssistantText: string | null; declaredDone: boolean; hasScheduledWakeup: boolean;
  idleSinceMs: number | null; pendingDeferred: DeferredMarker[]; pendingKills: KillLogEntry[]; memLevel: MemLevel; now: number;
}

export type KeeperDecision =
  | { action: 'none'; why: string }
  | { action: 'stalled'; why: string }                                                   // badge + one notification, zero nudges
  | { action: 'nudge'; cause: Exclude<KeeperCause, 'daemon-dead' | 'rate-limit'>; text: string; consumeDeferred: string[]; consumeKills: number }
  | { action: 'relaunch'; cause: 'daemon-dead'; prompt: string }
  | { action: 'completed'; why: string };

const ASKING = /\b(should I|do you want|which (one|option)|let me know)\b/i;

/** Trailing '?' on the last non-empty line, or a "should I / do you want / which one / let me know" in the last 300 chars. */
export function isQuestion(text: string | null): boolean {
  if (!text) return false;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  // Markdown likes to close a question with emphasis or a quote mark:
  // "**Which one?**" still ends on a question.
  const last = lines[lines.length - 1].replace(/[\s*_`"'”’)\]]+$/, '');
  if (last.endsWith('?')) return true;
  return ASKING.test(text.slice(-300));
}

/** MAX_NUDGES_PER_HOUR − the nudges recorded within the trailing hour. */
export function nudgesLeft(k: KeeperConvState | undefined, now: number): number {
  const used = (k?.nudgesAt ?? []).filter((at) => now - at < HOUR_MS).length;
  return Math.max(0, MAX_NUDGES_PER_HOUR - used);
}

/** Epoch ms of the newest nudge or relaunch on record, 0 if there is none. */
export function lastNudgeMs(k: KeeperConvState | undefined): number {
  let last = 0;
  for (const at of k?.nudgesAt ?? []) if (Number.isFinite(at) && at > last) last = at;
  const iso = k?.lastNudgeAt ? Date.parse(k.lastNudgeAt) : NaN;
  if (Number.isFinite(iso) && iso > last) last = iso;
  return last;
}

/** True while the hourly cap or the cooldown forbids typing into this chat. */
export function isCapped(k: KeeperConvState | undefined, now: number): boolean {
  if (nudgesLeft(k, now) <= 0) return true;
  const last = lastNudgeMs(k);
  return last > 0 && now - last < NUDGE_COOLDOWN_MS;
}

/**
 * "Idle" in the Keeper's sense: a process that is running and has stopped
 * working. No live row is never idle — there is nothing to type into.
 */
export function isIdle(f: Pick<ChatFacts, 'conv' | 'liveRow'>): boolean {
  if (!f.liveRow) return false;
  const status = (f.liveRow.status || '').toLowerCase();
  if (status === 'idle') return true;
  if (status === 'busy' || status === 'waiting') return false;
  const state = (f.conv.state || '').toLowerCase();
  return state === 'done' || state === 'completed';
}

/** Why a chat is waiting on the user, or null when it is not. */
export function stallReason(f: Pick<ChatFacts, 'conv' | 'liveRow' | 'lastAssistantText'>): 'blocked' | 'waiting' | 'question' | null {
  const convState = (f.conv.state || '').toLowerCase();
  const rowState = (f.liveRow?.state || '').toLowerCase();
  if (convState === 'blocked' || convState === 'needs-input' || rowState === 'blocked') return 'blocked';
  const status = (f.liveRow?.status || f.conv.status || '').toLowerCase();
  if (status === 'waiting') return 'waiting';
  if (isQuestion(f.lastAssistantText)) return 'question';
  return null;
}

const CAPPED: KeeperDecision = { action: 'none', why: 'cap' };

export function decide(f: ChatFacts): KeeperDecision {
  const { conv, now } = f;
  // Not ours: Codex has no transcript we read, a remote peer's session is on
  // another machine, and a chat with no session id has nothing to resume.
  if (conv.provider === 'codex') return { action: 'none', why: 'codex' };
  if (conv.host) return { action: 'none', why: 'remote' };
  if (!conv.sessionId) return { action: 'none', why: 'no-session' };

  // limit-watch owns a rate-limited chat (it must switch accounts first).
  if (f.walled) return { action: 'none', why: 'walled' };

  // Working is the contract being met.
  if ((f.liveRow?.status || '').toLowerCase() === 'busy') return { action: 'none', why: 'busy' };

  // Waiting on the user: never nudge.
  const stall = stallReason(f);
  if (stall) return { action: 'stalled', why: stall };

  const idle = isIdle(f);

  // A spawn the admission hook refused, now that there is room for it. This
  // applies to every contract — the chat was promised a retry, not a keep-alive.
  if (f.pendingDeferred.length > 0 && f.memLevel === 'ok' && idle) {
    if (isCapped(conv.keeper, now)) return CAPPED;
    const first = f.pendingDeferred[0];
    const more = f.pendingDeferred.length - 1;
    const what = more > 0 ? `${first.what}, and ${more} more` : first.what;
    return {
      action: 'nudge',
      cause: 'memory-deferred',
      text: memoryFreeText(what, hhmm(Date.parse(first.at))),
      consumeDeferred: f.pendingDeferred.map((m) => m.at),
      consumeKills: 0,
    };
  }

  // Something this chat was running got stopped to protect memory.
  if (f.pendingKills.length > 0 && idle) {
    if (isCapped(conv.keeper, now)) return CAPPED;
    const texts: string[] = [];
    for (const e of f.pendingKills) {
      const t = killedText(e, hhmm(Date.parse(e.at)));
      if (!texts.includes(t)) texts.push(t);
    }
    return {
      action: 'nudge',
      cause: 'killed-workload',
      text: texts.slice(0, 3).join(' '),
      consumeDeferred: [],
      consumeKills: f.pendingKills.length,
    };
  }

  const contract = conv.contract ?? 'once';
  if (contract === 'once') return { action: 'none', why: 'once' };

  if (contract === 'until-done') {
    // Past its finish line already; keeper.ts clears completedAt to re-arm.
    if (conv.keeper?.completedAt) return { action: 'none', why: 'already-completed' };
    if (f.declaredDone) return { action: 'completed', why: 'declared-done' };
  }

  if (!f.liveRow) {
    if (!f.liveRowsFresh) return { action: 'none', why: 'rows-stale' };
    if (f.deadTicks < DEAD_CONFIRM_TICKS) return { action: 'none', why: 'dead-unconfirmed' };
    if (isCapped(conv.keeper, now)) return CAPPED;
    return { action: 'relaunch', cause: 'daemon-dead', prompt: CONTINUE_TEXT };
  }

  // A Forever chat that armed its own alarm clock (a cron, a /loop) is asleep
  // on purpose; waking it early only burns a turn.
  if (contract === 'forever' && f.hasScheduledWakeup) return { action: 'none', why: 'scheduled-wakeup' };

  if (!idle) return { action: 'none', why: 'not-idle' };
  if (f.idleSinceMs === null || !f.idleSinceMs || now - f.idleSinceMs < IDLE_CONFIRM_MS) {
    return { action: 'none', why: 'idle-unconfirmed' };
  }
  if (isCapped(conv.keeper, now)) return CAPPED;
  return { action: 'nudge', cause: 'stopped-short', text: CONTINUE_TEXT, consumeDeferred: [], consumeKills: 0 };
}
