// Turns a paired dictation into heard→sent correction candidates and filters them.
// Wispr's own auto-learn is the cautionary tale: it learned glued junk and markup.
// Every rejection rule below exists because a real edit would otherwise have been
// learned as a "word" — the order matters, the first matching rule names the reason.

import type { Candidate, FilterContext, PairResult, RawCandidate, Rejected, RejectReason } from './types';
import { VOCAB_MIN_COUNT } from './types';
import { hasDigit, hasLetter, normalizePhrase, normalizeWord, tokenize } from './text';
import { similarity, soundsAlike } from './diff';

/** A mis-hearing is a word or a short name; longer swaps are rewrites. */
export const MAX_SPAN_TOKENS = 3;
export const MAX_SENT_CHARS = 40;
/** Below this edit similarity a swap only counts when it sounds alike or is a word the user keeps sending. */
export const MIN_SIMILARITY = 0.5;
/** A word Wispr itself output this often in 90 days is one it already knows; swapping it in is a rewrite. */
export const WISPR_KNOWS_MIN = 50;

const MARKUP_TOKENS = new Set(['ol', 'li', 'ul', 'br', 'p', 'div', 'span', 'strong', 'em', 'html', 'body']);
const MARKUP_CHARS = /[<>`*#|]/;
const NUMERIC = /^[\d\s.,]+$/;

/** Diacritics off for stem comparison only: Polish endings alternate ć/ci, ń/ni, ś/si (sieć/sieci). */
const fold = (w: string): string => w.normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l');

/** Same word, other ending (powinny/powinno, oprogramowania/oprogramowanie): a grammar fix, not a mis-hearing. */
function sameStem(a0: string, b0: string): boolean {
  const a = fold(a0);
  const b = fold(b0);
  if (Math.abs(a.length - b.length) > 3) return false;
  const need = Math.max(4, Math.ceil(0.6 * Math.min(a.length, b.length)));
  if (Math.min(a.length, b.length) < need) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= need;
}

export function extractCandidates(pair: PairResult): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const op of pair.ops) {
    if (op.kind !== 'replace') continue;
    if (op.a1 - op.a0 > MAX_SPAN_TOKENS || op.b1 - op.b0 > MAX_SPAN_TOKENS) continue;
    out.push({
      heard: pair.heard.slice(op.a0, op.a1).join(' '),
      sent: pair.sent.slice(op.b0, op.b1).join(' '),
      dictationId: pair.dictation.id,
      messageAt: pair.message.at,
    });
  }
  return out;
}

export function judgeCandidate(c: RawCandidate, ctx: FilterContext): { ok: true; candidate: Candidate } | { ok: false; reason: RejectReason } {
  const reject = (reason: RejectReason): { ok: false; reason: RejectReason } => ({ ok: false, reason });
  const heardTokens = tokenize(c.heard);
  const sentTokens = tokenize(c.sent);
  const sent = c.sent.trim();

  if (heardTokens.length > MAX_SPAN_TOKENS || sentTokens.length > MAX_SPAN_TOKENS || sent.length > MAX_SENT_CHARS) return reject('too-long');
  // Only a token that STARTS with '/' is a command; '50/90' is a mis-heard number.
  if (heardTokens.some((t) => t.startsWith('/')) || sentTokens.some((t) => t.startsWith('/'))) return reject('slash-command');
  // Wispr formats spoken lists as <ol><li>; the user deleting that is not a vocabulary fix.
  if ([...heardTokens, ...sentTokens].some((t) => MARKUP_TOKENS.has(normalizeWord(t))) || MARKUP_CHARS.test(c.heard) || MARKUP_CHARS.test(c.sent)) {
    return reject('markup');
  }
  // Sent side only: the heard side may be anything Wispr produced, the learned phrase may not be a path.
  if (sent.includes('://') || sent.includes('\\') || sent.includes('@') || sent.includes('/') || sent.startsWith('~') || sent.startsWith('.')) {
    return reject('url-or-path');
  }

  const key = normalizePhrase(c.sent);
  if (normalizePhrase(c.heard) === key) return reject(c.heard.trim() === sent ? 'identical' : 'case-only');
  if (!hasLetter(sent) && !hasDigit(sent)) return reject('punctuation');
  if (key.length < 2) return reject('too-short');
  const heard = c.heard.trim();
  if (NUMERIC.test(heard) && NUMERIC.test(sent) && heard.replace(/\D/g, '') === sent.replace(/\D/g, '')) return reject('number-format');
  if (key.split(' ').every((k) => ctx.isStopword(k))) return reject('stopword');
  if (ctx.inDictionary(key)) return reject('in-dictionary');
  // Wispr's stopword list is English-only, so Polish grammar rewrites (że→żeby, takich→tych)
  // reach this point. A sent span made only of words Wispr already writes teaches it nothing.
  const sentKeys = key.split(' ');
  if (sentKeys.every((k) => ctx.wisprCount(k) >= WISPR_KNOWS_MIN)) return reject('wispr-knows');
  if (!hasDigit(c.heard) && !hasDigit(c.sent)) {
    const heardKeys = heardTokens.map(normalizeWord).filter(Boolean);
    const unknown = sentKeys.filter((k) => ctx.wisprCount(k) < WISPR_KNOWS_MIN);
    if (unknown.every((k) => heardKeys.some((h) => sameStem(h, k)))) return reject('inflection');
  }

  const sim = similarity(c.heard, c.sent);
  const alike = soundsAlike(c.heard, c.sent);
  const count = ctx.vocabCount(key);
  if (sim < MIN_SIMILARITY && !alike && count < VOCAB_MIN_COUNT) return reject('not-similar');

  return {
    ok: true,
    candidate: { heard: c.heard, sent: c.sent, key, dictationId: c.dictationId, similarity: sim, soundsAlike: alike, inVocabulary: count >= VOCAB_MIN_COUNT },
  };
}

export function filterCandidates(raw: RawCandidate[], ctx: FilterContext): { accepted: Candidate[]; rejected: Rejected[] } {
  const accepted: Candidate[] = [];
  const rejected: Rejected[] = [];
  for (const c of raw) {
    const v = judgeCandidate(c, ctx);
    if (v.ok) accepted.push(v.candidate);
    else rejected.push({ candidate: c, reason: v.reason });
  }
  return { accepted, rejected };
}
