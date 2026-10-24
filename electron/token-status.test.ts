// The badge text the Accounts panel shows for an account's one-year token.
// Pure: every case runs against a fixed `now`.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { TOKEN_EXPIRING_DAYS, formatTokenDate, tokenStatus } from '../shared/token-status';

const DAY = 86_400_000;
// Midday UTC, so the local calendar date is the same in every time zone the
// tests could run in.
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('tokenStatus', () => {
  test('none: never minted', () => {
    const s = tokenStatus({}, NOW);
    assert.equal(s.state, 'none');
    assert.equal(s.label, 'no token');
    assert.equal(s.daysLeft, null);
    assert.ok(s.title.length > 0);
  });

  test('missing: minted, but the keychain no longer holds it', () => {
    const s = tokenStatus({ hasToken: false, tokenExpiresAt: iso(NOW + 200 * DAY) }, NOW);
    assert.equal(s.state, 'missing');
    assert.equal(s.label, 'token missing');
    assert.equal(s.daysLeft, null);
  });

  test('ok: held, a year left, label carries the date', () => {
    const exp = NOW + 365 * DAY;
    const s = tokenStatus({ hasToken: true, tokenExpiresAt: iso(exp) }, NOW);
    assert.equal(s.state, 'ok');
    assert.equal(s.label, `token · until ${formatTokenDate(exp)}`);
    assert.equal(s.label, 'token · until 24 Oct 2027');
    assert.equal(s.daysLeft, 365);
  });

  test('expiring: held, 12 days left', () => {
    const s = tokenStatus({ hasToken: true, tokenExpiresAt: iso(NOW + 12 * DAY) }, NOW);
    assert.equal(s.state, 'expiring');
    assert.equal(s.label, 'token · 12 d left');
    assert.equal(s.daysLeft, 12);
  });

  test('expired: held and past its date', () => {
    const s = tokenStatus({ hasToken: true, tokenExpiresAt: iso(NOW - DAY) }, NOW);
    assert.equal(s.state, 'expired');
    assert.equal(s.label, 'token expired');
    assert.equal(s.daysLeft, 0);
  });

  test('expired exactly at the expiry instant', () => {
    assert.equal(tokenStatus({ hasToken: true, tokenExpiresAt: iso(NOW) }, NOW).state, 'expired');
  });

  test('boundary: exactly 30 days is expiring, a minute more is ok', () => {
    const at = tokenStatus({ hasToken: true, tokenExpiresAt: iso(NOW + TOKEN_EXPIRING_DAYS * DAY) }, NOW);
    assert.equal(at.state, 'expiring');
    assert.equal(at.daysLeft, 30);
    const past = tokenStatus({ hasToken: true, tokenExpiresAt: iso(NOW + TOKEN_EXPIRING_DAYS * DAY + 60_000) }, NOW);
    assert.equal(past.state, 'ok');
    assert.equal(past.daysLeft, 31);
  });

  test('rejected wins over every other state', () => {
    const why = 'Claude refused this token — generate a new one.';
    for (const a of [
      {},
      { hasToken: false, tokenExpiresAt: iso(NOW + 200 * DAY) },
      { hasToken: true, tokenExpiresAt: iso(NOW + 365 * DAY) },
      { hasToken: true, tokenExpiresAt: iso(NOW + 12 * DAY) },
      { hasToken: true, tokenExpiresAt: iso(NOW - DAY) },
    ]) {
      const s = tokenStatus({ ...a, tokenRejected: why }, NOW);
      assert.equal(s.state, 'rejected');
      assert.equal(s.label, 'token rejected');
      assert.equal(s.title, why);
      assert.equal(s.daysLeft, null);
    }
  });

  test('held token with an unreadable date is still ok', () => {
    const s = tokenStatus({ hasToken: true, tokenExpiresAt: 'not a date' }, NOW);
    assert.equal(s.state, 'ok');
    assert.equal(s.daysLeft, null);
  });
});
