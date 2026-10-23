// Pairs one Wispr dictation with the message the user really sent. The sent message is
// the ground truth: whatever the user changed between Wispr's paste and Enter is what
// Wispr got wrong. A wrong pairing would teach garbage, so the bar is high and a
// dictation with no convincing match is simply left unpaired.

import type { Dictation, PairResult, UserMessage } from './types';
import { normalizeWord, tokenize } from './text';
import { bagOverlap, matchScore, wordDiff } from './diff';

/** The paste lands before the message is sent, but clocks drift a little between Wispr and the transcript. */
export const PAIR_BEFORE_MS = 5_000;
/** Long prompts get edited for a while before Enter. Past 20 min it is a different thought. */
export const PAIR_AFTER_MS = 20 * 60_000;
export const MIN_PAIR_SCORE = 0.6;
/** One- and two-word dictations ("yes", "go on") match too many messages to pair safely. */
export const MIN_HEARD_TOKENS = 3;
// Full LCS is the expensive step, so it runs only on the best few bag-overlap hits.
const FULL_SCORE_TOP = 3;

export function pairDictation(d: Dictation, messages: UserMessage[]): PairResult | null {
  const heard = tokenize(d.formattedText);
  if (heard.length < MIN_HEARD_TOKENS) return null;
  const normHeard = heard.map(normalizeWord);

  const pre: Array<{ message: UserMessage; sent: string[]; normSent: string[]; bag: number }> = [];
  for (const message of messages) {
    if (message.at < d.at - PAIR_BEFORE_MS || message.at > d.at + PAIR_AFTER_MS) continue;
    const sent = tokenize(message.text);
    if (sent.length < MIN_HEARD_TOKENS) continue;
    const normSent = sent.map(normalizeWord);
    pre.push({ message, sent, normSent, bag: bagOverlap(normHeard, normSent) });
  }
  if (pre.length === 0) return null;
  pre.sort((x, y) => y.bag - x.bag || x.message.at - y.message.at);

  let best: { c: (typeof pre)[number]; score: number } | null = null;
  for (const c of pre.slice(0, FULL_SCORE_TOP)) {
    const score = matchScore(normHeard, c.normSent);
    if (!best || score > best.score || (score === best.score && c.message.at < best.c.message.at)) best = { c, score };
  }
  if (!best || best.score < MIN_PAIR_SCORE) return null;
  return {
    dictation: d,
    message: best.c.message,
    score: best.score,
    heard,
    sent: best.c.sent,
    ops: wordDiff(normHeard, best.c.normSent),
  };
}

export function pairAll(dictations: Dictation[], messages: UserMessage[]): { paired: PairResult[]; unpaired: Dictation[] } {
  const paired: PairResult[] = [];
  const unpaired: Dictation[] = [];
  for (const d of dictations) {
    const p = pairDictation(d, messages);
    if (p) paired.push(p);
    else unpaired.push(d);
  }
  return { paired, unpaired };
}
