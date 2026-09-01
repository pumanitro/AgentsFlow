import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  countRunning, freeSlots, maxConcurrentRuns, nextQueued,
  DEFAULT_MAX_CONCURRENT_RUNS, STARTING_GRACE_MS, type LiveRunRow,
} from './launch-queue';
import type { Conversation } from '../shared/types';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');

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
  createdAt: new Date(NOW - 1000).toISOString(),
  lastPrompt: '',
  ...over,
});

const busyRow = (sessionId: string): LiveRunRow => ({ sessionId, status: 'busy' });

test('maxConcurrentRuns: default, env override, and nonsense env values', () => {
  assert.equal(maxConcurrentRuns({}), DEFAULT_MAX_CONCURRENT_RUNS);
  assert.equal(maxConcurrentRuns({ AGENTSFLOW_MAX_CONCURRENT_RUNS: '2' }), 2);
  assert.equal(maxConcurrentRuns({ AGENTSFLOW_MAX_CONCURRENT_RUNS: '6.9' }), 6);
  assert.equal(maxConcurrentRuns({ AGENTSFLOW_MAX_CONCURRENT_RUNS: '0' }), DEFAULT_MAX_CONCURRENT_RUNS);
  assert.equal(maxConcurrentRuns({ AGENTSFLOW_MAX_CONCURRENT_RUNS: 'lots' }), DEFAULT_MAX_CONCURRENT_RUNS);
});

test('countRunning: live busy rows are the ground truth; idle/waiting do not count', () => {
  const rows: LiveRunRow[] = [
    busyRow('aaaa1111-0000-0000-0000-000000000000'),
    busyRow('bbbb2222-0000-0000-0000-000000000000'),
    { sessionId: 'cccc3333-0000-0000-0000-000000000000', status: 'idle' },
    { sessionId: 'dddd4444-0000-0000-0000-000000000000', status: 'waiting' },
  ];
  assert.equal(countRunning([], rows, NOW), 2);
});

test('countRunning: stored state is NOT trusted — the zombie-rows regression', () => {
  // The exact wedge observed 2026-09-01: rows recorded 'working' (one since
  // July, one with no daemon at all) on a machine that was 34% busy. With no
  // live busy row behind them they must count for nothing.
  const zombies = [
    conv({ state: 'working', status: 'busy', daemonShort: 'deadbeef', createdAt: '2026-07-18T14:25:44.278Z' }),
    conv({ state: 'working', status: '', createdAt: '2026-08-31T11:12:56.766Z' }),
    conv({ state: 'working', status: 'idle', daemonShort: 'feedface' }),
  ];
  assert.equal(countRunning(zombies, [], NOW), 0);
  assert.equal(freeSlots(zombies, [], {}, NOW), DEFAULT_MAX_CONCURRENT_RUNS);
});

test('countRunning: a just-dispatched run holds a slot through its boot grace, once', () => {
  const booting = conv({ state: 'starting', createdAt: new Date(NOW - 10_000).toISOString() });
  // Not yet visible to `claude agents` → counts via the grace.
  assert.equal(countRunning([booting], [], NOW), 1);
  // Became visible as a busy row → counted once, not twice.
  const visible = conv({ state: 'starting', daemonShort: 'aaaa1111', createdAt: new Date(NOW - 10_000).toISOString() });
  assert.equal(countRunning([visible], [busyRow('aaaa1111-0000-0000-0000-000000000000')], NOW), 1);
  // A 'starting' row older than the grace is a zombie, not a booting run.
  const stale = conv({ state: 'starting', createdAt: new Date(NOW - STARTING_GRACE_MS - 1000).toISOString() });
  assert.equal(countRunning([stale], [], NOW), 0);
});

test('freeSlots: cap minus live busy minus booting, never negative', () => {
  const rows = [busyRow('a-1'), busyRow('b-2'), busyRow('c-3')];
  const booting = conv({ state: 'starting', createdAt: new Date(NOW - 5000).toISOString() });
  assert.equal(freeSlots([booting], rows, {}, NOW), DEFAULT_MAX_CONCURRENT_RUNS - 4);
  assert.equal(freeSlots([], [...rows, ...rows.map((r) => busyRow(r.sessionId + 'x'))], {}, NOW), 0);
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
