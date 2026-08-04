import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeArgs, redactResumeArgs } from './resume-args';

const SESSION = '4359c196-800c-4c31-9e63-16edfeb8f45d';
const CONFIG = '/Users/x/Library/Application Support/Peers Flow/mcp-configs/abc.json';

test.describe('buildResumeArgs', () => {
  test('a plain resume carries the mcp config and the peer registry', () => {
    const args = buildResumeArgs({
      sessionId: SESSION,
      mcpConfigPath: CONFIG,
      appendSystemPrompt: '# Peers Flow — your peers & delegation',
    });
    assert.deepEqual(args, [
      '--resume', SESSION,
      '--permission-mode', 'bypassPermissions',
      '--mcp-config', CONFIG,
      '--append-system-prompt', '# Peers Flow — your peers & delegation',
    ]);
  });

  test('a fork carries them too — the branched session is a fresh CLI as well', () => {
    const args = buildResumeArgs({
      sessionId: 'new-id',
      forkFrom: SESSION,
      mcpConfigPath: CONFIG,
      appendSystemPrompt: 'registry',
    });
    assert.deepEqual(args, [
      '--resume', SESSION,
      '--fork-session', '--session-id', 'new-id',
      '--permission-mode', 'bypassPermissions',
      '--mcp-config', CONFIG,
      '--append-system-prompt', 'registry',
    ]);
  });

  test('the prompt stays the LAST argument, so nothing is parsed as part of it', () => {
    const args = buildResumeArgs({ sessionId: SESSION, mcpConfigPath: CONFIG, appendSystemPrompt: 'p' });
    assert.equal(args[args.length - 2], '--append-system-prompt');
    assert.equal(args[args.length - 1], 'p');
  });

  test('omitting peer awareness degrades to the old argv rather than passing empty flags', () => {
    // An empty `--mcp-config ""` would make the CLI fail to boot, so a failed
    // bootstrap must drop the flag entirely — the session loses open_file but
    // still opens.
    assert.deepEqual(buildResumeArgs({ sessionId: SESSION }), [
      '--resume', SESSION, '--permission-mode', 'bypassPermissions',
    ]);
    assert.deepEqual(buildResumeArgs({ sessionId: SESSION, mcpConfigPath: '', appendSystemPrompt: '' }), [
      '--resume', SESSION, '--permission-mode', 'bypassPermissions',
    ]);
  });
});

test.describe('redactResumeArgs', () => {
  test('elides the multi-KB system prompt but keeps every other argument', () => {
    const prompt = 'x'.repeat(4096);
    const redacted = redactResumeArgs(buildResumeArgs({
      sessionId: SESSION, mcpConfigPath: CONFIG, appendSystemPrompt: prompt,
    }));
    assert.deepEqual(redacted, [
      '--resume', SESSION,
      '--permission-mode', 'bypassPermissions',
      '--mcp-config', CONFIG,
      '--append-system-prompt', '<4096 chars>',
    ]);
    assert.ok(!redacted.join(' ').includes(prompt));
  });

  test('leaves an argv without a prompt untouched', () => {
    const args = buildResumeArgs({ sessionId: SESSION });
    assert.deepEqual(redactResumeArgs(args), args);
  });
});
