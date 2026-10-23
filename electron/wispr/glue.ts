// Detector for Wispr auto-learned Dictionary rows that are terminal-edit garbage.
//
// Wispr learns a "user edit" by diffing what it pasted against what the text box
// holds a moment later. In a terminal the box keeps scrolling, so the word it
// pasted often gets glued to whatever was typed right after it:
//
//   righttraits ← right      subtaskssubagent ← subtasks      3charts ← charts
//
// Those rows then rewrite every future "right" into "righttraits". They share a
// shape — the phrase is the heard word plus junk stuck on one end — and that
// shape is what these rules look for. Real corrections (Figma ← Sigma,
// 4090 ← 490, worktree ← word) do not have it.
//
// A false positive deletes a correction the user relies on; a miss only leaves
// one bad row for another day. So every rule is deliberately narrow, rows the
// user typed or uses a lot are never touched, and multi-word phrases are out.

import type { DictionaryRow, PlannedDelete } from './types';

export type GlueRule = 'prefix-junk' | 'camel-tail' | 'digits-inside' | 'near-prefix-digits' | 'junk-head';
export interface GlueVerdict { glued: boolean; rule: GlueRule | null }

// A row that has fired this often is one the user evidently keeps, whatever it
// looks like (Figma ← Sigma sits at 231). Hands off.
export const JANITOR_MAX_FREQUENCY = 50;

const NOT_GLUED: GlueVerdict = { glued: false, rule: null };
const ALL_DIGITS = /^\d+$/;
const UPPER = /^\p{Lu}$/u;
const LOWER = /^\p{Ll}$/u;

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export function detectGlue(
  row: Pick<DictionaryRow, 'phrase' | 'observedSource' | 'source' | 'manualEntry' | 'frequencyUsed'>,
): GlueVerdict {
  if (row.source !== 'user_edits' || row.manualEntry || row.frequencyUsed >= JANITOR_MAX_FREQUENCY) return NOT_GLUED;
  const P = row.phrase;
  const O = (row.observedSource ?? '').trim();
  if (!O || P === O || /\s/.test(P)) return NOT_GLUED;
  const p = P.toLowerCase();
  const o = O.toLowerCase();

  if (p.startsWith(o)) {
    const tail = P.slice(O.length);
    // "subtaskssubagent": the heard word, then a whole other word.
    if (o.length >= 3 && tail.length >= 2) return { glued: true, rule: 'prefix-junk' };
    // "FlowP": one stray keystroke; only when it breaks the word's own casing.
    if (tail.length === 1 && (UPPER.test(tail) || ALL_DIGITS.test(tail)) && LOWER.test(O[O.length - 1])) {
      return { glued: true, rule: 'camel-tail' };
    }
  }

  // "rig6ht": digits typed into the middle of a word that never had any.
  if (!/\d/.test(O) && /\d/.test(P) && P.replace(/\d+/g, '').toLowerCase() === o) {
    return { glued: true, rule: 'digits-inside' };
  }

  // "analy5090" ← analyses: the word was cut short and a number landed on it.
  const L = commonPrefixLength(p, o);
  if (L >= 4 && L >= 0.6 * o.length) {
    const tail = P.slice(L);
    if (tail && ALL_DIGITS.test(tail)) return { glued: true, rule: 'near-prefix-digits' };
  }

  // "3charts", "nPowiększ": junk in front of the heard word.
  if (p.endsWith(o) && o.length >= 3) {
    const head = P.slice(0, P.length - O.length);
    if (ALL_DIGITS.test(head) || (head.length === 1 && /^\p{L}$/u.test(head) && UPPER.test(O[0]))) {
      return { glued: true, rule: 'junk-head' };
    }
  }

  return NOT_GLUED;
}

export function janitorTargets(rows: DictionaryRow[]): PlannedDelete[] {
  const out: PlannedDelete[] = [];
  for (const r of rows) {
    if (r.isDeleted) continue;
    const v = detectGlue(r);
    if (v.glued && v.rule) out.push({ id: r.id, phrase: r.phrase, observedSource: r.observedSource, rule: v.rule });
  }
  return out;
}
