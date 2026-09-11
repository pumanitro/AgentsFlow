import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { WriteStream } from 'node:tty';
import { terminalEnvironment } from './terminal-environment';

test('an automation launcher cannot downgrade the embedded terminal to monochrome', () => {
  const launcher = { TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0', CLICOLOR_FORCE: '0', COLORTERM: '', CLICOLOR: '0', PATH: '/usr/bin', CUSTOM_SETTING: 'keep' };
  const env = terminalEnvironment(launcher);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.CLICOLOR, '1');
  assert.equal(env.TERM_PROGRAM, 'PeersFlow');
  assert.equal(env.NO_COLOR, undefined);
  assert.equal(env.FORCE_COLOR, undefined);
  assert.equal(env.CLICOLOR_FORCE, undefined);
  assert.equal(env.CUSTOM_SETTING, 'keep');
  assert.equal(launcher.NO_COLOR, '1', 'do not change the parent or noninteractive CLI environment');
  // Exercise a real CLI color detector, beyond merely checking assignments.
  assert.equal(WriteStream.prototype.getColorDepth.call({} as WriteStream, env), 24);
});
