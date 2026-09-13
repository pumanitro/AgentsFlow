import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { __resetForTests, __setNowForTests, bindingPercent, decide, getStatus, runOnce, type RotationDeps } from './rotation';
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

test('bindingPercent: the worst meter decides, whatever the API flags', () => {
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

// The regression that let an overnight run hit the wall with switching ON.
// Every account the API was asked about reported the SAME shape: is_active on
// the weekly limit, never on the 5-hour session window. Preferring the flagged
// meter therefore made the threshold structurally blind to the one wall that
// actually stops an agent working.
test('bindingPercent: a full session window is not hidden by a calm weekly one', () => {
  const r = usage([
    meter({ key: 'session', percent: 100, isActive: false }),
    meter({ key: 'weekly_all', group: 'weekly', percent: 43, isActive: true }),
    meter({ key: 'weekly:fable', group: 'weekly', percent: 54, isActive: false }),
  ]);
  assert.equal(bindingPercent(r), 100);
  assert.equal(
    decide({ activePercent: bindingPercent(r), candidates: [{ accountId: 'b', percent: 20 }], threshold: 95 }).action,
    'switch',
  );
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

// The night of 2026-08-20: three standby tokens expired, one account full, and
// the log said only "no other account is below 95%" — indistinguishable from a
// genuinely exhausted pool. Blind and full must read differently.
test('decide: exhaustion counts unreadable accounts instead of hiding them', () => {
  const d = decide({
    activePercent: 100,
    candidates: [
      { accountId: 'b', percent: null },
      { accountId: 'c', percent: null },
      { accountId: 'd', percent: 96 },
    ],
    threshold: 95,
  });
  assert.equal(d.action, 'exhausted');
  assert.match(d.reason, /1 at\/above 95%/);
  assert.match(d.reason, /2 unreadable/);
});

test('decide: an all-readable exhausted pool keeps the plain percentage message', () => {
  const d = decide({ activePercent: 99, candidates: [{ accountId: 'b', percent: 96 }], threshold: 95 });
  assert.equal(d.action, 'exhausted');
  assert.match(d.reason, /no other account is below 95%/);
  assert.doesNotMatch(d.reason, /unreadable/);
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
// Proof outranks the meter (the night of 2026-08-21)
// ---------------------------------------------------------------------------
// 00:50 — a chat reports "You've hit your session limit"; the active account's
// worst meter reads 43%; the urgent pass answers "active at 43% (below 90%)"
// and leaves it parked. Walls exist that no meter row reports. Later that
// night the active login is revoked server-side, its meters go unreadable, and
// "unreadable ⇒ do nothing" holds rotation still for 87 minutes with four
// readable accounts in the pool.

test('decide: a forced pass switches however calm the active meter looks', () => {
  const d = decide({ activePercent: 43, candidates: [{ accountId: 'b', percent: 20 }], threshold: 90, force: 'a chat hit the wall' });
  assert.equal(d.action, 'switch');
  assert.match(d.reason, /a chat hit the wall \(meter at 43%\)/);
});

test('decide: a forced pass with an unreadable active meter still switches', () => {
  const d = decide({ activePercent: null, candidates: [{ accountId: 'b', percent: 20 }], threshold: 90, force: 'active login unreadable for 6 min' });
  assert.equal(d.action, 'switch');
  assert.match(d.reason, /meter unreadable/);
});

test('decide: force never overrides the headroom rule or the unreadable-target rule', () => {
  const full = decide({ activePercent: 43, candidates: [{ accountId: 'b', percent: 95 }], threshold: 90, force: 'a chat hit the wall' });
  assert.equal(full.action, 'exhausted');
  const blind = decide({ activePercent: null, candidates: [{ accountId: 'b', percent: null }], threshold: 90, force: 'active login unreadable for 6 min' });
  assert.equal(blind.action, 'exhausted');
  assert.match(blind.reason, /1 unreadable/);
});

test('decide: without force, the meter still gates as before', () => {
  assert.equal(decide({ activePercent: 43, candidates: [{ accountId: 'b', percent: 20 }], threshold: 90 }).action, 'none');
  assert.equal(decide({ activePercent: null, candidates: [{ accountId: 'b', percent: 20 }], threshold: 90 }).action, 'none');
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
  /** Accounts whose meters cannot be read (a dead or 429'd token). */
  unreadable?: string[];
  /** Per-read error for unreadable accounts; defaults to an auth rejection. */
  unreadableError?: () => UsageResult;
  activeId?: string | null;
  switchImpl?: (id: string) => Promise<Account>;
}) {
  const switched: string[] = [];
  const accounts = Object.keys(opts.percentById).map(account);
  const deps: RotationDeps = {
    getPolicy: () => ({ enabled: true, threshold: 95, resumeOnLimit: true, ...opts.policy }),
    getAccounts: () => accounts,
    getActiveId: () => (opts.activeId === undefined ? 'a' : opts.activeId),
    getAccountUsage: async (acct) => {
      if (opts.unreadable?.includes(acct.id)) {
        return opts.unreadableError?.() ?? { ok: false, reason: 'expired', error: 'Auth rejected (HTTP 401).' };
      }
      return usage([meter({ percent: opts.percentById[acct.id], isActive: true })]);
    },
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

test('runOnce: an urgent pass switches through the cooldown', async () => {
  // A chat reporting HTTP 429 is proof, not a meter hovering on a boundary —
  // making it wait out the cooldown is what leaves it parked for ten minutes
  // with a fresh account sitting right there.
  __resetForTests();
  const { deps, switched } = harness({ percentById: { a: 97, b: 9, c: 12 } });
  await runOnce(deps);
  assert.deepEqual(switched, ['b']);
  const urgent = await runOnce(deps, { urgent: true });
  assert.equal(urgent.switched, true);
  assert.deepEqual(switched, ['b', 'b']);
});

test('runOnce: urgency does not override the headroom rule or the failure stop', async () => {
  __resetForTests();
  const nowhere = harness({ percentById: { a: 99, b: 97 } });
  assert.equal((await runOnce(nowhere.deps, { urgent: true })).switched, false);
  assert.deepEqual(nowhere.switched, []);

  __resetForTests();
  const broken = harness({
    percentById: { a: 99, b: 5 },
    switchImpl: async () => { throw new Error('keychain write could not be verified'); },
  });
  for (let i = 0; i < 4; i++) await runOnce(broken.deps, { urgent: true });
  assert.equal(broken.switched.length, 3, 'the failure stop still applies');
});

test('runOnce: reports what it decided so a caller can act on it', async () => {
  __resetForTests();
  const { deps } = harness({ percentById: { a: 20, b: 9 } });
  const outcome = await runOnce(deps);
  assert.equal(outcome.switched, false);
  assert.match(outcome.reason, /below 95%/);
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

// ---------------------------------------------------------------------------
// The loop under proof: walls the meter missed, and a login that died
// ---------------------------------------------------------------------------

const MIN = 60_000;

test('runOnce: an urgent pass switches even when the meter is below the threshold', async () => {
  // The 00:50 case, as the loop sees it: proof in the transcript, 43% on the meter.
  __resetForTests();
  const { deps, switched } = harness({ percentById: { a: 43, b: 60, c: 12 }, policy: { threshold: 90 } });
  const outcome = await runOnce(deps, { urgent: true });
  assert.equal(outcome.switched, true);
  assert.deepEqual(switched, ['c'], 'the most headroom, whatever the active meter claimed');
  assert.match(getStatus().lastEvent ?? '', /a chat hit the wall \(meter at 43%\)/);
});

test('runOnce: an urgent pass names its cause on the status line', async () => {
  __resetForTests();
  const { deps } = harness({ percentById: { a: 10, b: 5 }, policy: { threshold: 90 } });
  await runOnce(deps, { urgent: true, cause: 'the active login was revoked' });
  assert.match(getStatus().lastEvent ?? '', /the active login was revoked/);
});

test('runOnce: an account a chat proved full is not switched back onto', async () => {
  // a walls → switch to b. b walls → a's meter still says 43%, but a chat just
  // proved that number wrong; picking a again would wall the chat a third time.
  __resetForTests();
  let t = 10_000_000;
  __setNowForTests(() => t);
  const { deps, switched } = harness({ percentById: { a: 43, b: 50 }, policy: { threshold: 90 } });
  await runOnce(deps, { urgent: true });
  assert.deepEqual(switched, ['b']);

  deps.getActiveId = () => 'b';
  t += 1 * MIN;
  const back = await runOnce(deps, { urgent: true });
  assert.equal(back.switched, false);
  assert.match(back.reason, /no other account is below 90%/);

  // Half an hour on, the proof has gone stale and a is a candidate again.
  t += 31 * MIN;
  assert.equal((await runOnce(deps, { urgent: true })).switched, true);
  assert.deepEqual(switched, ['b', 'a']);
});

test('runOnce: an unreadable active login is switched away from after the grace', async () => {
  __resetForTests();
  let t = 10_000_000;
  __setNowForTests(() => t);
  const { deps, switched } = harness({ percentById: { a: 0, b: 30, c: 12 }, unreadable: ['a'] });

  assert.equal((await runOnce(deps)).switched, false, 'first sighting only starts the clock');
  t += 4 * MIN;
  assert.equal((await runOnce(deps)).switched, false, 'still inside the grace');
  assert.deepEqual(switched, []);

  t += 2 * MIN;
  const outcome = await runOnce(deps);
  assert.equal(outcome.switched, true);
  assert.deepEqual(switched, ['c'], 'onto the readable account with the most headroom');
  assert.match(outcome.reason, /unreadable for 6 min/);
});

test('runOnce: the blind clock does not restart when the error text changes', async () => {
  // A 429 that turns into a 401 is one outage, not two fresh ones.
  __resetForTests();
  let t = 10_000_000;
  __setNowForTests(() => t);
  let reads = 0;
  const { deps, switched } = harness({
    percentById: { a: 0, b: 30 },
    unreadable: ['a'],
    unreadableError: () => (reads++ % 2 === 0
      ? { ok: false, reason: 'unknown', error: 'Usage endpoint returned HTTP 429.' }
      : { ok: false, reason: 'expired', error: 'Auth rejected (HTTP 401).' }),
  });
  for (let i = 0; i < 6; i++) { await runOnce(deps); t += 1 * MIN; }
  assert.deepEqual(switched, ['b'], 'six minutes blind is six minutes blind, whatever the wording');
});

test('runOnce: unreadable everywhere is an outage, not a reason to move', async () => {
  // If no other account reads either, the endpoint (or the network) is down;
  // switching would install a token we cannot vouch for and burn the cooldown.
  __resetForTests();
  let t = 10_000_000;
  __setNowForTests(() => t);
  const { deps, switched } = harness({ percentById: { a: 0, b: 30 }, unreadable: ['a', 'b'] });
  for (let i = 0; i < 10; i++) { await runOnce(deps); t += 1 * MIN; }
  assert.deepEqual(switched, []);
});

test('runOnce: a readable active account clears the blind clock', async () => {
  __resetForTests();
  let t = 10_000_000;
  __setNowForTests(() => t);
  const h = harness({ percentById: { a: 20, b: 30 }, unreadable: ['a'] });
  await runOnce(h.deps);
  t += 4 * MIN;
  // The meters come back with headroom — the blind spell is over.
  const healthy = harness({ percentById: { a: 20, b: 30 } });
  await runOnce(healthy.deps);
  t += 2 * MIN;
  // Dark again: this is a NEW spell, so the grace starts over.
  assert.equal((await runOnce(h.deps)).switched, false);
  assert.deepEqual(h.switched, []);
});

test('runOnce: a blind switch resets the clock for the account it lands on', async () => {
  __resetForTests();
  let t = 10_000_000;
  __setNowForTests(() => t);
  const { deps, switched } = harness({ percentById: { a: 0, b: 30, c: 10 }, unreadable: ['a', 'b'] });
  await runOnce(deps);
  t += 6 * MIN;
  await runOnce(deps);
  assert.deepEqual(switched, ['c']);
  // Now c is active but (say) its meters are dark too. The cooldown and a
  // fresh grace both apply — no immediate second hop.
  deps.getActiveId = () => 'c';
  (deps as { getAccountUsage: RotationDeps['getAccountUsage'] }).getAccountUsage = async (acct) =>
    acct.id === 'b' ? usage([meter({ percent: 30 })]) : { ok: false, reason: 'expired', error: 'Auth rejected (HTTP 401).' };
  t += 1 * MIN;
  assert.equal((await runOnce(deps)).switched, false);
  assert.deepEqual(switched, ['c']);
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
