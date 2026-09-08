import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { blockStepDropIndex, marqueeHits, moveRefsTo, refKey } from '../shared/pinned-selection';
import type { PinnedItemRef } from '../shared/types';

// Compact fixture: a separator followed by six conversations, the shape the
// pinned list actually has.
const ORDER: PinnedItemRef[] = [
  { kind: 'divider', id: 'v1' },
  ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => ({ kind: 'conversation', id } as PinnedItemRef)),
];
const KEYS = ORDER.map(refKey);
const sel = (...ids: string[]) => new Set(ids.map((id) => `conversation:${id}`));
const ids = (order: PinnedItemRef[] | null) => (order ?? []).map((r) => r.id).join(',');

// Row bands as the list lays them out: 32px tall, stacked from y=100.
const BOXES = KEYS.map((key, i) => ({ key, top: 100 + i * 32, bottom: 132 + i * 32 }));

describe('marqueeHits', () => {
  it('catches every row the band crosses, in either drag direction', () => {
    const down = marqueeHits(BOXES, 140, 200);
    assert.deepEqual([...down], ['conversation:c1', 'conversation:c2', 'conversation:c3']);
    assert.deepEqual([...marqueeHits(BOXES, 200, 140)], [...down]);
  });

  it('catches a row the band only clips the edge of', () => {
    assert.deepEqual([...marqueeHits(BOXES, 95, 101)], ['divider:v1']);
  });

  it('catches nothing above or below every row', () => {
    assert.equal(marqueeHits(BOXES, 0, 99).size, 0);
    assert.equal(marqueeHits(BOXES, 400, 500).size, 0);
  });

  it('a band that merely touches a boundary catches neither neighbour', () => {
    assert.equal(marqueeHits(BOXES, 132, 132).size, 0);
  });

  it('a tall band catches the whole list', () => {
    assert.equal(marqueeHits(BOXES, 0, 1000).size, KEYS.length);
  });
});

describe('moveRefsTo', () => {
  it('moves a single row down', () => {
    assert.equal(ids(moveRefsTo(ORDER, sel('c2'), 4)), 'v1,c1,c3,c2,c4,c5,c6');
  });

  it('moves a contiguous block and keeps its internal order', () => {
    assert.equal(ids(moveRefsTo(ORDER, sel('c2', 'c3', 'c4'), 1)), 'v1,c2,c3,c4,c1,c5,c6');
  });

  it('moves a block to the very end', () => {
    assert.equal(ids(moveRefsTo(ORDER, sel('c1', 'c2'), ORDER.length)), 'v1,c3,c4,c5,c6,c1,c2');
  });

  it('collapses a scattered selection at the drop point, in list order', () => {
    assert.equal(ids(moveRefsTo(ORDER, sel('c1', 'c4', 'c6'), 0)), 'c1,c4,c6,v1,c2,c3,c5');
  });

  it('returns null for a no-op drop (dropped back where it already was)', () => {
    assert.equal(moveRefsTo(ORDER, sel('c2'), 2), null);
    assert.equal(moveRefsTo(ORDER, new Set(), 3), null);
  });

  it('clamps a drop index past the end instead of losing rows', () => {
    assert.equal(ids(moveRefsTo(ORDER, sel('c1'), 99)), 'v1,c2,c3,c4,c5,c6,c1');
  });
});

describe('blockStepDropIndex + moveRefsTo (Shift+arrow stepping)', () => {
  const step = (movingKeys: Set<string>, dir: 'up' | 'down') => {
    const at = blockStepDropIndex(KEYS, movingKeys, dir);
    return at === null ? null : moveRefsTo(ORDER, movingKeys, at);
  };

  it('steps a contiguous block down by exactly one row', () => {
    assert.equal(ids(step(sel('c2', 'c3'), 'down')), 'v1,c1,c4,c2,c3,c5,c6');
  });

  it('steps a contiguous block up by exactly one row', () => {
    assert.equal(ids(step(sel('c2', 'c3'), 'up')), 'v1,c2,c3,c1,c4,c5,c6');
  });

  it('steps a single row, the pre-existing behaviour', () => {
    assert.equal(ids(step(sel('c5'), 'up')), 'v1,c1,c2,c3,c5,c4,c6');
    assert.equal(ids(step(sel('c5'), 'down')), 'v1,c1,c2,c3,c4,c6,c5');
  });

  it('refuses to step past either end of the list', () => {
    assert.equal(blockStepDropIndex(KEYS, new Set(['divider:v1']), 'up'), null);
    assert.equal(blockStepDropIndex(KEYS, sel('c6'), 'down'), null);
    assert.equal(blockStepDropIndex(KEYS, new Set(), 'down'), null);
  });

  it('gathers a scattered selection as it steps', () => {
    assert.equal(ids(step(sel('c1', 'c3'), 'down')), 'v1,c2,c4,c1,c3,c5,c6');
  });
});
