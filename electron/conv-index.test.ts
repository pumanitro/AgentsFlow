import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { makeIndexer } from './conv-index';

interface Row { id: string; state?: string }
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));

describe('makeIndexer', () => {
  it('maps every id to its position', () => {
    const index = makeIndexer<Row>();
    const m = index(rows('a', 'b', 'c'));
    assert.deepEqual([...m.entries()], [['a', 0], ['b', 1], ['c', 2]]);
  });

  it('reuses the same Map for the same array — the point of the memo', () => {
    const index = makeIndexer<Row>();
    const arr = rows('a', 'b');
    assert.equal(index(arr), index(arr));
  });

  it('rebuilds when the array is replaced, even with identical contents', () => {
    const index = makeIndexer<Row>();
    const first = index(rows('a', 'b'));
    const second = index(rows('a', 'b'));
    assert.notEqual(first, second);
    assert.deepEqual([...second.entries()], [['a', 0], ['b', 1]]);
  });

  it('stays correct after a filter — the shape removeConversation uses', () => {
    const index = makeIndexer<Row>();
    const arr = rows('a', 'b', 'c');
    index(arr);
    const m = index(arr.filter((r) => r.id !== 'b'));
    assert.deepEqual([...m.entries()], [['a', 0], ['c', 1]]);
  });

  it('stays correct after a prepend — the shape addConversation uses', () => {
    const index = makeIndexer<Row>();
    const arr = rows('a', 'b');
    index(arr);
    const m = index([{ id: 'new' }, ...arr]);
    assert.deepEqual([...m.entries()], [['new', 0], ['a', 1], ['b', 2]]);
  });

  it('an in-place field update keeps positions valid (updateConversation)', () => {
    const index = makeIndexer<Row>();
    const arr = rows('a', 'b', 'c');
    const idx = index(arr).get('b')!;
    arr[idx] = { ...arr[idx], state: 'done' };
    // Same array object, same positions — the memo is still the right answer.
    assert.equal(index(arr).get('b'), 1);
    assert.equal(arr[index(arr).get('b')!].state, 'done');
  });

  it('a map() over the array reindexes (the poller writes a fresh array each tick)', () => {
    const index = makeIndexer<Row>();
    const arr = rows('a', 'b', 'c');
    index(arr);
    const next = arr.map((r) => (r.id === 'c' ? { ...r, state: 'working' } : r));
    const m = index(next);
    assert.equal(m.get('c'), 2);
    assert.equal(next[m.get('c')!].state, 'working');
  });

  it('an unknown id is undefined, not 0', () => {
    const index = makeIndexer<Row>();
    assert.equal(index(rows('a')).get('nope'), undefined);
  });

  it('empty and duplicate-id inputs do not throw (last duplicate wins)', () => {
    const index = makeIndexer<Row>();
    assert.equal(index([]).size, 0);
    assert.equal(index(rows('a', 'a')).get('a'), 1);
  });

  it('two indexers are independent', () => {
    const a = makeIndexer<Row>();
    const b = makeIndexer<Row>();
    const arr = rows('x');
    assert.notEqual(a(arr), b(arr));
  });
});
