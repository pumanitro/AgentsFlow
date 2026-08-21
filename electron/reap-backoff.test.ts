import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { nextReapDelayMs, REAP_BACKOFF_BASE_MS, REAP_BACKOFF_MAX_MS } from './reap-backoff';

test('nextReapDelayMs: doubles from a minute and caps at an hour', () => {
  assert.equal(nextReapDelayMs(1), REAP_BACKOFF_BASE_MS);
  assert.equal(nextReapDelayMs(2), 2 * REAP_BACKOFF_BASE_MS);
  assert.equal(nextReapDelayMs(3), 4 * REAP_BACKOFF_BASE_MS);
  assert.equal(nextReapDelayMs(6), 32 * REAP_BACKOFF_BASE_MS);
  assert.equal(nextReapDelayMs(7), REAP_BACKOFF_MAX_MS);
  assert.equal(nextReapDelayMs(40), REAP_BACKOFF_MAX_MS);
});

test('nextReapDelayMs: a night against one stuck daemon is a handful of attempts, not a thousand', () => {
  // 8 hours of retries under the schedule.
  let elapsed = 0;
  let attempts = 0;
  while (elapsed < 8 * 60 * 60 * 1000) {
    attempts += 1;
    elapsed += nextReapDelayMs(attempts);
  }
  assert.ok(attempts <= 14, `expected a handful of attempts, got ${attempts}`);
});

test('nextReapDelayMs: nonsense attempt numbers still yield the base delay', () => {
  assert.equal(nextReapDelayMs(0), REAP_BACKOFF_BASE_MS);
  assert.equal(nextReapDelayMs(-3), REAP_BACKOFF_BASE_MS);
});
