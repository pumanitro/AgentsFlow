import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UserMessage, VocabStats } from './types';
import { collectKnownNames, ingestMessages, mineVocabulary, pruneVocab } from './vocabulary';

const DAY = 24 * 60 * 60 * 1000;
const STOP = new Set(['the', 'and', 'now', 'open', 'is', 'run', 'for']);
const isStopword = (k: string) => STOP.has(k);

function msg(text: string, sessionId = 's1', at = 1000): UserMessage {
  return { at, text, source: 'claude', sessionId };
}

test('ingestMessages counts tokens, forms, sessions and last-seen', () => {
  const stats: VocabStats = {};
  ingestMessages(stats, [msg('deploy the Deploy', 's1', 10), msg('deploy again', 's2', 30), msg('deploy', 's1', 20)], isStopword);
  assert.equal(stats.deploy.c, 4);
  assert.deepEqual(stats.deploy.s, ['s1', 's2']);
  assert.deepEqual(stats.deploy.f, { deploy: 3, Deploy: 1 });
  assert.equal(stats.deploy.last, 30);
  assert.equal(stats.the, undefined, 'stopword skipped');
});

test('ingestMessages keeps at most 5 sessions and 3 surface forms', () => {
  const stats: VocabStats = {};
  const forms = ['figma', 'Figma', 'FIGMA', 'FiGmA', 'fIGMA'];
  ingestMessages(stats, Array.from({ length: 8 }, (_, i) => msg(forms[i % forms.length], `s${i}`)), isStopword);
  assert.equal(stats.figma.c, 8);
  assert.equal(stats.figma.s.length, 5);
  assert.deepEqual(Object.keys(stats.figma.f), ['figma', 'Figma', 'FIGMA']);
});

test('ingestMessages skips short, numeric, path-like and slash-command tokens', () => {
  const stats: VocabStats = {};
  ingestMessages(stats, [msg('ok 12345 50/90 src/main.ts /commit ab')], isStopword);
  assert.deepEqual(Object.keys(stats), []);
});

test('a capital counts as mid-sentence only after other words on the same sentence', () => {
  const stats: VocabStats = {};
  ingestMessages(stats, [msg('Open Figma now')], isStopword);
  assert.equal(stats.figma.mid, 1);

  const s2: VocabStats = {};
  ingestMessages(s2, [msg('Figma is open'), msg('done. Figma next'), msg('line\nFigma'), msg('why? Figma'), msg('note: Figma')], isStopword);
  assert.equal(s2.figma.c, 5);
  assert.equal(s2.figma.mid, 0);
});

test('"constructor" is counted like any other word', () => {
  const stats: VocabStats = {};
  ingestMessages(stats, [msg('constructor constructor')], isStopword);
  const k: string = 'constructor';
  assert.equal(stats[k].c, 2);
});

test('pruneVocab drops stale keys, then the oldest beyond maxKeys', () => {
  const now = 100 * DAY;
  const stats: VocabStats = {};
  ingestMessages(stats, [msg('ancient', 's', now - 40 * DAY), msg('older', 's', now - 3 * DAY), msg('newer', 's', now - DAY), msg('newest', 's', now)], isStopword);
  pruneVocab(stats, now, { maxKeys: 2 });
  assert.deepEqual(Object.keys(stats).sort(), ['newer', 'newest']);
});

test('mineVocabulary picks names and leaves plain words alone', () => {
  const stats: VocabStats = {};
  const messages: UserMessage[] = [];
  for (let i = 0; i < 5; i++) {
    const sid = `s${i % 2}`;
    messages.push(msg('please run smart-commit and implement it', sid));
    messages.push(msg('I asked WYTFURNIA about sferis.pl', sid));
    messages.push(msg('agentsflow needs a fix, implement it', sid));
    messages.push(msg('check the Kubernetes setup', sid));
  }
  messages.push(msg('rare-word once', 's0'), msg('rare-word twice', 's0'), msg('rare-word thrice', 's0')); // one session only
  ingestMessages(stats, messages, isStopword);

  const out = mineVocabulary(stats, {
    isStopword,
    inDictionary: (k) => k === 'kubernetes',
    knownNames: ['AgentsFlow'],
  });
  const byKey = Object.fromEntries(out.map((c) => [c.key, c]));
  assert.equal(byKey['smart-commit']?.why, 'name-like');
  assert.equal(byKey.wytfurnia?.why, 'name-like');
  assert.equal(byKey.wytfurnia?.word, 'WYTFURNIA');
  assert.equal(byKey['sferis.pl']?.why, 'name-like');
  assert.equal(byKey.agentsflow?.why, 'known-name');
  assert.equal(byKey.agentsflow?.count, 5);
  assert.equal(byKey.agentsflow?.sessions, 2);
  assert.equal(byKey.implement, undefined, 'plain lowercase word');
  assert.equal(byKey.kubernetes, undefined, 'already in the dictionary');
  assert.equal(byKey['rare-word'], undefined, 'seen in one session only');
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].count >= out[i].count, 'sorted by count');
});

test('mineVocabulary respects minCount and the mid-sentence share', () => {
  const stats: VocabStats = {};
  ingestMessages(stats, [msg('ask Lisa', 'a'), msg('ask Lisa', 'b'), msg('Lisa said', 'a')], isStopword);
  const ctx = { isStopword, inDictionary: () => false, knownNames: [] };
  assert.deepEqual(mineVocabulary(stats, ctx).map((c) => c.key), [], 'mid 2/3 < 0.7');
  ingestMessages(stats, [msg('ask Lisa', 'b')], isStopword);
  assert.deepEqual(mineVocabulary(stats, ctx).map((c) => c.word), ['Lisa'], 'mid 3/4 ≥ 0.7');
  assert.deepEqual(mineVocabulary(stats, ctx, { minCount: 5 }), []);
});

test('collectKnownNames reads peers, skills and agents, deduped', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'smart-commit'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'browser-harness'));
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'README.txt'), '');
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'agents', 'browser-operator.md'), '');
  fs.writeFileSync(path.join(home, '.claude', 'agents', 'notes.txt'), '');
  const names = collectKnownNames(['/x/AgentsFlow', '/y/AgentsFlow/', '/z/smart-commit', ''], home);
  assert.deepEqual(names.sort(), ['AgentsFlow', 'browser-harness', 'browser-operator', 'smart-commit']);
});

test('collectKnownNames tolerates a home without .claude', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-home-'));
  assert.deepEqual(collectKnownNames([], home), []);
});
