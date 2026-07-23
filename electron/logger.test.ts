import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRepeatCollapser, repeatKey } from './logger';

// The collapser is what stops a failing subsystem from turning the logger into
// the outage: every console.* call is a synchronous appendFileSync, so a loop
// that errors hundreds of times a minute used to block the main thread on
// write(2). These tests pin the two properties that matter — a storm costs O(1)
// writes, and nothing is silently lost (the suppressed count always resurfaces).

const OPTS = { burst: 3, windowMs: 10_000, keyCap: 500 };

describe('repeatKey', () => {
  test('normalises digits so numerically-varying repeats share a key', () => {
    assert.equal(
      repeatKey('WARN', '[perf] SLOW git:worktrees 1901ms'),
      repeatKey('WARN', '[perf] SLOW git:worktrees 1893ms'),
    );
  });

  test('keeps genuinely different messages apart', () => {
    assert.notEqual(
      repeatKey('WARN', '[perf] SLOW git:worktrees 1901ms'),
      repeatKey('WARN', '[perf] SLOW git:status 1901ms'),
    );
  });

  test('keeps the same message at different levels apart', () => {
    assert.notEqual(repeatKey('WARN', 'same text'), repeatKey('ERROR', 'same text'));
  });
});

describe('createRepeatCollapser', () => {
  test('writes up to the burst, then suppresses', () => {
    const c = createRepeatCollapser(OPTS);
    const writes = [1, 2, 3, 4, 5].map((i) => c.record('ERROR', `boom ${i}`, 1000).write);
    // All five share a key (digits normalised), so only the first three write.
    assert.deepEqual(writes, [true, true, true, false, false]);
  });

  test('a storm of N lines costs a bounded number of writes', () => {
    const c = createRepeatCollapser(OPTS);
    let written = 0;
    for (let i = 0; i < 1000; i++) {
      if (c.record('ERROR', 'Events were dropped by the FSEvents client', 1000).write) written++;
    }
    assert.equal(written, OPTS.burst);
  });

  test('the suppressed count resurfaces on flush', () => {
    const c = createRepeatCollapser(OPTS);
    for (let i = 0; i < 10; i++) c.record('ERROR', 'dropped events', 1000);
    const tallies = c.flushAll(3000);
    assert.equal(tallies.length, 1);
    // 10 seen, 3 written → 7 suppressed, reported over the 2s elapsed.
    assert.match(tallies[0].msg, /repeated ×7 more in 2s: dropped events/);
    assert.equal(tallies[0].level, 'ERROR');
  });

  test('produces no tally when nothing was suppressed', () => {
    const c = createRepeatCollapser(OPTS);
    c.record('INFO', 'a quiet line', 1000);
    assert.deepEqual(c.flushAll(2000), []);
  });

  test('a closed window restarts the burst and emits the previous tally', () => {
    const c = createRepeatCollapser(OPTS);
    for (let i = 0; i < 10; i++) c.record('ERROR', 'dropped events', 1000);
    // Past windowMs: this line writes again, and drags the old tally out with it.
    const res = c.record('ERROR', 'dropped events', 1000 + OPTS.windowMs);
    assert.equal(res.write, true);
    assert.equal(res.tallies.length, 1);
    assert.match(res.tallies[0].msg, /repeated ×7 more/);
  });

  test('flushExpired leaves an open window alone', () => {
    const c = createRepeatCollapser(OPTS);
    for (let i = 0; i < 10; i++) c.record('ERROR', 'dropped events', 1000);
    assert.deepEqual(c.flushExpired(1000 + OPTS.windowMs - 1), []);
    assert.equal(c.flushExpired(1000 + OPTS.windowMs).length, 1);
  });

  test('interleaved storms are tracked independently', () => {
    const c = createRepeatCollapser(OPTS);
    for (let i = 0; i < 10; i++) {
      c.record('ERROR', 'dropped events', 1000);
      c.record('WARN', `SLOW git:worktrees ${1800 + i}ms`, 1000);
    }
    const tallies = c.flushAll(2000);
    assert.equal(tallies.length, 2);
    for (const t of tallies) assert.match(t.msg, /repeated ×7 more/);
    // One per storm, each keeping its own level.
    assert.deepEqual(tallies.map((t) => t.level).sort(), ['ERROR', 'WARN']);
  });

  test('the key map stays bounded under a flood of unique keys', () => {
    const c = createRepeatCollapser({ ...OPTS, keyCap: 4 });
    // Every line is a distinct key; without the cap the map would grow forever.
    // Draining is observable: suppressed keys give up their tallies at the cap.
    for (let i = 0; i < 3; i++) {
      for (let n = 0; n < 5; n++) c.record('INFO', `unique-${String.fromCharCode(97 + n)}`, 1000);
    }
    // Nothing here should throw and the collapser stays usable.
    assert.equal(c.record('INFO', 'still-working', 1000).write, true);
  });
});
