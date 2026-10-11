import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { inferContract } from './contract-infer';
import type { TranscriptSignals } from './transcript-signals';

function sig(over: Partial<TranscriptSignals> = {}): TranscriptSignals {
  return { lastAssistantText: null, lastAssistantAt: 0, declaredDone: false, hasCron: false, hasLoopCommand: false, openTasks: 0, ...over };
}

test('a chat that armed a cron means to go on forever', () => {
  assert.equal(inferContract(sig({ hasCron: true })), 'forever');
});

test('a chat started with /loop means to go on forever', () => {
  assert.equal(inferContract(sig({ hasLoopCommand: true })), 'forever');
});

test('forever outranks open tasks', () => {
  assert.equal(inferContract(sig({ hasCron: true, openTasks: 4 })), 'forever');
});

test('open tasks mean until done', () => {
  assert.equal(inferContract(sig({ openTasks: 1 })), 'until-done');
});

test('nothing visible ⇒ nothing inferred', () => {
  assert.equal(inferContract(sig()), null);
  assert.equal(inferContract(sig({ lastAssistantText: 'All tasks are done.', declaredDone: true })), null);
});
