import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { TrackedDirectory } from '../../shared/types';
import { buildVocabulary } from './vocabulary';

const dirs = [
  { id: 'd1', path: '/Users/x/Desktop/AgentsFlow', displayName: 'Peers Flow app' },
  { id: 'd2', path: '/Users/x/Desktop/LISA', displayName: 'lisa' },
  { id: 'd3', path: '/Users/x/case-challenge', displayName: 'Case Challenge' },
] as TrackedDirectory[];

describe('buildVocabulary', () => {
  test('dedupes case-insensitively, splits tokens, keeps fixed words', () => {
    const v = buildVocabulary(dirs, ['KSeF', '<ksef>', 'Żółć-test', 'ab'], '2026-10-28T12:00:00.000Z');
    assert.equal(v.updatedAt, '2026-10-28T12:00:00.000Z');
    for (const w of ['Peers Flow', 'LISA', 'Claude', 'Codex', 'Peers Flow app', 'AgentsFlow', 'case-challenge', 'Challenge', 'KSeF', 'Żółć-test', 'Żółć', 'test', 'ab']) {
      assert.ok(v.words.includes(w), `missing ${w}`);
    }
    const lower = v.words.map((w) => w.toLowerCase());
    assert.equal(new Set(lower).size, lower.length);
    assert.ok(!v.words.includes('lisa'));       // first spelling (LISA) wins
    assert.ok(!v.words.some((w) => /[<>]/.test(w)));
  });
  test('capped at 200', () => {
    const extra = Array.from({ length: 500 }, (_, i) => `word${i}`);
    assert.equal(buildVocabulary([], extra, 'now').words.length, 200);
  });
});
