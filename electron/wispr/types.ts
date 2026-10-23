// Shared contracts for the Wispr Flow auto-learner. Types + constants only.
// Nothing under electron/wispr/ imports 'electron' so every module runs under plain node tests.

/** Bundle ids Wispr records for dictations that landed in Peers Flow (dev build, packaged build). */
export const PEERS_FLOW_BUNDLE_IDS: readonly string[] = ['com.github.Electron', 'com.agentsflow.app'];
export const TEAM_DICTIONARY_DEFAULT = '00000000-0000-0000-0000-000000000000';
/** A sent word is "the user's vocabulary" once it appears this often across sent messages. */
export const VOCAB_MIN_COUNT = 3;

export interface Dictation {
  id: string;             // History.transcriptEntityId
  timestamp: string;      // raw History.timestamp, e.g. '2026-10-21 20:39:46.362 +00:00' — the cursor is this string
  at: number;             // epoch ms parsed from `timestamp`
  app: string;
  formattedText: string;  // what Wispr pasted
  asrText: string | null;
}

export interface UserMessage {
  at: number;             // epoch ms
  text: string;           // cleaned human text (truth-sources.cleanUserText)
  source: 'claude' | 'codex';
  sessionId: string;
}

export interface DictionaryRow {
  id: string;
  phrase: string;
  replacement: string | null;
  observedSource: string | null;
  source: string | null;
  manualEntry: boolean;
  isDeleted: boolean;
  frequencyUsed: number;
  createdAt: string;
  modifiedAt: string;
}

export interface DiffOp { kind: 'equal' | 'replace' | 'insert' | 'delete'; a0: number; a1: number; b0: number; b1: number }

export interface PairResult {
  dictation: Dictation;
  message: UserMessage;
  score: number;           // 0..1 share of heard tokens found in the message
  heard: string[];         // surface tokens of formattedText (tokenize)
  sent: string[];          // surface tokens of message.text
  ops: DiffOp[];           // wordDiff over the NORMALIZED token arrays; indices address heard/sent
}

export interface RawCandidate { heard: string; sent: string; dictationId: string; messageAt: number }  // surface spans, space-joined

export type RejectReason =
  | 'identical' | 'case-only' | 'too-long' | 'too-short' | 'punctuation' | 'number-format'
  | 'markup' | 'slash-command' | 'url-or-path' | 'stopword' | 'in-dictionary' | 'wispr-knows' | 'inflection' | 'not-similar';

export interface FilterContext {
  isStopword(key: string): boolean;        // key = normalizePhrase(word)
  inDictionary(key: string): boolean;      // deleted rows AND recent learner inserts included
  vocabCount(key: string): number;         // how often the user has SENT this word
  wisprCount(key: string): number;         // how often Wispr itself already output this word in the last 90 days
}

export interface Candidate {
  heard: string; sent: string;             // surface forms (most useful casing is decided later)
  key: string;                             // normalizePhrase(sent)
  dictationId: string;
  similarity: number;                      // 0..1
  soundsAlike: boolean;
  inVocabulary: boolean;                   // vocabCount(key) >= VOCAB_MIN_COUNT
}
export interface Rejected { candidate: RawCandidate; reason: RejectReason }

// ----- stopwords / vocabulary / ledger -----
export interface Stopwords { has(key: string): boolean; readonly size: number; readonly origin: 'cache' | 'network' | 'bundled' | 'none' }

export interface VocabEntry {
  c: number;                       // occurrences across sent messages
  s: string[];                     // distinct session ids (keep ≤ 5)
  f: Record<string, number>;       // surface form → count (keep ≤ 3)
  mid: number;                     // occurrences capitalized while NOT sentence-initial
  last: number;                    // epoch ms last seen
}
export type VocabStats = Record<string, VocabEntry>;  // key = normalizeWord(token)
export interface VocabCandidate { word: string; key: string; count: number; sessions: number; why: 'known-name' | 'name-like' }

export interface EvidenceEntry {
  heard: Record<string, number>;   // heard surface form → times seen
  forms: Record<string, number>;   // sent surface form → times seen
  dictationIds: string[];          // distinct dictations; evidence count = length
  firstAt: number; lastAt: number;
}
export interface LedgerInsert { at: number; kind: 'correction' | 'vocabulary'; phrase: string; key: string; id: string }

export interface LedgerState {
  version: 1;
  cursor: string;                          // History.timestamp of the newest processed dictation
  messagesIngestedThrough: number;         // epoch ms; sent messages up to here are folded into `vocab`
  evidence: Record<string, EvidenceEntry>; // key = normalizePhrase(sent)
  vocab: VocabStats;
  inserts: LedgerInsert[];                 // rolling 14 days
  lastJanitorAt: number;                   // 0 = never
  backupDoneAt: number | null;
}

// ----- planning -----
export interface Caps { correctionsPerWeek: number; vocabularyPerWeek: number; insertsPerTick: number; deletesPerTick: number }
export interface PlannedInsert { phrase: string; observedSource: string | null; kind: 'correction' | 'vocabulary'; key: string; evidence: number; why: string }
export interface PlannedDelete { id: string; phrase: string; observedSource: string | null; rule: string }
export interface TickPlan {
  inserts: PlannedInsert[];
  deletes: PlannedDelete[];
  rejected: Rejected[];                                 // candidate-level rejections this tick
  skipped: Array<{ key: string; reason: string }>;      // accepted candidates held back: 'evidence', 'cap', 'in-dictionary', 'already-inserted'
  paired: number; unpaired: number;
  ledger: LedgerState;                                  // NEW state; the input ledger is never mutated
}
export interface PlanInput {
  dictations: Dictation[];       // settled, ascending by timestamp
  messages: UserMessage[];       // everything read this tick (pairing window ∪ vocab ingest), sorted by at
  dictionary: DictionaryRow[];   // all rows, deleted included
  stopwords: Stopwords;
  knownNames: string[];          // peer folder names, skill names, agent names
  ledger: LedgerState;
  nowMs: number;
  janitorDue: boolean;
  caps?: Partial<Caps>;
  wisprCounts?: Record<string, number>;   // normalizeWord key → times in Wispr's own output (90 d); missing = 0
}

// ----- DB adapter -----
export interface SchemaCheck { ok: boolean; missing: string[]; unexpected: string[]; detail: string }
export interface NewDictionaryRow { id: string; phrase: string; observedSource: string | null; now: string /* wisprNow() */ }
export interface WisprDb {
  readonly dbPath: string;
  readonly readOnly: boolean;
  exists(): boolean;
  checkSchema(): Promise<SchemaCheck>;
  readDictionary(): Promise<DictionaryRow[]>;
  readDictations(opts: { apps: readonly string[]; afterTimestamp: string; throughTimestamp: string; limit: number }): Promise<Dictation[]>;
  /** normalizeWord(token) → count over every History.formattedText newer than sinceTimestamp, all apps. */
  readOutputWordCounts(sinceTimestamp: string): Promise<Record<string, number>>;
  /** INSERT OR IGNORE in one IMMEDIATE transaction; returns the ids present after commit. Throws when readOnly. */
  insertDictionaryRows(rows: NewDictionaryRow[]): Promise<{ inserted: string[] }>;
  /** UPDATE isDeleted=1, modifiedAt=? WHERE id IN (...) — never DELETE. Throws when readOnly. */
  softDelete(ids: string[], modifiedAt: string): Promise<{ updated: number }>;
  /** Writes every Dictionary row (deleted included) as JSON; returns the row count. */
  exportDictionary(toFile: string): Promise<number>;
}

// ----- truth -----
export interface TruthSource { readonly name: 'claude' | 'codex'; readMessages(fromMs: number, toMs: number): Promise<UserMessage[]> }

// ----- runtime -----
export interface LearnerConfig { enabled: boolean; dryRun: boolean }
export interface TickReport {
  at: number;
  skipped?: 'disabled' | 'db-missing' | 'schema' | 'running' | 'locked' | 'no-new';
  dryRun: boolean;
  plan?: TickPlan;
  applied?: { inserted: number; softDeleted: number };
  errors: string[];
}
