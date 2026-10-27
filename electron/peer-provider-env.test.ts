import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isProviderEnvKey, providerEnvKeys, readPeerProviderEnv } from './peer-provider-env';

function peer(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peersflow-provider-env-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, '.claude', name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

test('a peer pointed at a local bridge yields its provider vars, other env keys dropped', () => {
  const dir = peer({
    'settings.json': {
      model: 'qwen/x',
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8780',
        ANTHROPIC_AUTH_TOKEN: 'sk-secret',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen/x',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: 32000,
        API_TIMEOUT_MS: '600000',
        MY_TOOL_FLAG: '1',
      },
    },
  });
  try {
    assert.deepEqual(readPeerProviderEnv([dir]), {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8780',
      ANTHROPIC_AUTH_TOKEN: 'sk-secret',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen/x',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
      API_TIMEOUT_MS: '600000',
    });
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('settings.local.json overrides settings.json, and a later dir overrides an earlier one', () => {
  const root = peer({
    'settings.json': { env: { ANTHROPIC_BASE_URL: 'http://shared', ANTHROPIC_MODEL: 'a' } },
    'settings.local.json': { env: { ANTHROPIC_BASE_URL: 'http://local' } },
  });
  const worktree = peer({ 'settings.json': { env: { ANTHROPIC_MODEL: 'b' } } });
  try {
    assert.deepEqual(readPeerProviderEnv([root]), { ANTHROPIC_BASE_URL: 'http://local', ANTHROPIC_MODEL: 'a' });
    assert.deepEqual(readPeerProviderEnv([root, worktree]), { ANTHROPIC_BASE_URL: 'http://local', ANTHROPIC_MODEL: 'b' });
  } finally {
    fs.rmSync(root, { recursive: true });
    fs.rmSync(worktree, { recursive: true });
  }
});

test('an ordinary peer gets nothing, so its launch is unchanged', () => {
  const plain = peer({ 'settings.json': { permissions: { allow: [] }, env: { DEBUG: '1' } } });
  const broken = peer({ 'settings.json': '{ not json', 'settings.local.json': { env: ['ANTHROPIC_BASE_URL'] } });
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'peersflow-provider-env-'));
  try {
    assert.deepEqual(readPeerProviderEnv([plain]), {});
    assert.deepEqual(readPeerProviderEnv([broken]), {});
    assert.deepEqual(readPeerProviderEnv([bare, bare]), {});
    assert.deepEqual(readPeerProviderEnv([]), {});
  } finally {
    for (const d of [plain, broken, bare]) fs.rmSync(d, { recursive: true });
  }
});

test('provider keys: endpoint, credentials, models, CLAUDE_CODE_*, API timeout — nothing else', () => {
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL', 'API_TIMEOUT_MS']) assert(isProviderEnvKey(k), k);
  for (const k of ['ANTHROPIC_DEFAULT_MODEL_X', 'PATH', 'HOME', 'DEBUG', 'CLAUDE_CONFIG_DIR', 'api_timeout_ms']) assert(!isProviderEnvKey(k), k);
});

test('the log view carries key names only, never values', () => {
  const keys = providerEnvKeys({ ANTHROPIC_AUTH_TOKEN: 'sk-secret', ANTHROPIC_BASE_URL: 'http://x' });
  assert.deepEqual(keys, ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  assert(!JSON.stringify(keys).includes('sk-secret'));
});
