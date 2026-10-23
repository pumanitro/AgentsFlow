import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MIN_PAIR_SCORE, pairAll, pairDictation } from './pairing';
import type { Dictation, UserMessage } from './types';

const T0 = Date.parse('2026-10-22T08:00:00.000Z');

function dictation(text: string, at = T0, id = 'd1'): Dictation {
  return { id, timestamp: '2026-10-22 08:00:00.000 +00:00', at, app: 'com.github.Electron', formattedText: text, asrText: null };
}
function msg(text: string, at: number): UserMessage {
  return { at, text, source: 'claude', sessionId: 's1' };
}

const HEARD = 'Set up a crown job on the 50/90 so the here daemon restarts';
const SENT = 'Set up a cron job on the 5090 so the peer daemon restarts';

test('pairs a dictation with the edited message it became', () => {
  const p = pairDictation(dictation(HEARD), [msg('unrelated words in another chat entirely', T0 + 1000), msg(SENT, T0 + 60_000)]);
  assert.ok(p);
  assert.equal(p.message.text, SENT);
  assert.ok(p.score >= MIN_PAIR_SCORE, `score ${p.score}`);
  assert.equal(p.score, 10 / 13);
  assert.equal(p.heard[7], '50/90');
  const replaces = p.ops.filter((o) => o.kind === 'replace').map((o) => [p.heard.slice(o.a0, o.a1).join(' '), p.sent.slice(o.b0, o.b1).join(' ')]);
  assert.deepEqual(replaces, [['crown', 'cron'], ['50/90', '5090'], ['here', 'peer']]);
});

test('a message 25 min after the dictation does not pair', () => {
  assert.equal(pairDictation(dictation(HEARD), [msg(SENT, T0 + 25 * 60_000)]), null);
});

test('a message more than 5 s before the dictation does not pair', () => {
  assert.equal(pairDictation(dictation(HEARD), [msg(SENT, T0 - 6_000)]), null);
  assert.ok(pairDictation(dictation(HEARD), [msg(SENT, T0 - 4_000)]));
});

test('a 2-token dictation never pairs', () => {
  assert.equal(pairDictation(dictation('go on'), [msg('go on', T0 + 1000)]), null);
});

test('messages under 3 tokens are not candidates', () => {
  assert.equal(pairDictation(dictation('yes do it'), [msg('yes', T0 + 1000)]), null);
});

test('a weak match stays unpaired', () => {
  assert.equal(pairDictation(dictation('please restart the daemon now'), [msg('please write the report today', T0 + 1000)]), null);
});

test('ties go to the earliest message', () => {
  const p = pairDictation(dictation('restart the daemon now'), [msg('restart the daemon now', T0 + 9_000), msg('restart the daemon now', T0 + 2_000)]);
  assert.ok(p);
  assert.equal(p.message.at, T0 + 2_000);
  assert.equal(p.score, 1);
});

test('pairAll splits paired and unpaired', () => {
  const r = pairAll([dictation(HEARD, T0, 'a'), dictation('go on', T0, 'b')], [msg(SENT, T0 + 1000)]);
  assert.deepEqual(r.paired.map((p) => p.dictation.id), ['a']);
  assert.deepEqual(r.unpaired.map((d) => d.id), ['b']);
});
