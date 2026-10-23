import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { WISPR_KNOWS_MIN, extractCandidates, filterCandidates, judgeCandidate } from './candidates';
import { pairDictation } from './pairing';
import type { FilterContext, PairResult, RawCandidate } from './types';

const STOP = new Set(['set', 'said', 'the', 'a', 'i', 'one', 'two', 'hours', 'dane']);
const VOCAB: Record<string, number> = { 'smart-commit': 5, peer: 4 };
// Measured over Wispr's own History.formattedText, last 90 days (2026-10-23).
const WISPR: Record<string, number> = {
  to: 10109, do: 2388, go: 563, żeby: 261, chart: 240, figma: 203, set: 130, tych: 102, jakie: 53, 5090: 44, peer: 32,
  worktree: 22, nutrable: 21, aci: 15, powinno: 15, cron: 13, vasta: 7, oprogramowanie: 4, wat: 2,
};
const ctx: FilterContext = {
  isStopword: (k) => STOP.has(k),
  inDictionary: (k) => k === 'figma',
  vocabCount: (k) => VOCAB[k] ?? 0,
  wisprCount: (k) => (Object.hasOwn(WISPR, k) ? WISPR[k] : 0),
};

function raw(heard: string, sent: string): RawCandidate {
  return { heard, sent, dictationId: 'd1', messageAt: 1 };
}
function reason(heard: string, sent: string): string {
  const v = judgeCandidate(raw(heard, sent), ctx);
  return v.ok ? 'ok' : v.reason;
}

const T0 = Date.parse('2026-10-22T08:00:00.000Z');
function crownPair(): PairResult {
  const p = pairDictation(
    { id: 'd1', timestamp: '', at: T0, app: 'com.github.Electron', formattedText: 'Set up a crown job on the 50/90 so the here daemon restarts', asrText: null },
    [{ at: T0 + 30_000, text: 'Set up a cron job on the 5090 so the peer daemon restarts', source: 'claude', sessionId: 's' }],
  );
  assert.ok(p);
  return p;
}

test('crown/50-90/here example: every swap is extracted and accepted', () => {
  const rawCands = extractCandidates(crownPair());
  assert.deepEqual(rawCands.map((c) => [c.heard, c.sent]), [['crown', 'cron'], ['50/90', '5090'], ['here', 'peer']]);
  assert.ok(rawCands.every((c) => c.dictationId === 'd1' && c.messageAt === T0 + 30_000));
  const { accepted, rejected } = filterCandidates(rawCands, ctx);
  assert.deepEqual(rejected, []);
  assert.deepEqual(accepted.map((c) => c.key), ['cron', '5090', 'peer']);
  const peer = accepted[2];
  assert.equal(peer.inVocabulary, true);
  assert.equal(peer.soundsAlike, false);
});

test('extractCandidates skips long replaces and insert/delete ops', () => {
  const pair: PairResult = {
    ...crownPair(),
    heard: ['a', 'b', 'c', 'd', 'e', 'f'],
    sent: ['a', 'w', 'x', 'y', 'z', 'f', 'g'],
    ops: [
      { kind: 'equal', a0: 0, a1: 1, b0: 0, b1: 1 },
      { kind: 'replace', a0: 1, a1: 5, b0: 1, b1: 5 },
      { kind: 'equal', a0: 5, a1: 6, b0: 5, b1: 6 },
      { kind: 'insert', a0: 6, a1: 6, b0: 6, b1: 7 },
    ],
  };
  assert.deepEqual(extractCandidates(pair), []);
});

test('accepted fixtures', () => {
  const ascii = judgeCandidate(raw('ascii', 'ACI'), ctx);
  assert.ok(ascii.ok);
  assert.equal(ascii.candidate.similarity, 0.6);
  assert.equal(ascii.candidate.key, 'aci');

  const vat = judgeCandidate(raw('vat', 'wat'), ctx);
  assert.ok(vat.ok);
  assert.equal(vat.candidate.soundsAlike, true);

  const comet = judgeCandidate(raw('Comet', 'smart-commit'), ctx);
  assert.ok(comet.ok);
  assert.equal(comet.candidate.inVocabulary, true);
  assert.ok(comet.candidate.similarity < 0.5);
});

test('rejected fixtures name the first matching rule', () => {
  const cases: Array<[string, string, string]> = [
    ['Sigma', 'Figma', 'in-dictionary'],
    ['said', 'set', 'stopword'],
    ['ol li', '1.', 'markup'],
    ['x', '/renter-check', 'slash-command'],
    ['two hours', '2hrs', 'not-similar'],
    ['1,000', '1000', 'number-format'],
    ['dane.', 'stronę. plan-and-execute', 'not-similar'],
    ['Cron', 'cron', 'case-only'],
    ['cron', 'cron', 'identical'],
    ['one two three four', 'x', 'too-long'],
    ['x', 'a'.repeat(41), 'too-long'],
    ['config', 'see `cfg`', 'markup'],
    ['dot', 'sferis.pl/x', 'url-or-path'],
    ['home', '~', 'url-or-path'],
    ['at', 'me@x.pl', 'url-or-path'],
    ['dash', '—', 'punctuation'],
    ['bee', 'b', 'too-short'],
  ];
  for (const [heard, sent, want] of cases) assert.equal(reason(heard, sent), want, `${heard} → ${sent}`);
});

test('filterCandidates splits accepted and rejected, keeping the raw candidate', () => {
  const r = filterCandidates([raw('vat', 'wat'), raw('said', 'set')], ctx);
  assert.deepEqual(r.accepted.map((c) => c.sent), ['wat']);
  assert.deepEqual(r.rejected, [{ candidate: raw('said', 'set'), reason: 'stopword' }]);
});

test('Polish grammar rewrites are rejected: words Wispr already writes, or the same word with another ending', () => {
  const cases: Array<[string, string, string]> = [
    ['że', 'żeby', 'wispr-knows'],
    ['to', 'go', 'wispr-knows'],
    ['takich', 'tych', 'wispr-knows'],
    ['powinny', 'To powinno', 'inflection'],
    ['jakiego oprogramowania używa', 'jakie oprogramowanie', 'inflection'],
    ['posegregowane wykresy', 'posegregowany chart', 'inflection'],
  ];
  for (const [heard, sent, want] of cases) assert.equal(reason(heard, sent), want, `${heard} → ${sent}`);
});

test('recognition fixes survive the Wispr-knows and inflection rules', () => {
  const cases: Array<[string, string]> = [
    ['crown', 'cron'], ['50/90', '5090'], ['VAT', 'WAT'], ['wasta', 'VASTA'], ['here', 'Peer'], ['ascii', 'ACI'],
    ['utilization', 'utilisation'],
  ];
  for (const [heard, sent] of cases) assert.equal(reason(heard, sent), 'ok', `${heard} → ${sent}`);
});

test('wispr-knows needs every sent word at the threshold; inflection never fires on digits', () => {
  const at = (n: number): FilterContext => ({ ...ctx, wisprCount: (k) => (k === 'kubernetes' ? n : 0) });
  assert.equal(judgeCandidate(raw('cubernetis', 'kubernetes'), at(WISPR_KNOWS_MIN)).ok, false);
  assert.equal(judgeCandidate(raw('cubernetis', 'kubernetes'), at(WISPR_KNOWS_MIN - 1)).ok, true);
  assert.equal(reason('tych rzeczy', 'tych rzeczach'), 'inflection');
  assert.equal(reason('sieć', 'sieci'), 'inflection');  // ć/ci alternation, compared with diacritics folded
  assert.equal(reason('model4090', 'model4080'), 'ok');
});
