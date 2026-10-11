import test from 'node:test';
import assert from 'node:assert/strict';
import { appendBuffer, replayText, type ReplayBuffer } from './replay-buffer';

const fresh = (): ReplayBuffer => ({ buffer: [], bufferBytes: 0, trimmed: false });

test.describe('replay buffer', () => {
  test('under the cap, the replay is the output verbatim', () => {
    const s = fresh();
    appendBuffer(s, 'hello ', 100);
    appendBuffer(s, '\x1b[31mworld\x1b[0m', 100);
    assert.equal(s.trimmed, false);
    assert.equal(replayText(s), 'hello \x1b[31mworld\x1b[0m');
  });

  test('over the cap, the oldest chunks go first and the buffer is marked trimmed', () => {
    const s = fresh();
    appendBuffer(s, 'a'.repeat(60), 100);
    appendBuffer(s, 'b'.repeat(30), 100);
    appendBuffer(s, 'c'.repeat(30), 100);
    assert.deepEqual(s.buffer, ['b'.repeat(30), 'c'.repeat(30)]);
    assert.equal(s.bufferBytes, 60);
    assert.equal(s.trimmed, true);
  });

  test('a single oversized chunk is kept rather than leaving nothing to replay', () => {
    const s = fresh();
    appendBuffer(s, 'x'.repeat(500), 100);
    assert.deepEqual(s.buffer, ['x'.repeat(500)]);
    assert.equal(s.trimmed, false);
  });

  test('a trimmed replay starts at the first escape, not inside the torn sequence', () => {
    // The kernel cut a read inside "\x1b[38;5;49m" and eviction took the head chunk.
    const s = fresh();
    appendBuffer(s, '\x1b[38;', 20);
    appendBuffer(s, '5;49mhi\x1b[0m', 20);
    appendBuffer(s, ' there', 20);
    assert.equal(s.trimmed, true);
    assert.equal(replayText(s), '\x1b[0m there');
  });

  test('the first escape may sit in a later chunk', () => {
    const s: ReplayBuffer = { buffer: ['plain', 'text\x1b[2Jrest'], bufferBytes: 15, trimmed: true };
    assert.equal(replayText(s), '\x1b[2Jrest');
  });

  test('a trimmed buffer with no escape at all is plain text and replays as is', () => {
    const s: ReplayBuffer = { buffer: ['ome text', ' more'], bufferBytes: 13, trimmed: true };
    assert.equal(replayText(s), 'ome text more');
  });

  test('an empty buffer replays as the empty string', () => {
    assert.equal(replayText(fresh()), '');
  });
});
