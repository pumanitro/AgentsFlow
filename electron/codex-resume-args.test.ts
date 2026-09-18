import test from 'node:test';
import assert from 'node:assert/strict';
import { codexRemoteUrl, codexResumeArgs } from './codex-resume-args';

const THREAD = '01a0974a-9447-7ee0-9370-d89700a0e75f';
const SOCK = '/Users/x/Library/Application Support/Peers Flow/codex/app-server.sock';

test.describe('codexResumeArgs', () => {
  test('is the measured attach command: resume <thread> --remote unix://<sock> --no-alt-screen', () => {
    assert.deepEqual(codexResumeArgs(THREAD, SOCK), [
      'resume', THREAD,
      '--remote', `unix://${SOCK}`,
      '--no-alt-screen',
      '-c', 'check_for_update_on_startup=false',
    ]);
  });

  test('never lets the TUI offer its self-update — that runs npm install -g inside a PTY the app kills', () => {
    const args = codexResumeArgs(THREAD, SOCK);
    const at = args.indexOf('check_for_update_on_startup=false');
    assert.ok(at > 0 && args[at - 1] === '-c', 'the override must be passed as a -c pair');
  });

  test('carries no per-invocation agent flags — the thread already holds them', () => {
    const args = codexResumeArgs(THREAD, SOCK);
    for (const flag of ['--permission-mode', '--mcp-config', '--append-system-prompt', '--sandbox', '--cd']) {
      assert.ok(!args.includes(flag), `${flag} must not be re-asserted on a remote attach`);
    }
  });

  test('an absolute socket path yields a three-slash unix url', () => {
    assert.equal(codexRemoteUrl('/tmp/app-server.sock'), 'unix:///tmp/app-server.sock');
  });

  test('a relative socket path is refused rather than resolved against the chat cwd', () => {
    assert.throws(() => codexRemoteUrl('codex/app-server.sock'), /must be absolute/);
  });
});
