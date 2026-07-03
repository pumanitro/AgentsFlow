import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { placePinnedRefAfter, placePinnedRefAtEndOfFirstSection } from './pinned-order';
import { forkTitle } from '../shared/fork-title';
import type { PinnedItemRef } from '../shared/types';

const conv = (id: string): PinnedItemRef => ({ kind: 'conversation', id });
const div = (id: string): PinnedItemRef => ({ kind: 'divider', id });
const todo = (id: string): PinnedItemRef => ({ kind: 'todo', id });
const ids = (order: PinnedItemRef[]): string[] =>
  order.map((r) => `${r.kind === 'divider' ? 'D' : r.kind === 'todo' ? 'T' : ''}${r.id}`);

describe('placePinnedRefAtEndOfFirstSection', () => {
  it('appends to the very end when there are no dividers', () => {
    const order = [conv('a'), conv('b')];
    const next = placePinnedRefAtEndOfFirstSection(order, conv('new'));
    assert.deepEqual(ids(next), ['a', 'b', 'new']);
  });

  it('appends to the end of an empty list', () => {
    const next = placePinnedRefAtEndOfFirstSection([], conv('new'));
    assert.deepEqual(ids(next), ['new']);
  });

  it('lands at the BOTTOM of the first group, right before the second divider', () => {
    // [D1, a, b, D2, c] → new goes after b, before D2.
    const order = [div('1'), conv('a'), conv('b'), div('2'), conv('c')];
    const next = placePinnedRefAtEndOfFirstSection(order, conv('new'));
    assert.deepEqual(ids(next), ['D1', 'a', 'b', 'new', 'D2', 'c']);
  });

  it('never lands above the first divider (the zero-zero bug)', () => {
    const order = [div('1'), conv('a'), div('2'), conv('b')];
    const next = placePinnedRefAtEndOfFirstSection(order, conv('new'));
    assert.notEqual(ids(next)[0], 'new', 'new row must not be at position 0');
    assert.deepEqual(ids(next), ['D1', 'a', 'new', 'D2', 'b']);
  });

  it('falls back to the end of the list when there is only one divider', () => {
    const order = [div('1'), conv('a'), conv('b')];
    const next = placePinnedRefAtEndOfFirstSection(order, conv('new'));
    assert.deepEqual(ids(next), ['D1', 'a', 'b', 'new']);
  });

  it('lands in the first group even when the divider is empty', () => {
    // First divider heads an empty group, second divider follows immediately.
    const order = [div('1'), div('2'), conv('c')];
    const next = placePinnedRefAtEndOfFirstSection(order, conv('new'));
    assert.deepEqual(ids(next), ['D1', 'new', 'D2', 'c']);
  });

  it('ignores rows above the first divider and uses the first headed group', () => {
    const order = [conv('x'), div('1'), conv('a'), div('2'), conv('c')];
    const next = placePinnedRefAtEndOfFirstSection(order, conv('new'));
    assert.deepEqual(ids(next), ['x', 'D1', 'a', 'new', 'D2', 'c']);
  });

  it('moves an existing ref rather than duplicating it', () => {
    const order = [div('1'), conv('a'), conv('new'), div('2'), conv('c')];
    const next = placePinnedRefAtEndOfFirstSection(order, conv('new'));
    // 'new' is removed from its old slot and re-placed at the bottom of group 1.
    assert.deepEqual(ids(next), ['D1', 'a', 'new', 'D2', 'c']);
    assert.equal(next.filter((r) => r.id === 'new').length, 1);
  });

  it('does not mutate the input array', () => {
    const order = [div('1'), conv('a')];
    const snapshot = ids(order);
    placePinnedRefAtEndOfFirstSection(order, conv('new'));
    assert.deepEqual(ids(order), snapshot);
  });
});

describe('placePinnedRefAfter', () => {
  it('lands directly below the anchor, inside its section', () => {
    const order = [div('1'), conv('a'), conv('b'), div('2'), conv('c')];
    const next = placePinnedRefAfter(order, conv('fork'), conv('a'));
    assert.deepEqual(ids(next), ['D1', 'a', 'fork', 'b', 'D2', 'c']);
  });

  it('works when the anchor is the last item of the list', () => {
    const order = [div('1'), conv('a')];
    const next = placePinnedRefAfter(order, conv('fork'), conv('a'));
    assert.deepEqual(ids(next), ['D1', 'a', 'fork']);
  });

  it('moves an existing ref rather than duplicating it', () => {
    const order = [conv('fork'), div('1'), conv('a'), conv('b')];
    const next = placePinnedRefAfter(order, conv('fork'), conv('b'));
    assert.deepEqual(ids(next), ['D1', 'a', 'b', 'fork']);
    assert.equal(next.filter((r) => r.id === 'fork').length, 1);
  });

  it('falls back to the end of the first section when the anchor is absent', () => {
    const order = [div('1'), conv('a'), div('2'), conv('c')];
    const next = placePinnedRefAfter(order, conv('fork'), conv('ghost'));
    assert.deepEqual(ids(next), ['D1', 'a', 'fork', 'D2', 'c']);
  });

  it('does not mutate the input array', () => {
    const order = [div('1'), conv('a')];
    const snapshot = ids(order);
    placePinnedRefAfter(order, conv('fork'), conv('a'));
    assert.deepEqual(ids(order), snapshot);
  });

  it('places a todo below its anchor and never collides with a same-id conversation', () => {
    // Same id under different kinds must be treated as distinct refs.
    const order = [div('1'), conv('x'), conv('b')];
    const next = placePinnedRefAfter(order, todo('x'), conv('b'));
    assert.deepEqual(ids(next), ['D1', 'x', 'b', 'Tx']);
  });

  it('sections work for todos like for conversations', () => {
    const order = [div('1'), conv('a'), div('2'), conv('c')];
    const next = placePinnedRefAtEndOfFirstSection(order, todo('t'));
    assert.deepEqual(ids(next), ['D1', 'a', 'Tt', 'D2', 'c']);
  });
});

describe('forkTitle', () => {
  it('prefixes a plain title with V2', () => {
    assert.equal(forkTitle('Fix the parser'), 'V2 · Fix the parser');
  });

  it('bumps the version on re-fork instead of stacking prefixes', () => {
    assert.equal(forkTitle('V2 · Fix the parser'), 'V3 · Fix the parser');
    assert.equal(forkTitle('V9 · Fix the parser'), 'V10 · Fix the parser');
  });

  it('handles an empty source title', () => {
    assert.equal(forkTitle(''), 'V2 · forked chat');
  });

  it('caps the result at 80 chars', () => {
    assert.ok(forkTitle('x'.repeat(200)).length <= 80);
  });
});
