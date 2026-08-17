// The safety net under automatic account rotation.
//
// Rotation (rotation.ts) is a PREDICTION: watch the meters, move before the
// wall. Predictions miss, and this one missed for a whole night —
//
//   00:50  rotation switches accounts (weekly meter hit 100%) → the walled
//          agent resumes on its own within seconds
//   03:33  the new account's *session* window fills. The agent is walled again.
//   03:33–04:54  it retries every ten minutes and is refused every time, while
//          the sidebar reports the account at 43%, because the threshold was
//          only ever looking at the weekly number (see shared/usage.ts).
//
// Fixing the meter selection removes that particular blindness. It does not
// remove the class: the usage endpoint 429s under a five-account poll, meters
// lag behind spend, and a burst can cross 95→100 inside a single tick. Whenever
// that happens the outcome is the same — an agent sitting dead for hours with
// accounts full of headroom next to it.
//
// So this watches for the wall itself rather than for a forecast of it. A
// rate-limited turn is recorded in the session's own transcript, verbatim and
// machine-readable:
//
//   {"type":"assistant","isApiErrorMessage":true,"error":"rate_limit",
//    "apiErrorStatus":429,"message":{"content":[{"type":"text",
//    "text":"You've hit your session limit · resets 7:50am (Europe/Warsaw)"}]}}
//
// When one shows up: switch accounts, then tell that chat to continue. Both
// halves are needed. The switch alone only helps agents that happen to retry on
// a timer (the 00:50 recovery above was a monitor loop re-firing, not the CLI);
// a plain chat has already ended its turn and will wait forever.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Conversation, RotationPolicy } from '../shared/types';
import { findTranscript } from './transcript-path';

// How often transcripts are checked. Well under the ~10-minute retry cadence an
// agent-with-a-monitor uses, and cheap: a stat per candidate, and a tail read
// only for the ones that have actually changed.
const TICK_MS = 30_000;

// Only the tail is read. A rate-limited turn is a handful of entries; the file
// itself runs to tens of megabytes.
const TAIL_BYTES = 96 * 1024;

// A wall older than this is history, not a stuck chat — the window it names has
// long since reset and whatever the agent was doing is over. Six hours covers
// an overnight run from the moment it stalls to the moment the user looks.
const MAX_HIT_AGE_MS = 6 * 60 * 60 * 1000;

// Never send a chat two nudges in quick succession. If a nudge lands and hits
// the wall again, that is a signal to wait, not to keep typing.
const NUDGE_COOLDOWN_MS = 10 * 60 * 1000;

// A chat that has been nudged this many times and keeps coming back is not
// going to be rescued by another message. Stop, and leave the status line
// saying so.
const MAX_NUDGES_PER_CONVERSATION = 3;

// What gets typed. Deliberately the same word a person would use: it asks the
// agent to carry on with what it was already doing, and carries no instructions
// that could redirect the work.
export const RESUME_MESSAGE = 'continue';

export interface LimitHit {
  /** Epoch ms of the rate-limited turn. */
  at: number;
  /** The CLI's own text, e.g. "You've hit your session limit · resets 7:50am". */
  text: string;
}

/**
 * Read the newest assistant turn out of a transcript tail and report whether it
 * was refused for rate limiting.
 *
 * Only `assistant` entries are considered, and only the newest one decides: a
 * rate-limit entry with a normal assistant turn after it means the session
 * already recovered (which is exactly what happens when rotation fires while an
 * agent is mid-retry). User entries are skipped rather than treated as
 * recovery — a queued prompt sitting behind the wall is not progress.
 *
 * Pure and exported for tests; the file I/O is in `readLimitHit` below.
 */
export function parseLimitHit(tail: string): LimitHit | null {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    if (!entry.isApiErrorMessage) return null; // a real turn — nothing is stuck
    if (entry.error !== 'rate_limit') return null; // some other API failure
    const at = Date.parse(String(entry.timestamp ?? ''));
    return {
      at: Number.isFinite(at) ? at : 0,
      text: errorText(entry) || 'rate limited',
    };
  }
  return null;
}

function errorText(entry: Record<string, unknown>): string {
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    const text = (part as { text?: unknown })?.text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * The last `TAIL_BYTES` of a conversation's transcript, with the leading
 * fragment removed.
 *
 * Removing it HERE, and only when the read actually started mid-file, is the
 * point. Dropping the first line unconditionally — which is what the parsers
 * did at first — silently blinds them to any transcript short enough to be read
 * whole, where line 0 is a genuine entry and often the only user turn there is.
 */
// Locating a transcript costs a readdir of ~120 project dirs plus a stat each
// whenever the direct path misses (a chat that entered a worktree re-homes its
// transcript). That is fine once; on a 30-second timer across every unsettled
// chat in a 1,600-conversation history it is the kind of steady main-thread
// load this app has had to dig out of before. The path is stable for a
// session's life, so it is resolved once and only re-resolved if it vanishes.
const pathCache = new Map<string, string>();

function transcriptFor(conv: Conversation): string | null {
  const cached = pathCache.get(conv.id);
  if (cached && fs.existsSync(cached)) return cached;
  const found = findTranscript(projectsRoot(), conv.directoryPath, conv.sessionId);
  if (found) pathCache.set(conv.id, found);
  else pathCache.delete(conv.id);
  return found;
}

function readTail(conv: Conversation): string | null {
  if (!conv.sessionId) return null;
  const file = transcriptFor(conv);
  if (!file) return null;
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    if (start === 0) return text;
    const firstBreak = text.indexOf('\n');
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// A walled chat's transcript stops growing — that is the whole symptom — so
// after the first read every later tick can be a single stat. Keyed on mtime,
// which also means a chat that starts moving again is re-read at once.
const scanCache = new Map<string, { mtimeMs: number; size: number; hit: LimitHit | null }>();

/** `parseLimitHit` against a conversation's transcript on disk. */
export function readLimitHit(conv: Conversation): LimitHit | null {
  const file = transcriptFor(conv);
  if (!file) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = scanCache.get(conv.id);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.hit;

  const tail = readTail(conv);
  const hit = tail === null ? null : parseLimitHit(tail);
  scanCache.set(conv.id, { mtimeMs: stat.mtimeMs, size: stat.size, hit });
  return hit;
}

/**
 * Timestamp of the newest user turn in the transcript, 0 if there is none.
 *
 * This is the proof that a nudge was accepted rather than left sitting typed in
 * the composer, and it is deliberately a BASELINE COMPARISON rather than a
 * "newer than now" check. The first version asked for a user turn newer than
 * the moment of typing minus a second of clock slack, and against a session
 * that had been started seconds earlier that matched the session's ORIGINAL
 * prompt — it declared success, closed the viewer, and the message it was
 * supposed to deliver was never sent. Snapshot before, compare after: no
 * clocks, nothing to skew.
 *
 * The transcript is the right place to ask at all, because the CLI appends the
 * entry the moment a message is submitted (measured at ~200 ms) and, unlike the
 * terminal's pixels, it cannot be misread.
 */
export function lastUserTurnAt(conv: Conversation): number {
  const tail = readTail(conv);
  if (!tail) return 0;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let entry: { type?: unknown; timestamp?: unknown };
    try {
      entry = JSON.parse(line) as { type?: unknown; timestamp?: unknown };
    } catch {
      continue;
    }
    if (entry.type !== 'user') continue;
    // Entries are appended in order, so the newest user turn settles it.
    const at = Date.parse(String(entry.timestamp ?? ''));
    return Number.isFinite(at) ? at : 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Which chats are worth rescuing
// ---------------------------------------------------------------------------

// A chat the user has already put away is not waiting on anything, and typing
// into it would restart work they considered finished. In this app an unpinned
// conversation means done (see store.ts), so pinned-or-not-yet-settled is the
// line — and it has to be one of those, not both, because a walled agent's
// recorded state is whatever it managed to write before it stalled.
const SETTLED_STATES = new Set(['done', 'completed', 'failed', 'error', 'stopped']);

export function isRescuable(conv: Conversation): boolean {
  if (!conv.sessionId) return false;
  if (conv.pinned) return true;
  return !SETTLED_STATES.has((conv.state || '').toLowerCase());
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface LimitWatchDeps {
  getPolicy: () => RotationPolicy;
  getConversations: () => Conversation[];
  /** Defaults to the real transcript read; injected in tests. */
  readHit?: (conv: Conversation) => LimitHit | null;
  /** One urgent rotation pass. True when an account switch actually happened. */
  rotate: () => Promise<{ switched: boolean; reason: string }>;
  /** Type a message into the session. */
  nudge: (conv: Conversation, text: string) => Promise<{ ok: boolean; error?: string }>;
  /** Surfaced on the same status line the rotation events use. */
  onEvent: (message: string) => void;
}

interface Attempt {
  /** Timestamp of the hit we last acted on — a newer hit is a new event. */
  lastHitAt: number;
  lastNudgeAt: number;
  count: number;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
const attempts = new Map<string, Attempt>();

/**
 * One pass. Exported so the guards — the cooldown, the attempt cap, "don't
 * touch a chat that already recovered" — are testable without timers, which is
 * the whole risk surface of something that types into sessions unattended.
 */
export async function runOnce(deps: LimitWatchDeps): Promise<void> {
  if (running) return;
  const policy = deps.getPolicy();
  if (!policy.enabled || !policy.resumeOnLimit) return;

  running = true;
  try {
    const readHit = deps.readHit ?? readLimitHit;
    const convs = deps.getConversations().filter(isRescuable);
    const now = Date.now();
    // Drop bookkeeping for conversations that are gone or have recovered, so a
    // chat that gets walled again next week starts from a clean slate.
    const live = new Set(convs.map((c) => c.id));
    for (const id of Array.from(attempts.keys())) {
      if (!live.has(id)) attempts.delete(id);
    }
    // The caches follow the same lifetime — a conversation that settles or is
    // deleted must not keep a transcript path and a stale verdict alive.
    for (const id of Array.from(scanCache.keys())) {
      if (!live.has(id)) { scanCache.delete(id); pathCache.delete(id); }
    }

    for (const conv of convs) {
      const hit = readHit(conv);
      if (!hit) {
        // The newest turn is a real one: whatever wall this chat hit, it is
        // past it. Forget the attempts so it is fully rescuable next time.
        attempts.delete(conv.id);
        continue;
      }
      if (hit.at && now - hit.at > MAX_HIT_AGE_MS) continue;

      const prior = attempts.get(conv.id);
      if (prior) {
        if (hit.at && hit.at <= prior.lastHitAt) continue; // already acted on this one
        if (now - prior.lastNudgeAt < NUDGE_COOLDOWN_MS) continue;
        if (prior.count >= MAX_NUDGES_PER_CONVERSATION) continue;
      }

      console.warn('[agentsflow][limit-watch] a chat is walled', {
        title: conv.title, sessionId: conv.sessionId, hit: hit.text,
      });

      // Switch first. Nudging before the account changes just spends the
      // attempt budget re-hitting the same wall.
      const rotated = await deps.rotate();
      if (!rotated.switched) {
        // Rotation already writes its own status line for the interesting case
        // ("no other account is below 95%"), so don't overwrite it — just stop.
        console.warn('[agentsflow][limit-watch] no switch available, leaving the chat parked', {
          title: conv.title, reason: rotated.reason,
        });
        continue;
      }

      const attempt: Attempt = {
        lastHitAt: hit.at || now,
        lastNudgeAt: now,
        count: (prior?.count ?? 0) + 1,
      };
      attempts.set(conv.id, attempt);

      const sent = await deps.nudge(conv, RESUME_MESSAGE);
      if (sent.ok) {
        console.log('[agentsflow][limit-watch] resumed a walled chat', { title: conv.title, attempt: attempt.count });
        deps.onEvent(`Hit the limit in “${conv.title}” — switched account and resumed it.`);
      } else {
        console.warn('[agentsflow][limit-watch] could not resume the chat', { title: conv.title, error: sent.error });
        deps.onEvent(`Hit the limit in “${conv.title}” — switched account, but couldn't resume it (${sent.error}).`);
      }
      // One rescue per pass. A wall is usually account-wide, so the next pass
      // will find the other chats already unblocked by this same switch, and
      // the ones that aren't get their turn 30 seconds later rather than a
      // burst of switches and attach PTYs all at once.
      break;
    }
  } finally {
    running = false;
  }
}

export function startLimitWatch(deps: LimitWatchDeps): void {
  if (timer) return;
  timer = setInterval(() => { void runOnce(deps); }, TICK_MS);
  timer.unref?.();
}

export function stopLimitWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: reset the module's loop state between cases. */
export function __resetForTests(): void {
  stopLimitWatch();
  running = false;
  attempts.clear();
  scanCache.clear();
  pathCache.clear();
}
