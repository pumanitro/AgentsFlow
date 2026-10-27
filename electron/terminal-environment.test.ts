import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { WriteStream } from 'node:tty';
import { terminalEnvironment } from './terminal-environment';
import { setKillShimDir } from './hookguards/shim-path';

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

test('kill shims lead the terminal PATH exactly once, and off means unchanged', () => {
  const source = { PATH: '/x/shims:/usr/bin', HOME: '/h' };
  try {
    setKillShimDir(null);
    const before = terminalEnvironment(source).PATH;
    setKillShimDir('/x/shims');
    const parts = terminalEnvironment(source).PATH.split(':');
    assert.equal(parts[0], '/x/shims');
    assert.equal(parts.filter((p) => p === '/x/shims').length, 1);
    setKillShimDir(null);
    assert.equal(terminalEnvironment(source).PATH, before);
  } finally { setKillShimDir(null); }
});
