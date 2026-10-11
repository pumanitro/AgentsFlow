import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RemotePeerSpec } from '../../shared/types';
import {
  addReverseForward, cancelReverseForward, closeMaster, controlPath, masterAlive, openChannel, ptySpec, putFile,
  remoteBootstrap, remoteCommand, runRemote, shellQuote, sshArgv,
} from './remote-exec';

const spec: RemotePeerSpec = {
  host: 'studio.example', user: 'patryk', sshArgs: ['-i', '/k/id'], claudeBin: 'claude', nodeBin: 'node',
  envFile: '~/.config/peersflow/env', extraPath: ['~/.local/bin', '/opt/homebrew/bin'], permissionMode: 'bypassPermissions',
};

// Round-trips through a real /bin/sh so the quoting is proven, not eyeballed.
function shEcho(word: string): string {
  return execFileSync('/bin/sh', ['-c', `printf '%s' ${word}`], { encoding: 'utf8' });
}

test('shellQuote survives the shell for awkward strings', () => {
  for (const s of ['', 'plain', "it's", 'a b\tc', '$HOME `id` "x"', 'line1\nline2', "''", 'zażółć ✓']) {
    assert.equal(shEcho(shellQuote(s)), s);
  }
  assert.equal(shellQuote(''), "''");
});

test('sshArgv puts options, extra args, target, then command in order', () => {
  const argv = sshArgv(spec, 'inst', { before: ['-tt'], command: 'echo ok' });
  assert.deepEqual(argv.slice(0, 2), ['-o', 'BatchMode=yes']);
  assert.ok(argv.includes(`ControlPath=${controlPath(spec, 'inst')}`));
  const target = argv.indexOf('patryk@studio.example');
  assert.deepEqual(argv.slice(target - 3), ['-i', '/k/id', '-tt', 'patryk@studio.example', 'echo ok']);
  assert.equal(sshArgv(spec, 'inst').at(-1), 'patryk@studio.example');
});

test('controlPath is per instance and per host, and short', () => {
  const a = controlPath(spec, 'one');
  assert.notEqual(a, controlPath(spec, 'two'));
  assert.notEqual(a, controlPath({ ...spec, user: 'other' }, 'one'));
  assert.ok(a.length < 104, a);
});

test('remoteBootstrap expands ~ remotely and sources the env file', () => {
  const b = remoteBootstrap(spec);
  assert.ok(b.startsWith(`export PATH="$HOME"/'.local/bin':'/opt/homebrew/bin':"$PATH"; `), b);
  assert.ok(b.includes(`if [ -f "$HOME"/'.config/peersflow/env' ]; then set -a; . "$HOME"/'.config/peersflow/env'; set +a; fi; `), b);
  assert.ok(!remoteBootstrap({ ...spec, envFile: undefined }).includes('set -a'));
});

test('remoteCommand quotes argv, env, cwd and execs', () => {
  const c = remoteCommand({ ...spec, envFile: undefined, extraPath: [] }, ['node', "/a b/it's.js"], { cwd: '/w d', exec: true, env: { K: "v'1" } });
  assert.ok(c.endsWith(`export K='v'\\''1'; cd '/w d' && exec 'node' '/a b/it'\\''s.js'`), c);
  assert.throws(() => remoteCommand(spec, ['x'], { env: { 'BAD;rm': '1' } }));
  // The whole line is valid sh that produces the exact argv.
  const line = remoteCommand({ ...spec, envFile: undefined, extraPath: [] }, ['printf', '%s|', 'a b', "c'd"]);
  assert.equal(execFileSync('/bin/sh', ['-c', line], { encoding: 'utf8' }), "a b|c'd|");
});

test('ptySpec wraps ssh -tt', () => {
  const p = ptySpec(spec, 'inst', 'exec claude attach x');
  assert.equal(p.bin, 'ssh');
  assert.deepEqual(p.args.slice(-3), ['-tt', 'patryk@studio.example', 'exec claude attach x']);
});

test('remoteCommand bootstraps PATH, HOME-relative env file, env, cwd and exec for real', () => {
  // A fake remote home: ~/bin/claude prints its argv, cwd and env; the env file sets a token.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-rexec-home-'));
  fs.mkdirSync(path.join(home, 'bin'));
  fs.mkdirSync(path.join(home, 'work dir'));
  fs.writeFileSync(path.join(home, 'bin', 'claude'), '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\nprintf "\\n%s\\n%s|%s|%s\\n" "$(pwd -P)" "$TOKEN" "$PEERSFLOW_CLAUDE_BIN" "$LANG"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'env'), "TOKEN='s3cr t'\n");
  const s: RemotePeerSpec = { ...spec, envFile: '~/env', extraPath: ['~/bin'] };
  const line = remoteCommand(s, ['claude', '--bg', "it's a \"prompt\" $HOME `x`"], { cwd: path.join(home, 'work dir'), exec: true, env: { PEERSFLOW_CLAUDE_BIN: 'claude' } });
  const out = execFileSync('/bin/sh', ['-c', line], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } }).split('\n');
  assert.equal(out[0], `[--bg][it's a "prompt" $HOME \`x\`]`);
  assert.equal(out[1], fs.realpathSync(path.join(home, 'work dir')));
  assert.equal(out[2], 's3cr t|claude|en_US.UTF-8');
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- the ssh-spawning functions, against a fake `ssh` placed first on PATH ----
// cliEnv() keeps process.env.PATH in front, so spawn('ssh') finds the fake.
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-fake-ssh-'));
const argvLog = path.join(fakeDir, 'argv.log');
fs.writeFileSync(path.join(fakeDir, 'ssh'), `#!/bin/sh
: > "$FAKE_SSH_LOG"
for a in "$@"; do printf '%s\\n' "$a" >> "$FAKE_SSH_LOG"; done
for last in "$@"; do :; done
case "$FAKE_SSH_MODE" in
  sleep) exec sleep 5 ;;
  fail) echo "boom" >&2; exit 255 ;;
  exec) exec /bin/sh -c "$last" ;;
esac
exit 0
`, { mode: 0o755 });
process.env.PATH = `${fakeDir}:${process.env.PATH ?? ''}`;
process.env.FAKE_SSH_LOG = argvLog;
const loggedArgv = () => fs.readFileSync(argvLog, 'utf8').split('\n').slice(0, -1);

test('runRemote spawns ssh with sshArgv, pipes stdin and collects output', async () => {
  process.env.FAKE_SSH_MODE = 'exec';
  const r = await runRemote(spec, 'inst', 'cat; echo; echo err >&2; exit 3', { stdin: 'zażółć\nline' });
  assert.deepEqual(r, { code: 3, stdout: 'zażółć\nline\n', stderr: 'err\n', timedOut: false });
  assert.deepEqual(loggedArgv(), sshArgv(spec, 'inst', { command: 'cat; echo; echo err >&2; exit 3' }));
});

test('runRemote times out with SIGTERM and timedOut: true', async () => {
  process.env.FAKE_SSH_MODE = 'sleep';
  const t0 = Date.now();
  const r = await runRemote(spec, 'inst', 'x', { timeoutMs: 200 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - t0 < 3000);
});

test('control commands use -O forward/cancel/check/exit before the target', async () => {
  process.env.FAKE_SSH_MODE = '';
  await addReverseForward(spec, 'inst', '/r/b.sock', '/l/b.sock');
  assert.deepEqual(loggedArgv().slice(-5), ['-O', 'forward', '-R', '/r/b.sock:/l/b.sock', 'patryk@studio.example']);
  await cancelReverseForward(spec, 'inst', '/r/b.sock', '/l/b.sock');
  assert.deepEqual(loggedArgv().slice(-5), ['-O', 'cancel', '-R', '/r/b.sock:/l/b.sock', 'patryk@studio.example']);
  assert.equal(await masterAlive(spec, 'inst'), true);
  assert.deepEqual(loggedArgv().slice(-3), ['-O', 'check', 'patryk@studio.example']);
  process.env.FAKE_SSH_MODE = 'fail';
  assert.equal(await masterAlive(spec, 'inst'), false);
  await closeMaster(spec, 'inst');
  assert.deepEqual(loggedArgv().slice(-3), ['-O', 'exit', 'patryk@studio.example']);
  assert.ok(loggedArgv().includes(`ControlPath=${controlPath(spec, 'inst')}`));
});

test('putFile creates parent dirs, writes stdin and sets the mode', async () => {
  process.env.FAKE_SSH_MODE = 'exec';
  const target = path.join(fakeDir, "a dir/it's", 'file.js');
  const r = await putFile(spec, 'inst', target, Buffer.from('console.log(1)\n'), 0o644);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), 'console.log(1)\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  await putFile(spec, 'inst', target, 'secret');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('openChannel returns a live child with piped stdio', async () => {
  process.env.FAKE_SSH_MODE = 'exec';
  const child = openChannel(spec, 'inst', 'cat');
  let out = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => { out += d; });
  child.stdin!.end('{"cmd":"hello","id":"1"}\n');
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.equal(out, '{"cmd":"hello","id":"1"}\n');
});

test('cleanup fake ssh dir', () => {
  fs.rmSync(fakeDir, { recursive: true, force: true });
});
