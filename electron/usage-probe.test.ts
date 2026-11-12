import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  __setProbeClockForTests, __setProbeHttpForTests, getUsageFromTokenProbe, needsProbe,
  snapshotFromRateLimitHeaders, type HeaderBag,
} from './usage-probe';
import type { UsageResult } from '../shared/types';

const AT = '2026-11-11T10:00:00.000Z';
const VERIFIED: HeaderBag = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.34',
  'anthropic-ratelimit-unified-7d-reset': '1794535200',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
  'anthropic-ratelimit-unified-reset': '1794535200',
};

test('verified header set → one weekly_all meter', () => {
  const s = snapshotFromRateLimitHeaders(VERIFIED, AT, 'max')!;
  assert.equal(s.source, 'token-probe');
  assert.equal(s.meters.length, 1);
  const m = s.meters[0];
  assert.equal(m.key, 'weekly_all');
  assert.equal(m.percent, 34);
  assert.equal(m.resetsAt, new Date(1794535200 * 1000).toISOString());
  assert.equal(m.isActive, true);
  assert.equal(m.severity, 'normal');
  assert.equal(s.plan, 'max');
});

test('5h headers → session first, warning', () => {
  const s = snapshotFromRateLimitHeaders({
    ...VERIFIED,
    'anthropic-ratelimit-unified-5h-utilization': '0.915',
    'anthropic-ratelimit-unified-5h-reset': '1794500000',
    'anthropic-ratelimit-unified-5h-status': 'allowed_warning',
  }, AT)!;
  assert.deepEqual(s.meters.map((m) => m.key), ['session', 'weekly_all']);
  assert.equal(s.meters[0].percent, 92);
  assert.equal(s.meters[0].severity, 'warning');
  assert.equal(s.meters[0].group, 'session');
  assert.equal(s.meters[0].isActive, false);
});

test('mixed-case names and array values', () => {
  const s = snapshotFromRateLimitHeaders({
    'Anthropic-RateLimit-Unified-7D-Utilization': ['0.5', '0.9'],
    'ANTHROPIC-RATELIMIT-UNIFIED-REPRESENTATIVE-CLAIM': ['seven_day'],
  }, AT)!;
  assert.equal(s.meters[0].percent, 50);
  assert.equal(s.meters[0].isActive, true);
  assert.equal(s.meters[0].resetsAt, null);
});

test('no headers → null; rejected five_hour without util → session 100 danger', () => {
  assert.equal(snapshotFromRateLimitHeaders({}, AT), null);
  const s = snapshotFromRateLimitHeaders({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': '1794500000',
  }, AT)!;
  assert.equal(s.meters.length, 1);
  assert.equal(s.meters[0].key, 'session');
  assert.equal(s.meters[0].percent, 100);
  assert.equal(s.meters[0].severity, 'danger');
  assert.equal(s.meters[0].resetsAt, new Date(1794500000 * 1000).toISOString());
});

test('needsProbe', () => {
  const now = Date.parse(AT);
  const ok = (ageMs: number): UsageResult => ({ ok: true, snapshot: { meters: [], fetchedAt: new Date(now - ageMs).toISOString() } });
  const fail = (reason: 'no-auth' | 'expired' | 'network' | 'unknown'): UsageResult => ({ ok: false, reason, error: 'x' });
  assert.equal(needsProbe(ok(60_000), now), false);
  assert.equal(needsProbe(fail('network'), now), false);
  assert.equal(needsProbe(fail('expired'), now), true);
  assert.equal(needsProbe(fail('unknown'), now), true);
  assert.equal(needsProbe(fail('no-auth'), now), true);
  assert.equal(needsProbe(ok(20 * 60_000), now), true);
});

test('throttle, force, concurrency, failure mapping', async () => {
  let t = Date.parse(AT);
  let calls = 0;
  __setProbeClockForTests(() => t);
  __setProbeHttpForTests(async () => { calls++; return { status: 200, headers: VERIFIED }; });
  try {
    assert.equal((await getUsageFromTokenProbe('a', 'tok')).ok, true);
    t += 5 * 60_000;
    await getUsageFromTokenProbe('a', 'tok');
    assert.equal(calls, 1);
    t += 30_000; // 30 s since… cached at t0; reset baseline with a forced probe
    __setProbeHttpForTests(async () => { calls++; return { status: 200, headers: VERIFIED }; });
    calls = 0;
    await getUsageFromTokenProbe('a', 'tok', true);
    t += 30_000;
    await getUsageFromTokenProbe('a', 'tok', true);
    assert.equal(calls, 1, 'force within 60 s is cached');
    t += 31_000;
    await getUsageFromTokenProbe('a', 'tok', true);
    assert.equal(calls, 2, 'force after 61 s probes');
    t += 10 * 60_000;
    await getUsageFromTokenProbe('a', 'tok');
    assert.equal(calls, 3, 'non-forced after 10 min probes');

    calls = 0;
    const [r1, r2] = await Promise.all([getUsageFromTokenProbe('b', 'tok'), getUsageFromTokenProbe('b', 'tok')]);
    assert.equal(calls, 1);
    assert.deepEqual(r1, r2);

    __setProbeHttpForTests(async () => { calls++; return { status: 401, headers: {} }; });
    calls = 0;
    const r = await getUsageFromTokenProbe('c', 'tok');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'expired');
    await getUsageFromTokenProbe('c', 'tok');
    assert.equal(calls, 1, 'failure cached');

    __setProbeHttpForTests(async () => { throw new Error('boom'); });
    const n = await getUsageFromTokenProbe('d', 'tok');
    assert.equal(!n.ok && n.reason, 'network');
  } finally {
    __setProbeHttpForTests(null);
    __setProbeClockForTests(null);
  }
});
