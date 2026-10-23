// Word-level diff and string similarity for the Wispr learner. Pure functions only:
// pairing uses them to decide which sent message a dictation became, candidates use
// them to decide whether a heard→sent swap looks like a mis-hearing or a rewrite.

import type { DiffOp } from './types';
import { normalizePhrase } from './text';

// A full LCS table is a*b cells; 2M Uint32 cells is 8 MB. Above that the pair is two
// long pastes, not a dictation and its message, so callers fall back to bagOverlap.
const MAX_DIFF_CELLS = 2_000_000;

/** LCS diff. Ops cover both sequences in order; [] when the inputs are too big (or both empty). */
export function wordDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_DIFF_CELLS) return [];
  if (n === 0 && m === 0) return [];
  // Suffix table: lcs[i][j] = LCS length of a[i..] and b[j..], so the walk can go forward.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  const push = (kind: 'equal' | 'change', a0: number, a1: number, b0: number, b1: number): void => {
    if (kind === 'equal') {
      ops.push({ kind, a0, a1, b0, b1 });
      return;
    }
    const k: DiffOp['kind'] = a1 > a0 && b1 > b0 ? 'replace' : a1 > a0 ? 'delete' : 'insert';
    ops.push({ kind: k, a0, a1, b0, b1 });
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      const a0 = i;
      const b0 = j;
      while (i < n && j < m && a[i] === b[j]) { i++; j++; }
      push('equal', a0, i, b0, j);
      continue;
    }
    // Consume everything up to the next match as one change block, so a swapped word
    // comes out as a single replace instead of a delete+insert pair.
    const a0 = i;
    const b0 = j;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) break;
      if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) i++;
      else j++;
    }
    push('change', a0, i, b0, j);
  }
  return ops;
}

/** Share of heard tokens that appear anywhere in sent. Order-blind, O(a+b). */
export function bagOverlap(heard: string[], sent: string[]): number {
  if (heard.length === 0) return 0;
  const bag = new Set(sent);
  let hit = 0;
  for (const t of heard) if (bag.has(t)) hit++;
  return hit / heard.length;
}

/** Share of heard tokens kept in order by the sent message (both arrays already normalized). */
export function matchScore(heard: string[], sent: string[]): number {
  if (heard.length === 0) return 0;
  const ops = wordDiff(heard, sent);
  if (ops.length === 0) return bagOverlap(heard, sent);
  let kept = 0;
  for (const op of ops) if (op.kind === 'equal') kept += op.a1 - op.a0;
  return kept / heard.length;
}

/** Edit distance over UTF-16 code units, two-row DP. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 1 - normalized edit distance of the two phrase keys; 0 when either side has no tokens. */
export function similarity(a: string, b: string): number {
  const na = normalizePhrase(a);
  const nb = normalizePhrase(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
}

const POLISH_FOLD: Record<string, string> = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };

/**
 * Crude consonant skeleton. Wispr mis-hears by sound (vat→wat, crown→cron), and a
 * skeleton catches the swaps edit distance scores too low on short words.
 */
export function phoneticKey(w: string): string {
  let s = w.toLowerCase().replace(/[ąćęłńóśźż]/g, (ch) => POLISH_FOLD[ch] ?? ch).replace(/[^\p{L}]/gu, '');
  if (!s) return '';
  s = s
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'kv')
    .replace(/w/g, 'v')
    .replace(/x/g, 'ks')
    .replace(/y/g, 'i')
    .replace(/j/g, 'i')
    .replace(/c(?=[ei])/g, 's')
    .replace(/c/g, 'k')
    .replace(/(.)\1+/gu, '$1');
  return s[0] + s.slice(1).replace(/[aeiou]/g, '');
}

export function soundsAlike(a: string, b: string): boolean {
  const ka = phoneticKey(a);
  return ka !== '' && ka === phoneticKey(b);
}
