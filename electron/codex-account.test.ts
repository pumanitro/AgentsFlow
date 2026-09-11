import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CodexAccountReader, codexUsage } from './codex-account';

test('Codex usage keeps separate limits, uses seconds for resets, and ignores malformed windows', () => {
  const r = codexUsage({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 24.6, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: 97, windowDurationMins: 10080 } },
    extra: { limitName: 'Other model', primary: { usedPercent: 12, windowDurationMins: 60 }, secondary: { usedPercent: 'bad' } },
  } }, 'pro');
  assert.ok(r.ok);
  assert.equal(r.snapshot.meters.length, 3);
  assert.deepEqual(r.snapshot.meters.map(m => m.percent), [25,97,12]);
  assert.equal(r.snapshot.meters[0].resetsAt, new Date(2000000000 * 1000).toISOString());
  assert.equal(r.snapshot.meters[1].group, 'weekly');
  assert.equal(r.snapshot.meters[1].severity, 'danger');
  assert.equal(r.snapshot.plan, 'pro');
});

test('Codex usage supports the older single bucket and missing data without inventing usage', () => {
  const r = codexUsage({ rateLimits: { primary: { usedPercent: 120, resetsAt: 1e100 }, secondary: null } });
  assert.ok(r.ok);
  assert.equal(r.snapshot.meters[0].percent, 100);
  assert.equal(r.snapshot.meters[0].resetsAt, null);
  const empty = codexUsage({}); assert.ok(empty.ok); assert.equal(empty.snapshot.meters.length, 0);
});

test('Codex account reads deduplicate panels, do not refresh credentials, and recheck after invalidation', async () => {
  const calls: string[] = [];
  let account: any = { type: 'chatgpt', email: 'same@company.com', planType: 'pro' };
  const reader = new CodexAccountReader({ start: async () => {}, request: async (method, params) => {
    calls.push(method);
    if (method === 'account/read') { assert.equal(params?.refreshToken, false); return { account }; }
    return { rateLimits: { primary: { usedPercent: 3 } } };
  } });
  const [a,b] = await Promise.all([reader.read(),reader.read()]);
  assert.equal(a,b); assert.equal(a.signedIn,true); assert.equal(a.email,'same@company.com');
  await reader.read(); assert.deepEqual(calls,['account/read','account/rateLimits/read']);
  account = null; reader.invalidate();
  const signedOut = await reader.read(); assert.equal(signedOut.signedIn,false); assert.equal(signedOut.email,undefined);
});

test('unavailable Codex usage does not erase a valid account, and API keys never request subscription usage', async () => {
  let type = 'chatgpt'; let rateCalls = 0;
  const reader = new CodexAccountReader({ start: async () => {}, request: async method => {
    if (method === 'account/read') return { account: { type } };
    rateCalls++; throw new Error('offline');
  } });
  assert.equal((await reader.read()).signedIn,true);
  type='apiKey'; const r=await reader.read(true);
  assert.equal(r.signedIn,true); assert.equal(r.usage.ok,false); assert.equal(rateCalls,1);
});
