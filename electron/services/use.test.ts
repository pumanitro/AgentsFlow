import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fmtMinutes, pressureQueue, processActive, serviceVerdict, type UseFacts } from './use';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 26, 12, 0);

// An awake, managed process watched for 5 h and never used: the plain idle case.
function facts(over: Partial<UseFacts> = {}): UseFacts {
  return {
    kind: 'process', managed: true, pinned: false, awake: true, inflight: null,
    activeNow: false, activeDetail: '', lastUsedAt: null, observedSince: NOW - 300 * MIN, idleMinutes: 240, now: NOW,
    memPressure: false, pressureIdleMinutes: 30,
    ...over,
  };
}

test('fmtMinutes: minutes, whole hours, hours and minutes', () => {
  assert.equal(fmtMinutes(0), '0 min');
  assert.equal(fmtMinutes(7.9), '7 min');
  assert.equal(fmtMinutes(60), '1 h');
  assert.equal(fmtMinutes(250), '4 h 10 min');
  assert.equal(fmtMinutes(-3), '0 min');
});

test('serviceVerdict: an operation in flight wins over everything', () => {
  assert.deepEqual(serviceVerdict(facts({ inflight: 'waking', managed: false, awake: false, pinned: true })), { verdict: 'waking', note: 'waking up…', idleForMinutes: null, early: false });
  assert.deepEqual(serviceVerdict(facts({ inflight: 'sleeping', activeNow: true })), { verdict: 'sleeping', note: 'going to sleep…', idleForMinutes: null, early: false });
});

test('serviceVerdict: unmanaged → listed only, even when asleep or pinned', () => {
  const v = serviceVerdict(facts({ managed: false, awake: false, pinned: true }));
  assert.equal(v.verdict, 'unmanaged');
  assert.equal(v.note, 'listed only — Peers Flow never stops or starts it');
});

test('serviceVerdict: asleep — a service and Docker Desktop each get their sentence', () => {
  assert.deepEqual(serviceVerdict(facts({ awake: false, pinned: true })), { verdict: 'asleep', note: 'asleep — wakes on the first request or when you click Wake', idleForMinutes: null, early: false });
  assert.equal(serviceVerdict(facts({ kind: 'docker-desktop', awake: false })).note, 'Docker Desktop is off — it starts by itself when a Docker project wakes up');
});

test('serviceVerdict: pinned beats in use and idle, and still reports its idle clock', () => {
  assert.deepEqual(serviceVerdict(facts({ pinned: true, activeNow: true })), { verdict: 'pinned', note: 'pinned — never put to sleep', idleForMinutes: 300, early: false });
  assert.equal(serviceVerdict(facts({ pinned: true, memPressure: true })).verdict, 'pinned');
});

test('serviceVerdict: in use right now, with and without a detail', () => {
  assert.deepEqual(serviceVerdict(facts({ activeNow: true, activeDetail: '2 open connections on :5545' })), { verdict: 'in-use', note: 'in use right now — 2 open connections on :5545', idleForMinutes: 0, early: false });
  assert.equal(serviceVerdict(facts({ activeNow: true })).note, 'in use right now');
  // Even under memory pressure: active is active.
  assert.equal(serviceVerdict(facts({ activeNow: true, memPressure: true })).verdict, 'in-use');
});

test('serviceVerdict: Docker Desktop stays on while a Docker project is awake', () => {
  assert.deepEqual(serviceVerdict(facts({ kind: 'docker-desktop', idleMinutes: 15, dockerServicesAwake: 1 })), { verdict: 'in-use', note: '1 Docker project is awake', idleForMinutes: 300, early: false });
  assert.equal(serviceVerdict(facts({ kind: 'docker-desktop', idleMinutes: 15, dockerServicesAwake: 3 })).note, '3 Docker projects are awake');
});

test('serviceVerdict: Docker Desktop is blocked by a running container that is not managed here', () => {
  const v = serviceVerdict(facts({ kind: 'docker-desktop', idleMinutes: 15, dockerServicesAwake: 0, runningContainersOutside: ['pe-db', 'redis'] }));
  assert.deepEqual(v, { verdict: 'blocked', note: 'stays on: pe-db is running and is not managed here', idleForMinutes: 300, early: false });
  // Awake projects are reported first.
  assert.equal(serviceVerdict(facts({ kind: 'docker-desktop', dockerServicesAwake: 1, runningContainersOutside: ['pe-db'] })).verdict, 'in-use');
  // Nothing awake, nothing outside → idle by its own (15 min) clock.
  assert.equal(serviceVerdict(facts({ kind: 'docker-desktop', idleMinutes: 15, dockerServicesAwake: 0, runningContainersOutside: [] })).verdict, 'idle');
});

test('serviceVerdict: used within the idle limit → in use, "used N ago"', () => {
  assert.deepEqual(serviceVerdict(facts({ lastUsedAt: NOW - 12 * MIN })), { verdict: 'in-use', note: 'used 12 min ago', idleForMinutes: 12, early: false });
  assert.equal(serviceVerdict(facts({ lastUsedAt: NOW - 239 * MIN })).note, 'used 3 h 59 min ago');
  // Exactly at the limit it is idle.
  assert.equal(serviceVerdict(facts({ lastUsedAt: NOW - 240 * MIN })).verdict, 'idle');
});

test('serviceVerdict: too new — nothing is judged in the first 30 min of watching', () => {
  const v = serviceVerdict(facts({ observedSince: NOW - 10 * MIN }));
  assert.deepEqual(v, { verdict: 'too-new', note: 'watched for only 10 min — judged after 30 min', idleForMinutes: 10, early: false });
  // An old persisted use does not skip the window…
  assert.equal(serviceVerdict(facts({ observedSince: NOW - 29 * MIN, lastUsedAt: NOW - 600 * MIN })).verdict, 'too-new');
  // …and at 30 min the window is over.
  assert.equal(serviceVerdict(facts({ observedSince: NOW - 30 * MIN, idleMinutes: 20 })).verdict, 'idle');
});

test('serviceVerdict: idle — the clock runs from the last use, else from when watching began', () => {
  assert.deepEqual(serviceVerdict(facts()), { verdict: 'idle', note: 'not used for 5 h — going to sleep', idleForMinutes: 300, early: false });
  assert.deepEqual(serviceVerdict(facts({ lastUsedAt: NOW - 250 * MIN, observedSince: NOW - 40 * MIN })), { verdict: 'idle', note: 'not used for 4 h 10 min — going to sleep', idleForMinutes: 250, early: false });
});

test('serviceVerdict: memory pressure sleeps early at 30 min unused, not at 29', () => {
  const at30 = serviceVerdict(facts({ memPressure: true, lastUsedAt: NOW - 30 * MIN }));
  assert.deepEqual(at30, { verdict: 'idle', note: 'memory is tight — not used for 30 min, going to sleep early (normally after 4 h)', idleForMinutes: 30, early: true });
  assert.deepEqual(serviceVerdict(facts({ memPressure: true, lastUsedAt: NOW - 29 * MIN })), { verdict: 'in-use', note: 'used 29 min ago', idleForMinutes: 29, early: false });
  // The floor is the registry's.
  assert.equal(serviceVerdict(facts({ memPressure: true, pressureIdleMinutes: 60, lastUsedAt: NOW - 45 * MIN })).early, false);
});

test('serviceVerdict: no early sleep without pressure', () => {
  const v = serviceVerdict(facts({ memPressure: false, lastUsedAt: NOW - 90 * MIN }));
  assert.equal(v.verdict, 'in-use');
  assert.equal(v.early, false);
});

test('serviceVerdict: Docker Desktop never sleeps early', () => {
  const v = serviceVerdict(facts({ kind: 'docker-desktop', idleMinutes: 15, memPressure: true, lastUsedAt: NOW - 10 * MIN, dockerServicesAwake: 0, runningContainersOutside: [] }));
  assert.equal(v.early, false);
  assert.equal(v.note, 'used 10 min ago');
});

test('serviceVerdict: no early sleep inside the 30-min observation window', () => {
  const v = serviceVerdict(facts({ memPressure: true, observedSince: NOW - 25 * MIN, lastUsedAt: NOW - 300 * MIN }));
  assert.equal(v.verdict, 'too-new');
  assert.equal(v.early, false);
});

test('processActive: an open connection or more than 5 % CPU; no reading is no use', () => {
  assert.equal(processActive(null, 0), false);
  assert.equal(processActive(0, 0), false);
  assert.equal(processActive(5, 0), false);
  assert.equal(processActive(5.1, 0), true);
  assert.equal(processActive(null, 1), true);
});

test('pressureQueue: least recently used first, ties by id, skip and non-early left out', () => {
  const q = pressureQueue([
    { id: 'compose:b', early: true, lastUsedAt: 300, observedSince: 0, skip: false },
    { id: 'compose:a', early: true, lastUsedAt: 300, observedSince: 0, skip: false },
    { id: 'atlas', early: true, lastUsedAt: null, observedSince: 100, skip: false },
    { id: 'skipped', early: true, lastUsedAt: 1, observedSince: 0, skip: true },
    { id: 'fresh', early: false, lastUsedAt: 2, observedSince: 0, skip: false },
    { id: 'containers:x', early: true, lastUsedAt: 200, observedSince: 0, skip: false },
  ]);
  assert.deepEqual(q, ['atlas', 'containers:x', 'compose:a', 'compose:b']);
  assert.deepEqual(pressureQueue([]), []);
});
