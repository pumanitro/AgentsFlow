import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bagOverlap, levenshtein, matchScore, phoneticKey, similarity, soundsAlike, wordDiff } from './diff';

test('wordDiff: a swapped word is one replace between equal runs', () => {
  const a = 'set up a crown job'.split(' ');
  const b = 'set up a cron job'.split(' ');
  assert.deepEqual(wordDiff(a, b), [
    { kind: 'equal', a0: 0, a1: 3, b0: 0, b1: 3 },
    { kind: 'replace', a0: 3, a1: 4, b0: 3, b1: 4 },
    { kind: 'equal', a0: 4, a1: 5, b0: 4, b1: 5 },
  ]);
});

test('wordDiff: insert and delete when only one side changes', () => {
  assert.deepEqual(wordDiff(['a', 'b'], ['a', 'x', 'b']), [
    { kind: 'equal', a0: 0, a1: 1, b0: 0, b1: 1 },
    { kind: 'insert', a0: 1, a1: 1, b0: 1, b1: 2 },
    { kind: 'equal', a0: 1, a1: 2, b0: 2, b1: 3 },
  ]);
  assert.deepEqual(wordDiff(['a', 'x', 'b'], ['a', 'b']), [
    { kind: 'equal', a0: 0, a1: 1, b0: 0, b1: 1 },
    { kind: 'delete', a0: 1, a1: 2, b0: 1, b1: 1 },
    { kind: 'equal', a0: 2, a1: 3, b0: 1, b1: 2 },
  ]);
  assert.deepEqual(wordDiff([], ['x']), [{ kind: 'insert', a0: 0, a1: 0, b0: 0, b1: 1 }]);
  assert.deepEqual(wordDiff([], []), []);
});

test('wordDiff: ops cover both sequences contiguously', () => {
  const a = 'the quick brown fox jumps over the lazy dog'.split(' ');
  const b = 'a quick red fox leaped over lazy dogs today'.split(' ');
  const ops = wordDiff(a, b);
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    assert.equal(op.a0, ai);
    assert.equal(op.b0, bi);
    if (op.kind === 'equal') assert.deepEqual(a.slice(op.a0, op.a1), b.slice(op.b0, op.b1));
    ai = op.a1;
    bi = op.b1;
  }
  assert.equal(ai, a.length);
  assert.equal(bi, b.length);
});

test('wordDiff gives up on huge inputs and matchScore falls back to bagOverlap', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `w${i % 50}`);
  const b = Array.from({ length: 1000 }, (_, i) => `w${i % 25}`);
  assert.deepEqual(wordDiff(a, b), []);
  assert.equal(matchScore(a, b), bagOverlap(a, b));
  assert.equal(bagOverlap(a, b), 0.5);
});

test('bagOverlap and matchScore', () => {
  assert.equal(bagOverlap(['a', 'b', 'c', 'd'], ['d', 'a']), 0.5);
  assert.equal(bagOverlap([], ['a']), 0);
  // Order matters for matchScore, not for bagOverlap.
  assert.equal(bagOverlap(['a', 'b', 'c'], ['c', 'b', 'a']), 1);
  assert.equal(matchScore(['a', 'b', 'c'], ['c', 'b', 'a']), 1 / 3);
  assert.equal(matchScore(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd']), 0.75);
  assert.equal(matchScore([], ['a']), 0);
});

test('levenshtein and similarity', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('same', 'same'), 0);
  assert.equal(similarity('ascii', 'ACI'), 0.6);
  assert.equal(similarity('Cron', 'cron.'), 1);
  assert.equal(similarity('', 'x'), 0);
  assert.equal(similarity('crown', 'cron'), 0.8);
});

test('phoneticKey and soundsAlike', () => {
  assert.equal(phoneticKey('vat'), 'vt');
  assert.equal(phoneticKey('wat'), 'vt');
  assert.equal(phoneticKey('Phone'), 'fn');
  assert.equal(phoneticKey('ascii'), 'as');
  assert.equal(phoneticKey('Łódź'), 'ldz');
  assert.equal(phoneticKey('city'), 'st');
  assert.equal(phoneticKey('123'), '');
  assert.equal(soundsAlike('vat', 'wat'), true);
  assert.equal(soundsAlike('here', 'peer'), false);
  assert.equal(soundsAlike('12', '34'), false);
});
