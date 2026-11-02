import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotenv, readMobileEnv } from './dev-mode';

test('flags and defaults', () => {
  assert.deepEqual(readMobileEnv({}), { devMode: false, port: 47820, sttKeyFromEnv: null });
  assert.equal(readMobileEnv({ PEERSFLOW_MOBILE_DEV: '1' }).devMode, true);
  assert.equal(readMobileEnv({ PEERSFLOW_MOBILE_DEV: 'true' }).devMode, false);
});

test('port validation', () => {
  assert.equal(readMobileEnv({ PEERSFLOW_MOBILE_PORT: '50000' }).port, 50000);
  for (const bad of ['80', '1023', '65536', 'abc', '', '12.5']) {
    assert.equal(readMobileEnv({ PEERSFLOW_MOBILE_PORT: bad }).port, 47820, bad);
  }
  assert.equal(readMobileEnv({ PEERSFLOW_MOBILE_PORT: '1024' }).port, 1024);
});

test('key from env wins over file', () => {
  const readFile = () => 'OPENAI_API_KEY=from-file\n';
  assert.equal(readMobileEnv({ PEERSFLOW_MOBILE_STT_KEY: ' sk-env ', PEERSFLOW_MOBILE_STT_KEY_FILE: '/x' }, readFile).sttKeyFromEnv, 'sk-env');
  assert.equal(readMobileEnv({ PEERSFLOW_MOBILE_STT_KEY_FILE: '/x' }, readFile).sttKeyFromEnv, 'from-file');
  assert.equal(readMobileEnv({ PEERSFLOW_MOBILE_STT_KEY: '  ', PEERSFLOW_MOBILE_STT_KEY_FILE: '/x' }, readFile).sttKeyFromEnv, 'from-file');
});

test('missing file or key yields null', () => {
  assert.equal(readMobileEnv({ PEERSFLOW_MOBILE_STT_KEY_FILE: '/x' }, () => null).sttKeyFromEnv, null);
  assert.equal(readMobileEnv({ PEERSFLOW_MOBILE_STT_KEY_FILE: '/x' }, () => 'OTHER=1').sttKeyFromEnv, null);
});

test('parseDotenv handles export, quotes, comments, CRLF', () => {
  const env = parseDotenv('# c\r\nexport A=1\r\nB="two words"\r\nC=\'sq\'\r\n\r\nD=plain # trailing\r\nE="a#b"\r\nnoeq\r\n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'sq', D: 'plain', E: 'a#b' });
});
