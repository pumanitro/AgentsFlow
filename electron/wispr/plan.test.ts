import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_CAPS, planTick } from './plan';
import { emptyLedger } from './ledger';
import { stopwordsFrom } from './stopwords';
import type { Dictation, DictionaryRow, LedgerState, PlanInput, UserMessage } from './types';

// Tiny stub: the real list is a download; these are the words the fixtures need.
const STOPWORDS = stopwordsFrom(
  ['the', 'a', 'an', 'and', 'to', 'it', 'is', 'we', 'on', 'now', 'set', 'said', 'here', 'about', 'please', 'add', 'open', 'run', 'use', 'make', 'ask', 'today', 'tonight', 'again', 'post', 'file'],
  'bundled',
);

const BASE = Date.parse('2026-10-23T08:00:00.000Z');
const NOW = BASE + 60 * 60_000;

/** Real Wispr History.timestamp format, with `at` parsed from the ISO equivalent. */
function wisprTs(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', ' +00:00');
}
let seq = 0;
function dictation(minute: number, text: string): Dictation {
  const at = BASE + minute * 60_000 + 246;
  return { id: `d-${++seq}`, timestamp: wisprTs(at), at, app: 'com.github.Electron', formattedText: text, asrText: null };
}
/** The message sent 20 s after its dictation's paste. */
function message(minute: number, text: string, sessionId = 's1'): UserMessage {
  return { at: BASE + minute * 60_000 + 20_000, text, source: 'claude', sessionId };
}
/** A dictation the user sent unchanged: pairs, teaches vocabulary, yields no correction. */
function said(minute: number, text: string, sessionId = 's1'): { dictations: Dictation[]; messages: UserMessage[] } {
  return { dictations: [dictation(minute, text)], messages: [message(minute, text, sessionId)] };
}
function merge(...parts: Array<{ dictations: Dictation[]; messages: UserMessage[] }>): { dictations: Dictation[]; messages: UserMessage[] } {
  return {
    dictations: parts.flatMap((p) => p.dictations).sort((a, b) => a.at - b.at),
    messages: parts.flatMap((p) => p.messages).sort((a, b) => a.at - b.at),
  };
}
function row(phrase: string, observedSource: string | null, opts: Partial<DictionaryRow> = {}): DictionaryRow {
  return {
    id: `row-${phrase}`, phrase, replacement: null, observedSource, source: 'user_edits', manualEntry: false,
    isDeleted: false, frequencyUsed: 1, createdAt: '2026-10-01 00:00:00.000 +00:00', modifiedAt: '2026-10-01 00:00:00.000 +00:00',
    ...opts,
  };
}
function input(p: Partial<PlanInput>): PlanInput {
  return {
    dictations: [], messages: [], dictionary: [], stopwords: STOPWORDS, knownNames: [],
    ledger: emptyLedger('2026-10-22 00:00:00.000 +00:00'), nowMs: NOW, janitorDue: false, ...p,
  };
}

test('fixture timestamps match the real Wispr format', () => {
  const at = Date.parse('2026-10-23T08:31:10.246Z');
  assert.equal(wisprTs(at), '2026-10-23 08:31:10.246 +00:00');
  assert.equal(dictation(31, 'x y z').timestamp, '2026-10-23 08:31:00.246 +00:00');
});

test('(a) crown→cron in two dictations becomes one correction insert', () => {
  const plan = planTick(input({
    dictations: [dictation(1, 'please add the crown job tonight'), dictation(5, 'run the crown job again')],
    messages: [message(1, 'please add the cron job tonight'), message(5, 'run the cron job again')],
  }));
  const corrections = plan.inserts.filter((i) => i.kind === 'correction');
  assert.equal(corrections.length, 1);
  assert.deepEqual(
    { phrase: corrections[0].phrase, observedSource: corrections[0].observedSource, kind: corrections[0].kind, evidence: corrections[0].evidence },
    { phrase: 'cron', observedSource: 'crown', kind: 'correction', evidence: 2 },
  );
  assert.equal(corrections[0].why, 'seen 2× (crown→cron)');
  assert.equal(plan.paired, 2);
  assert.equal(plan.unpaired, 0);
  const rec = plan.ledger.inserts.find((i) => i.key === 'cron');
  assert.ok(rec);
  assert.equal(rec.at, NOW);
  assert.match(rec.id, /^[0-9a-f-]{36}$/);
});

test('(b) one fix of a word the user sends often is inserted on vocabulary evidence', () => {
  const plan = planTick(input({
    ...merge(
      { dictations: [dictation(1, 'ask here about the build')], messages: [message(1, 'ask peer about the build')] },
      said(3, 'the peer is done', 's2'),
      said(4, 'wake the peer again', 's2'),
    ),
  }));
  const ins = plan.inserts.find((i) => i.key === 'peer');
  assert.ok(ins, JSON.stringify(plan));
  assert.equal(ins.kind, 'correction');
  assert.equal(ins.observedSource, 'here');
  assert.equal(ins.evidence, 1);
  assert.equal(ins.why, 'vocabulary 3×');
});

test('(b) messages no dictation paired with (delegated-agent prompts) teach no vocabulary', () => {
  const plan = planTick(input({
    dictations: [dictation(1, 'ask here about the build')],
    messages: [message(1, 'ask peer about the build'), message(3, 'LANE: the peer is done', 's2'), message(30, 'You are being delegated: wake the peer', 's2')],
  }));
  assert.equal(plan.inserts.length, 0);
  // here→peer only passes the similarity bar as a word the user sends often; the two agent prompts must not make it one.
  assert.deepEqual(plan.rejected.map((r) => `${r.candidate.heard}→${r.candidate.sent}:${r.reason}`), ['here→peer:not-similar']);
  assert.equal(plan.ledger.vocab.peer.c, 1);
  assert.ok(!Object.hasOwn(plan.ledger.vocab, 'lane') && !Object.hasOwn(plan.ledger.vocab, 'delegated'));
  assert.equal(plan.ledger.messagesIngestedThrough, message(1, '').at);
});

test('(c) a single sighting waits for evidence, which the ledger keeps for the next tick', () => {
  const first = planTick(input({
    dictations: [dictation(1, 'please add the crown job tonight')],
    messages: [message(1, 'please add the cron job tonight')],
  }));
  assert.equal(first.inserts.length, 0);
  assert.deepEqual(first.skipped, [{ key: 'cron', reason: 'evidence' }]);
  assert.deepEqual(first.ledger.evidence.cron.dictationIds.length, 1);

  const second = planTick(input({
    ledger: first.ledger,
    dictations: [dictation(10, 'run the crown job again')],
    messages: [message(1, 'please add the cron job tonight'), message(10, 'run the cron job again')],
  }));
  assert.equal(second.inserts.length, 1);
  assert.equal(second.inserts[0].phrase, 'cron');
  assert.equal(second.inserts[0].evidence, 2);

  // Next tick the key is known through the ledger: never inserted twice.
  const third = planTick(input({
    ledger: second.ledger,
    dictations: [dictation(20, 'stop the crown job now')],
    messages: [message(20, 'stop the cron job now')],
  }));
  assert.equal(third.inserts.length, 0);
});

test('(d) stopwords, markup and slash commands are rejected', () => {
  const plan = planTick(input({
    dictations: [dictation(1, 'we said the flag now'), dictation(2, 'make the list nice today'), dictation(3, 'run the comet skill now')],
    messages: [message(1, 'we set the flag now'), message(2, 'make the li nice today'), message(3, 'run the /commit skill now')],
  }));
  const reasons = plan.rejected.map((r) => `${r.candidate.heard}→${r.candidate.sent}:${r.reason}`).sort();
  assert.deepEqual(reasons, ['comet→/commit:slash-command', 'list→li:markup', 'said→set:stopword']);
  assert.equal(plan.inserts.length, 0);
});

test('(e) dictionary rows, deleted ones included, are never re-learned', () => {
  const plan = planTick(input({
    dictionary: [row('Figma', 'Sigma'), row('Reddittiktok', 'Reddit', { isDeleted: true })],
    dictations: [
      dictation(1, 'open the Sigma file now'),
      dictation(2, 'post on Reddit today please'),
      dictation(3, 'post on Reddit again please'),
    ],
    messages: [
      message(1, 'open the Figma file now'),
      message(2, 'post on Reddittiktok today please'),
      message(3, 'post on Reddittiktok again please', 's2'),
      message(4, 'we like Reddittiktok a lot', 's3'),
    ],
  }));
  const reasons = plan.rejected.map((r) => `${r.candidate.sent}:${r.reason}`).sort();
  assert.deepEqual(reasons, ['Figma:in-dictionary', 'Reddittiktok:in-dictionary', 'Reddittiktok:in-dictionary']);
  assert.ok(!plan.inserts.some((i) => i.key === 'reddittiktok' || i.key === 'figma'), JSON.stringify(plan.inserts));
});

const TWO_FIXES = {
  dictations: [
    dictation(1, 'please add the crown job tonight'), dictation(2, 'run the crown job again'),
    dictation(3, 'open the jango panel now'), dictation(4, 'use the jango panel again'),
  ],
  messages: [
    message(1, 'please add the cron job tonight'), message(2, 'run the cron job again'),
    message(3, 'open the django panel now'), message(4, 'use the django panel again'),
  ],
};

test('(f) correctionsPerWeek holds back the overflow as cap', () => {
  const plan = planTick(input({ ...TWO_FIXES, caps: { correctionsPerWeek: 1 } }));
  assert.equal(plan.inserts.length, 1);
  assert.equal(plan.inserts[0].key, 'cron');
  assert.deepEqual(plan.skipped, [{ key: 'django', reason: 'cap' }]);

  // Inserts from earlier in the rolling week count against the cap.
  const ledger: LedgerState = emptyLedger('');
  ledger.inserts.push({ at: NOW - 2 * 24 * 60 * 60_000, kind: 'correction', phrase: 'Old', key: 'old', id: 'x' });
  const full = planTick(input({ ...TWO_FIXES, ledger, caps: { correctionsPerWeek: 1 } }));
  assert.equal(full.inserts.length, 0);
  assert.equal(full.skipped.filter((s) => s.reason === 'cap').length, 2);
});

test('(f) insertsPerTick caps corrections and vocabulary together', () => {
  const plan = planTick(input({
    ...TWO_FIXES,
    ...merge(TWO_FIXES, said(5, 'try smart-commit first', 'a'), said(6, 'then smart-commit again', 'b'), said(7, 'run smart-commit now', 'b')),
    caps: { insertsPerTick: 1 },
  }));
  assert.equal(plan.inserts.length, 1);
  assert.deepEqual(plan.skipped.map((s) => s.key).sort(), ['django', 'smart-commit']);
  assert.ok(plan.skipped.every((s) => s.reason === 'cap'));
  assert.equal(plan.ledger.inserts.length, 1);
});

const GLUE_ROWS = [
  row('Figma', 'Sigma', { frequencyUsed: 231 }),
  row('smart-commit', 'Comet', { frequencyUsed: 47 }),
  row('righttraits', 'right'),
  row('subtaskssubagent', 'subtasks'),
  row('partscards', 'parts', { frequencyUsed: 6 }),
  row('frameFLAME', 'frame', { frequencyUsed: 10 }),
  row('Reddittiktok', 'Reddit', { isDeleted: true, frequencyUsed: 0 }),
];

test('(g) janitor: due → deletes capped by deletesPerTick and lastJanitorAt set', () => {
  const plan = planTick(input({ dictionary: GLUE_ROWS, janitorDue: true, caps: { deletesPerTick: 2 } }));
  assert.equal(plan.deletes.length, 2);
  assert.deepEqual(plan.deletes.map((d) => d.phrase), ['righttraits', 'subtaskssubagent']);
  assert.equal(plan.ledger.lastJanitorAt, NOW);

  const all = planTick(input({ dictionary: GLUE_ROWS, janitorDue: true }));
  assert.deepEqual(all.deletes.map((d) => d.phrase), ['righttraits', 'subtaskssubagent', 'partscards', 'frameFLAME']);
});

test('(g) janitor: not due → no deletes, lastJanitorAt untouched', () => {
  const plan = planTick(input({ dictionary: GLUE_ROWS, janitorDue: false }));
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.ledger.lastJanitorAt, 0);
});

test('(h) cursor and message watermark advance; the input ledger is not mutated', () => {
  const ledger = emptyLedger('2026-10-22 00:00:00.000 +00:00');
  ledger.vocab.peer = { c: 1, s: ['s0'], f: { peer: 1 }, mid: 0, last: BASE };
  const snapshot = structuredClone(ledger);
  const inp = input({ ...TWO_FIXES, ledger });
  const before = structuredClone({ dictations: inp.dictations, messages: inp.messages, dictionary: inp.dictionary });
  const plan = planTick(inp);
  assert.deepEqual(ledger, snapshot);
  assert.deepEqual({ dictations: inp.dictations, messages: inp.messages, dictionary: inp.dictionary }, before);
  assert.notEqual(plan.ledger, ledger);
  assert.equal(plan.ledger.cursor, TWO_FIXES.dictations[3].timestamp);
  assert.equal(plan.ledger.messagesIngestedThrough, TWO_FIXES.messages[3].at);
  assert.ok(plan.inserts.length > 0);

  // Re-reading the same messages next tick does not count them again.
  const again = planTick(input({ ...TWO_FIXES, ledger: plan.ledger }));
  assert.equal(again.ledger.vocab.cron.c, plan.ledger.vocab.cron.c);
  assert.equal(again.ledger.messagesIngestedThrough, plan.ledger.messagesIngestedThrough);
  // No dictations → cursor stays.
  const idle = planTick(input({ ledger: plan.ledger, messages: TWO_FIXES.messages }));
  assert.equal(idle.ledger.cursor, plan.ledger.cursor);
});

const SMART_COMMIT = merge(said(1, 'try smart-commit first', 'a'), said(2, 'then smart-commit again', 'b'), said(3, 'run smart-commit now', 'b'));

test('(i) smart-commit sent 3× in 2 sessions becomes a vocabulary insert', () => {
  const plan = planTick(input({
    ...SMART_COMMIT,
  }));
  assert.deepEqual(plan.inserts, [
    { phrase: 'smart-commit', observedSource: null, kind: 'vocabulary', key: 'smart-commit', evidence: 3, why: 'name-like 3× in 2 sessions' },
  ]);
  assert.equal(plan.ledger.inserts[0].kind, 'vocabulary');

  const known = planTick(input({
    knownNames: ['smart-commit'],
    ...SMART_COMMIT,
  }));
  assert.equal(known.inserts[0].why, 'known-name 3×');

  const inDict = planTick(input({
    dictionary: [row('smart-commit', 'Comet')],
    ...SMART_COMMIT,
  }));
  assert.equal(inDict.inserts.length, 0);

  // Wispr already writes it, or it is one word of an existing phrase → no row.
  const wisprKnows = planTick(input({ ...SMART_COMMIT, wisprCounts: { 'smart-commit': 50 } }));
  assert.deepEqual(wisprKnows.inserts, []);
  assert.deepEqual(wisprKnows.skipped, [{ key: 'smart-commit', reason: 'wispr-knows' }]);
  const inPhrase = planTick(input({ ...SMART_COMMIT, dictionary: [row('smart-commit flow', null)] }));
  assert.deepEqual(inPhrase.skipped, [{ key: 'smart-commit', reason: 'in-dictionary' }]);
});

test('DEFAULT_CAPS are the pinned values', () => {
  assert.deepEqual(DEFAULT_CAPS, { correctionsPerWeek: 25, vocabularyPerWeek: 10, insertsPerTick: 10, deletesPerTick: 20 });
});

test('(j) wisprCounts: a word Wispr already writes is a rewrite; missing counts mean 0', () => {
  const parts = {
    dictations: [dictation(1, 'zrób tak takich plików nie ma'), dictation(5, 'i takich plików też nie')],
    messages: [message(1, 'zrób tak tych plików nie ma'), message(5, 'i tych plików też nie')],
  };
  const known = planTick(input({ ...parts, wisprCounts: { tych: 102 } }));
  assert.deepEqual(known.inserts, []);
  assert.deepEqual(known.rejected.map((r) => r.reason), ['wispr-knows', 'wispr-knows']);
  const unknown = planTick(input(parts));
  assert.deepEqual(unknown.inserts.map((i) => i.phrase), ['tych']);
});
