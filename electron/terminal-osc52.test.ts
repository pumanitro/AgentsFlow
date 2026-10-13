import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOsc52, OSC52_MAX_BASE64 } from '../shared/terminal-osc52';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

test('decodes the clipboard target Claude Code writes', () => {
  assert.equal(decodeOsc52(`c;${b64('hello world')}`), 'hello world');
});

test('keeps UTF-8 intact (Polish, emoji, newlines)', () => {
  const text = 'Zażółć gęślą jaźń 😊\nline two';
  assert.equal(decodeOsc52(`c;${b64(text)}`), text);
});

test('accepts an empty or multi-letter target list', () => {
  assert.equal(decodeOsc52(`;${b64('a')}`), 'a');
  assert.equal(decodeOsc52(`pc;${b64('b')}`), 'b');
});

test('never answers a clipboard read request', () => {
  assert.equal(decodeOsc52('c;?'), null);
});

test('ignores clear requests, garbage and oversized payloads', () => {
  assert.equal(decodeOsc52('c;'), null);
  assert.equal(decodeOsc52('no-separator'), null);
  assert.equal(decodeOsc52('c;not base64!!'), null);
  assert.equal(decodeOsc52('c;' + 'A'.repeat(OSC52_MAX_BASE64 + 4)), null);
});
