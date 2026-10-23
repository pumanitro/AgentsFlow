// The learner's memory between ticks: where it stopped reading Wispr's History, which
// corrections it has seen how often, the running vocabulary stats, and what it inserted
// recently (for the weekly caps and "never insert the same thing twice").
//
// One JSON file. It is written by tmp + rename so a crash mid-write leaves the previous
// version intact; a file that still fails to parse is set aside (not deleted — it is the
// only record of what was learned) and the learner starts over, which at worst means
// re-collecting evidence it already had.

import * as fs from 'fs';
import * as path from 'path';
import type { Candidate, LedgerInsert, LedgerState } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const EVIDENCE_IDLE_MS = 30 * DAY_MS;
const INSERTS_KEEP_MS = 14 * DAY_MS;

export interface Ledger {
  readonly file: string;
  state: LedgerState;
  save(): Promise<void>;
  saveSync(): void;
}

export function emptyLedger(cursor: string): LedgerState {
  return {
    version: 1,
    cursor,
    messagesIngestedThrough: 0,
    evidence: {},
    vocab: {},
    inserts: [],
    lastJanitorAt: 0,
    backupDoneAt: null,
  };
}

function isLedgerState(v: unknown): v is LedgerState {
  const o = v as LedgerState | null;
  return (
    !!o &&
    typeof o === 'object' &&
    o.version === 1 &&
    typeof o.cursor === 'string' &&
    typeof o.evidence === 'object' &&
    o.evidence !== null &&
    typeof o.vocab === 'object' &&
    o.vocab !== null &&
    Array.isArray(o.inserts)
  );
}

function readState(file: string, initialCursor: string): LedgerState {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return emptyLedger(initialCursor);
  }
  try {
    const v: unknown = JSON.parse(raw);
    if (isLedgerState(v)) return { ...emptyLedger(initialCursor), ...v };
  } catch {
    /* fall through */
  }
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    /* best effort: the next save overwrites it */
  }
  console.warn(`[agentsflow][wispr-learner] ledger unreadable, starting fresh (kept as ${aside})`);
  return emptyLedger(initialCursor);
}

export function loadLedger(file: string, initialCursor: string): Ledger {
  const tmp = `${file}.tmp-${process.pid}`;
  const ledger: Ledger = {
    file,
    state: readState(file, initialCursor),
    async save() {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify(ledger.state));
      await fs.promises.rename(tmp, file);
    },
    saveSync() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(ledger.state));
      fs.renameSync(tmp, file);
    },
  };
  return ledger;
}

export function cloneLedger(state: LedgerState): LedgerState {
  return structuredClone(state);
}

/** Folds one accepted candidate into the evidence; returns how many distinct dictations back it. */
export function recordEvidence(state: LedgerState, c: Candidate, at: number): number {
  // hasOwn throughout: keys are user words, and "constructor" must not hit Object.prototype.
  const e = Object.hasOwn(state.evidence, c.key)
    ? state.evidence[c.key]
    : (state.evidence[c.key] = { heard: {}, forms: {}, dictationIds: [], firstAt: at, lastAt: at });
  e.heard[c.heard] = (Object.hasOwn(e.heard, c.heard) ? e.heard[c.heard] : 0) + 1;
  e.forms[c.sent] = (Object.hasOwn(e.forms, c.sent) ? e.forms[c.sent] : 0) + 1;
  if (!e.dictationIds.includes(c.dictationId)) e.dictationIds.push(c.dictationId);
  if (at < e.firstAt) e.firstAt = at;
  if (at > e.lastAt) e.lastAt = at;
  return e.dictationIds.length;
}

export function insertsSince(state: LedgerState, kind: LedgerInsert['kind'] | 'any', sinceMs: number): number {
  return state.inserts.filter((i) => i.at >= sinceMs && (kind === 'any' || i.kind === kind)).length;
}

export function pruneLedger(state: LedgerState, nowMs: number): void {
  for (const [k, e] of Object.entries(state.evidence)) {
    if (nowMs - e.lastAt > EVIDENCE_IDLE_MS) delete state.evidence[k];
  }
  state.inserts = state.inserts.filter((i) => nowMs - i.at <= INSERTS_KEEP_MS);
}
