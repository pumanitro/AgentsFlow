// The learner's decision layer: one tick's dictations, sent messages and the Dictionary
// snapshot in, a TickPlan out — what to insert, what to soft-delete, what was held back
// and why, and the next ledger state. Pure: no IO, and the input ledger is never touched,
// so a dry run is just "plan and throw the plan away".
//
// Two ways a word earns a Dictionary row:
//   correction — the user fixed Wispr's output (heard → sent). One fix can be a one-off
//                rewrite, so it takes two distinct dictations, or one fix of a word the
//                user already sends often.
//   vocabulary — a name-like word the user keeps sending that Wispr does not know yet.
// Both are capped per rolling week: Wispr syncs Dictionary rows to its cloud, and a
// runaway learner would be far more annoying than a slow one.

import * as crypto from 'crypto';
import type { Caps, Candidate, LedgerState, PlanInput, PlannedDelete, PlannedInsert, Rejected, TickPlan, UserMessage } from './types';
import { normalizePhrase } from './text';
import { pairAll } from './pairing';
import { WISPR_KNOWS_MIN, extractCandidates, filterCandidates } from './candidates';
import { ingestMessages, mineVocabulary, pruneVocab } from './vocabulary';
import { cloneLedger, insertsSince, pruneLedger, recordEvidence } from './ledger';
import { janitorTargets } from './glue';

export const DEFAULT_CAPS: Caps = { correctionsPerWeek: 25, vocabularyPerWeek: 10, insertsPerTick: 10, deletesPerTick: 20 };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Distinct dictations a correction needs unless the word is already the user's vocabulary. */
const MIN_EVIDENCE = 2;

function mostFrequent(counts: Record<string, number>, fallback: string): string {
  let best = fallback;
  let n = 0;
  for (const [form, c] of Object.entries(counts)) if (c > n) [best, n] = [form, c];
  return best;
}

export function planTick(input: PlanInput): TickPlan {
  const ledger: LedgerState = cloneLedger(input.ledger);
  const caps: Caps = { ...DEFAULT_CAPS, ...input.caps };
  const now = input.nowMs;
  const isStopword = (k: string): boolean => input.stopwords.has(k);

  const { paired, unpaired } = pairAll(input.dictations, input.messages);

  // Vocabulary only from messages a dictation paired with: delegated-agent prompts
  // ("LANE: …", "You are being delegated…") arrive as user turns too, and would teach
  // the agents' words as the user's. Ingested before filtering, so this tick's messages
  // already count toward "the user sends this word". The watermark keeps a message that
  // is re-read next tick (overlapping windows) from counting twice.
  const seen = new Set<string>();
  const fresh: UserMessage[] = [];
  for (const { message: m } of paired) {
    const id = `${m.at}|${m.sessionId}`;
    if (m.at <= ledger.messagesIngestedThrough || seen.has(id)) continue;
    seen.add(id);
    fresh.push(m);
  }
  ingestMessages(ledger.vocab, fresh, isStopword);
  for (const m of fresh) if (m.at > ledger.messagesIngestedThrough) ledger.messagesIngestedThrough = m.at;
  pruneVocab(ledger.vocab, now);

  // Deleted rows count as "known": the user (or our janitor) removed them on purpose, and
  // re-learning them would undo that. Our own recent inserts count too — the snapshot may
  // predate them, or Wispr may not have synced them yet.
  const known = new Set<string>();
  for (const row of input.dictionary) known.add(normalizePhrase(row.phrase));
  for (const ins of ledger.inserts) known.add(normalizePhrase(ins.phrase));
  const insertedKeys = new Set(ledger.inserts.map((i) => i.key));
  const ctx = {
    isStopword,
    inDictionary: (k: string): boolean => known.has(k),
    vocabCount: (k: string): number => (Object.hasOwn(ledger.vocab, k) ? ledger.vocab[k].c : 0),
    wisprCount: (k: string): number => (input.wisprCounts && Object.hasOwn(input.wisprCounts, k) ? input.wisprCounts[k] : 0),
  };

  const rejected: Rejected[] = [];
  const accepted = new Map<string, Candidate>(); // first accepted candidate per key, in tick order
  for (const pair of paired) {
    const r = filterCandidates(extractCandidates(pair), ctx);
    rejected.push(...r.rejected);
    for (const c of r.accepted) {
      recordEvidence(ledger, c, pair.dictation.at);
      if (!accepted.has(c.key)) accepted.set(c.key, c);
    }
  }

  const inserts: PlannedInsert[] = [];
  const skipped: TickPlan['skipped'] = [];
  const planned = new Set<string>();
  let correctionsLeft = caps.correctionsPerWeek - insertsSince(ledger, 'correction', now - WEEK_MS);
  let vocabularyLeft = caps.vocabularyPerWeek - insertsSince(ledger, 'vocabulary', now - WEEK_MS);
  const tickLeft = (): number => caps.insertsPerTick - inserts.length;

  for (const [key, c] of accepted) {
    if (known.has(key) || planned.has(key)) { skipped.push({ key, reason: 'in-dictionary' }); continue; }
    if (insertedKeys.has(key)) { skipped.push({ key, reason: 'already-inserted' }); continue; }
    const e = ledger.evidence[key];
    const evidence = e.dictationIds.length;
    if (evidence < MIN_EVIDENCE && !c.inVocabulary) { skipped.push({ key, reason: 'evidence' }); continue; }
    if (correctionsLeft <= 0 || tickLeft() <= 0) { skipped.push({ key, reason: 'cap' }); continue; }
    const phrase = mostFrequent(e.forms, c.sent);
    const heard = mostFrequent(e.heard, c.heard);
    const why = evidence >= MIN_EVIDENCE ? `seen ${evidence}× (${heard}→${phrase})` : `vocabulary ${ctx.vocabCount(key)}×`;
    inserts.push({ phrase, observedSource: heard, kind: 'correction', key, evidence, why });
    planned.add(key);
    correctionsLeft--;
  }

  // A word Wispr already writes correctly gains nothing from a row, and a word that is
  // part of an existing phrase ("Leymans" of "Leymans Terms") is already covered by it.
  const knownTokens = new Set<string>();
  for (const k of known) for (const t of k.split(' ')) knownTokens.add(t);
  const vocab = mineVocabulary(ledger.vocab, { isStopword, inDictionary: ctx.inDictionary, knownNames: input.knownNames });
  for (const v of vocab) {
    if (planned.has(v.key) || insertedKeys.has(v.key)) continue;
    if (ctx.wisprCount(v.key) >= WISPR_KNOWS_MIN) { skipped.push({ key: v.key, reason: 'wispr-knows' }); continue; }
    if (knownTokens.has(v.key)) { skipped.push({ key: v.key, reason: 'in-dictionary' }); continue; }
    if (vocabularyLeft <= 0 || tickLeft() <= 0) { skipped.push({ key: v.key, reason: 'cap' }); continue; }
    const why = v.why === 'known-name' ? `known-name ${v.count}×` : `name-like ${v.count}× in ${v.sessions} sessions`;
    inserts.push({ phrase: v.word, observedSource: null, kind: 'vocabulary', key: v.key, evidence: v.count, why });
    planned.add(v.key);
    vocabularyLeft--;
  }

  // The runtime writes the DB row under this id and finds it again by key.
  for (const ins of inserts) ledger.inserts.push({ at: now, kind: ins.kind, phrase: ins.phrase, key: ins.key, id: crypto.randomUUID() });

  let deletes: PlannedDelete[] = [];
  if (input.janitorDue) {
    deletes = janitorTargets(input.dictionary).slice(0, caps.deletesPerTick);
    ledger.lastJanitorAt = now;
  }

  if (input.dictations.length > 0) ledger.cursor = input.dictations[input.dictations.length - 1].timestamp;
  pruneLedger(ledger, now);

  return { inserts, deletes, rejected, skipped, paired: paired.length, unpaired: unpaired.length, ledger };
}
