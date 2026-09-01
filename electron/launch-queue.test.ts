import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { countRunning, freeSlots, isRunning, maxConcurrentRuns, nextQueued, DEFAULT_MAX_CONCURRENT_RUNS } from './launch-queue';
import type { Conversation } from '../shared/types';

const conv = (over: Partial<Conversation>): Conversation => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  sessionId: '',
  daemonShort: '',
  sessionName: '',
  directoryId: 'd1',
  directoryPath: '/tmp/d1',
  displayName: 'd1',
  title: 't',
  description: '',
  pinned: true,
  state: 'idle',
  status: '',
  intent: '',
  createdAt: '2026-09-01T10:00:00.000Z',
  lastPrompt: '',
  ...over,
});

test('maxConcurrentRuns: default, env override, and nonsense env values', () => {
  assert.equal(maxConcurrentRuns({}), DEFAULT_MAX_CONCURRENT_RUNS);
  assert.equal(maxConcurrentRuns({ AGENTSFLOW_MAX_CONCURRENT_RUNS: '2' }), 2);
  assert.equal(maxConcurrentRuns({ AGENTSFLOW_MAX_CONCURRENT_RUNS: '6.9' }), 6);
  assert.equal(maxConcurrentRuns({ AGENTSFLOW_MAX_CONCURRENT_RUNS: '0' }), DEFAULT_MAX_CONCURRENT_RUNS);
  assert.equal(maxConcurrentRuns({ AGENTSFLOW_MAX_CONCURRENT_RUNS: 'lots' }), DEFAULT_MAX_CONCURRENT_RUNS);
});

test('isRunning: CPU-consuming states count, parked and finished ones do not', () => {
  assert.equal(isRunning(conv({ state: 'working' })), true);
  assert.equal(isRunning(conv({ state: 'starting' })), true);
  // Live busy status wins over a stale terminal state (a --resume'd session
  // whose state.json froze on the previous turn).
  assert.equal(isRunning(conv({ state: 'done', status: 'busy' })), true);
  // Blocked runs are parked on a human — they must not hold a slot, or a few
  // permission prompts would stall an unattended batch forever.
  assert.equal(isRunning(conv({ state: 'blocked' })), false);
  assert.equal(isRunning(conv({ state: 'needs-input' })), false);
  assert.equal(isRunning(conv({ state: 'done' })), false);
  assert.equal(isRunning(conv({ state: 'failed' })), false);
  assert.equal(isRunning(conv({ state: 'idle' })), false);
  assert.equal(isRunning(conv({ state: 'queued' })), false);
});

test('freeSlots: the cap minus the running set, never negative', () => {
  const running = (n: number) => Array.from({ length: n }, () => conv({ state: 'working' }));
  assert.equal(freeSlots([], {}), DEFAULT_MAX_CONCURRENT_RUNS);
  assert.equal(freeSlots(running(3), {}), DEFAULT_MAX_CONCURRENT_RUNS - 3);
  assert.equal(freeSlots(running(11), {}), 0);
  assert.equal(countRunning([...running(2), conv({ state: 'blocked' }), conv({ state: 'done' })]), 2);
});

test('nextQueued: oldest first, and only rows still holding their payload in state queued', () => {
  const q = (id: string, createdAt: string, over: Partial<Conversation> = {}) =>
    conv({ id, createdAt, state: 'queued', queuedSpawn: { prompt: 'p', peerAware: true }, ...over });
  const newer = q('newer', '2026-09-01T10:05:00.000Z');
  const older = q('older', '2026-09-01T10:01:00.000Z');
  const canceledKeepsPayloadOut = q('canceled', '2026-09-01T09:00:00.000Z', { state: 'done', queuedSpawn: undefined });
  const staleStateNoPayload = conv({ id: 'stale', state: 'queued', createdAt: '2026-09-01T09:30:00.000Z' });
  assert.equal(nextQueued([newer, canceledKeepsPayloadOut, older, staleStateNoPayload])?.id, 'older');
  assert.equal(nextQueued([conv({ state: 'working' })]), undefined);
});
