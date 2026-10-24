// Long-lived token vault against a real keychain.
//
// Safe to run: every item lives under a self-test service
// (`__setServiceForTests`), so the app's real tokens are never read or
// written. The values stored here are dummies, not credentials.

import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import {
  __setServiceForTests,
  __setTokenForTests,
  forgetToken,
  hasToken,
  loadTokenCache,
  markTokenRejected,
  storeToken,
  tokenFor,
  tokenRejectedReason,
} from './long-lived-token';

const TEST_SERVICE = 'Peers Flow-longlived-token-selftest';

function keychainUsable(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('security', ['-h'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('long-lived token vault (keychain)', { skip: keychainUsable() ? false : 'needs macOS `security`' }, () => {
  const idA = `selftest-${randomBytes(4).toString('hex')}`;
  const idB = `selftest-${randomBytes(4).toString('hex')}`;
  const tokenA = `dummy-a-${randomBytes(8).toString('hex')}`;

  const drop = (id: string) => {
    try {
      execFileSync('security', ['delete-generic-password', '-a', id, '-s', TEST_SERVICE], { stdio: 'ignore' });
    } catch { /* already gone */ }
  };

  before(() => __setServiceForTests(TEST_SERVICE));

  after(() => {
    drop(idA);
    drop(idB);
    __setServiceForTests(null);
  });

  test('storeToken makes hasToken/tokenFor see it', async () => {
    assert.equal(hasToken(idA), false);
    await storeToken(idA, tokenA);
    assert.equal(hasToken(idA), true);
    assert.equal(tokenFor(idA), tokenA);
    assert.equal(hasToken(null), false);
    assert.equal(tokenFor(undefined), undefined);
  });

  test('a cold loadTokenCache reads stored items and tolerates missing ones', async () => {
    __setServiceForTests(TEST_SERVICE); // empties the cache
    assert.equal(hasToken(idA), false);
    await loadTokenCache([{ id: idA }, { id: idB }]);
    assert.equal(tokenFor(idA), tokenA);
    assert.equal(hasToken(idB), false);
  });

  test('markTokenRejected hides the token; storeToken clears the verdict', async () => {
    __setTokenForTests(idA, undefined);
    assert.equal(hasToken(idA), false);
    __setTokenForTests(idA, tokenA);
    assert.equal(hasToken(idA), true);
    markTokenRejected(idA, 'cleared by CLI');
    assert.equal(hasToken(idA), false);
    assert.equal(tokenFor(idA), undefined);
    assert.equal(tokenRejectedReason(idA), 'cleared by CLI');
    await storeToken(idA, tokenA);
    assert.equal(tokenRejectedReason(idA), undefined);
    assert.equal(hasToken(idA), true);
    assert.equal(tokenFor(idA), tokenA);
  });

  test('__setTokenForTests seeds the cache without the keychain', () => {
    __setTokenForTests(idB, 'seeded');
    assert.equal(tokenFor(idB), 'seeded');
    __setTokenForTests(idB, undefined);
    assert.equal(hasToken(idB), false);
  });

  test('forgetToken removes it from cache and keychain', async () => {
    await forgetToken(idA);
    assert.equal(hasToken(idA), false);
    __setServiceForTests(TEST_SERVICE);
    await loadTokenCache([{ id: idA }]);
    assert.equal(hasToken(idA), false);
    await forgetToken(idA); // second forget is a no-op, not a throw
  });
});
