import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { __resetForTests, bindingPercent, decide, getStatus, runOnce, type RotationDeps } from './rotation';
import type { Account, RotationPolicy, UsageMeter, UsageResult } from '../shared/types';

function meter(over: Partial<UsageMeter> = {}): UsageMeter {
  return {
    key: 'session',
    label: 'Current session',
    group: 'session',
    percent: 10,
    severity: 'normal',
    resetsAt: null,
    isActive: false,
    ...over,
  };
}

function usage(meters: UsageMeter[]): UsageResult {
  return { ok: true, snapshot: { meters, fetchedAt: new Date().toISOString() } };
}

// ---------------------------------------------------------------------------
// Which number decides an account's fate
// ---------------------------------------------------------------------------

test('bindingPercent: prefers the limit the API flags as binding', () => {
  const r = usage([
    meter({ key: 'session', percent: 40, isActive: false }),
    meter({ key: 'weekly_all', group: 'weekly', percent: 91, isActive: true }),
  ]);
  assert.equal(bindingPercent(r), 91);
});

test('bindingPercent: falls back to the worst meter when none is flagged', () => {
  const r = usage([
    meter({ key: 'session', percent: 96 }),
    meter({ key: 'weekly_all', group: 'weekly', percent: 30 }),
  ]);
  assert.equal(bindingPercent(r), 96);
});

test('bindingPercent: unreadable usage is null, never 0', () => {
  assert.equal(bindingPercent(null), null);
  assert.equal(bindingPercent(undefined), null);
  assert.equal(bindingPercent({ ok: false, reason: 'network', error: 'offline' }), null);
  assert.equal(bindingPercent(usage([])), null);
});

// ---------------------------------------------------------------------------
// The policy itself
// ---------------------------------------------------------------------------

test('decide: stays put below the threshold', () => {
  const d = decide({ activePercent: 94, candidates: [{ accountId: 'b', percent: 3 }], threshold: 95 });
  assert.equal(d.action, 'none');
});

test('decide: switches at the threshold exactly', () => {
  const d = decide({ activePercent: 95, candidates: [{ accountId: 'b', percent: 3 }], threshold: 95 });
  assert.equal(d.action, 'switch');
  assert.equal((d as { targetId: string }).targetId, 'b');
});

test('decide: picks the account with the most headroom', () => {
  const d = decide({
    activePercent: 97,
    candidates: [
      { accountId: 'b', percent: 60 },
      { accountId: 'c', percent: 8 },
      { accountId: 'd', percent: 42 },
    ],
    threshold: 95,
  });
  assert.equal((d as { targetId: string }).targetId, 'c');
});

test('decide: never switches onto an account that is also over the threshold', () => {
  const d = decide({
    activePercent: 99,
    candidates: [{ accountId: 'b', percent: 96 }, { accountId: 'c', percent: 100 }],
    threshold: 95,
  });
  assert.equal(d.action, 'exhausted');
});

test('decide: an account with unreadable usage is never chosen', () => {
  // Switching blind onto a possibly-exhausted account at 3am is worse than
  // reporting that there is nowhere to go.
  const d = decide({
    activePercent: 99,
    candidates: [{ accountId: 'b', percent: null }],
    threshold: 95,
  });
  assert.equal(d.action, 'exhausted');
});

test('decide: mixed known/unknown candidates still uses the known one', () => {
  const d = decide({
    activePercent: 99,
    candidates: [{ accountId: 'b', percent: null }, { accountId: 'c', percent: 20 }],
    threshold: 95,
  });
  assert.equal((d as { targetId: string }).targetId, 'c');
});

test('decide: unreadable active usage does nothing rather than guessing', () => {
  const d = decide({ activePercent: null, candidates: [{ accountId: 'b', percent: 1 }], threshold: 95 });
  assert.equal(d.action, 'none');
  assert.match(d.reason, /unreadable/);
});

test('decide: no candidates at all is exhausted, not a crash', () => {
  const d = decide({ activePercent: 99, candidates: [], threshold: 95 });
  assert.equal(d.action, 'exhausted');
});

test('decide: a custom threshold is honoured', () => {
  const at80 = decide({ activePercent: 85, candidates: [{ accountId: 'b', percent: 10 }], threshold: 80 });
  assert.equal(at80.action, 'switch');
  const at90 = decide({ activePercent: 85, candidates: [{ accountId: 'b', percent: 10 }], threshold: 90 });
  assert.equal(at90.action, 'none');
});

// ---------------------------------------------------------------------------
// The loop — the guards that decide whether an unattended overnight run is safe
// ---------------------------------------------------------------------------

function account(id: string): Account {
  return { id, email: `${id}@gmail.com`, configDir: `/tmp/vault/${id}`, addedAt: '2026-01-01T00:00:00.000Z' };
}

/** Deps wired to fixed percentages, recording every switch attempt. */
function harness(opts: {
  policy?: Partial<RotationPolicy>;
  percentById: Record<string, number>;
  activeId?: string | null;
  switchImpl?: (id: string) => Promise<Account>;
}) {
  const switched: string[] = [];
  const accounts = Object.keys(opts.percentById).map(account);
  const deps: RotationDeps = {
    getPolicy: () => ({ enabled: true, threshold: 95, ...opts.policy }),
    getAccounts: () => accounts,
    getActiveId: () => (opts.activeId === undefined ? 'a' : opts.activeId),
    getAccountUsage: async (acct) => usage([meter({ percent: opts.percentById[acct.id], isActive: true })]),
    getActiveUsage: async () => usage([meter({ percent: 0, isActive: true })]),
    switchTo: async (id) => {
      switched.push(id);
      if (opts.switchImpl) return opts.switchImpl(id);
      return account(id);
    },
    onStatus: () => {},
  };
  return { deps, switched };
}

test('runOnce: switches to the account with headroom when the active one is full', async () => {
  __resetForTests();
  const { deps, switched } = harness({ percentById: { a: 97, b: 55, c: 9 } });
  await runOnce(deps);
  assert.deepEqual(switched, ['c']);
  assert.match(getStatus().lastEvent ?? '', /Switched to c@gmail\.com/);
});

test('runOnce: does nothing while the active account has headroom', async () => {
  __resetForTests();
  const { deps, switched } = harness({ percentById: { a: 40, b: 9 } });
  await runOnce(deps);
  assert.deepEqual(switched, []);
});

test('runOnce: the cooldown prevents a second switch straight after the first', async () => {
  __resetForTests();
  const { deps, switched } = harness({ percentById: { a: 97, b: 9 } });
  await runOnce(deps);
  await runOnce(deps);
  await runOnce(deps);
  assert.deepEqual(switched, ['b'], 'only the first pass may switch');
});

test('runOnce: disabled policy is inert', async () => {
  __resetForTests();
  const { deps, switched } = harness({ policy: { enabled: false }, percentById: { a: 99, b: 1 } });
  await runOnce(deps);
  assert.deepEqual(switched, []);
});

test('runOnce: a single account never rotates', async () => {
  __resetForTests();
  const { deps, switched } = harness({ percentById: { a: 99 } });
  await runOnce(deps);
  assert.deepEqual(switched, []);
});

test('runOnce: repeated failures stop rotation instead of retrying all night', async () => {
  __resetForTests();
  const { deps, switched } = harness({
    percentById: { a: 99, b: 5 },
    switchImpl: async () => { throw new Error('keychain write could not be verified'); },
  });
  // Each failure leaves the cooldown untouched, so the next pass retries…
  await runOnce(deps);
  assert.equal(getStatus().disabledReason, null, 'one failure is not fatal');
  await runOnce(deps);
  await runOnce(deps);
  assert.equal(switched.length, 3, 'retried up to the limit');
  assert.match(getStatus().disabledReason ?? '', /rotation stopped/i);

  // …and once stopped, it stays stopped.
  await runOnce(deps);
  assert.equal(switched.length, 3, 'no further attempts after the stop');
});

test('runOnce: reports exhaustion once, not on every tick', async () => {
  __resetForTests();
  const events: (string | null)[] = [];
  const { deps, switched } = harness({ percentById: { a: 99, b: 98 } });
  deps.onStatus = (s) => events.push(s.lastEvent);
  await runOnce(deps);
  await runOnce(deps);
  await runOnce(deps);
  assert.deepEqual(switched, []);
  assert.equal(events.length, 1, 'the "nowhere to go" message is not repeated every minute');
  assert.match(events[0] ?? '', /no other account is below 95%/);
});
