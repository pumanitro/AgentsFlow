import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daemonCommand, repairLink, tailscaleLink, type LinkRepairDeps } from './link-repair';

const TS_ARGS = ['-o', 'IdentitiesOnly=yes', '-o', 'ProxyCommand=/opt/homebrew/bin/tailscale --socket=/Users/demo/.ts/tailscaled.sock nc %h %p'];

function fakeDeps(over: Partial<LinkRepairDeps> & { aliveSeq?: boolean[] } = {}): LinkRepairDeps & { started: number } {
  const seq = over.aliveSeq ?? [false];
  let t = 0;
  const d = {
    started: 0,
    alive: async () => (seq.length > 1 ? seq.shift()! : seq[0]),
    exists: () => true,
    start: () => { d.started++; },
    sleep: async (ms: number) => { t += ms; },
    now: () => t,
    ...over,
  };
  return d;
}

test('tailscaleLink reads the CLI and socket out of a ProxyCommand', () => {
  assert.deepEqual(tailscaleLink({ sshArgs: TS_ARGS }), { bin: '/opt/homebrew/bin/tailscale', socket: '/Users/demo/.ts/tailscaled.sock' });
});

test('tailscaleLink ignores peers that do not use a userspace Tailscale daemon', () => {
  assert.equal(tailscaleLink({ sshArgs: [] }), null);
  assert.equal(tailscaleLink({ sshArgs: ['-o', 'ProxyCommand=ssh -W %h:%p jump'] }), null);
  assert.equal(tailscaleLink({ sshArgs: ['-o', 'ProxyCommand=/opt/homebrew/bin/tailscale nc %h %p'] }), null);
  assert.equal(tailscaleLink({ sshArgs: ['-o', 'ProxyCommand=tailscale --socket=/x/t.sock nc %h %p'] }), null);
});

test('daemonCommand puts the daemon beside the CLI and its state beside the socket', () => {
  assert.deepEqual(daemonCommand({ bin: '/opt/homebrew/bin/tailscale', socket: '/Users/demo/.ts/tailscaled.sock' }), {
    bin: '/opt/homebrew/bin/tailscaled',
    args: ['--tun=userspace-networking', '--statedir=/Users/demo/.ts', '--socket=/Users/demo/.ts/tailscaled.sock'],
    stateDir: '/Users/demo/.ts',
  });
});

test('repairLink does nothing for a peer without Tailscale', async () => {
  const d = fakeDeps();
  assert.deepEqual(await repairLink({ sshArgs: [] }, d), { repaired: false });
  assert.equal(d.started, 0);
});

test('repairLink leaves a running daemon alone', async () => {
  const d = fakeDeps({ aliveSeq: [true] });
  assert.deepEqual(await repairLink({ sshArgs: TS_ARGS }, d), { repaired: false });
  assert.equal(d.started, 0);
});

test('repairLink starts a dead daemon and reports the link repaired once it answers', async () => {
  const d = fakeDeps();
  d.alive = async () => d.started > 0;
  assert.deepEqual(await repairLink({ sshArgs: TS_ARGS }, d), { repaired: true });
  assert.equal(d.started, 1);
});

test('repairLink does not start a second daemon when the first comes back by itself', async () => {
  const d = fakeDeps({ aliveSeq: [false, false, false, true] });
  assert.deepEqual(await repairLink({ sshArgs: TS_ARGS }, d), { repaired: true });
  assert.equal(d.started, 0);
});

test('repairLink will not start a daemon that never ran here', async () => {
  const d = fakeDeps({ exists: (p) => !p.endsWith('tailscaled.state') });
  const r = await repairLink({ sshArgs: TS_ARGS }, d);
  assert.equal(r.repaired, false);
  assert.match(r.note ?? '', /Tailscale is not running/);
  assert.equal(d.started, 0);
});

test('repairLink says so when the daemon cannot be launched or never comes up', async () => {
  const failing = fakeDeps({ start: () => { throw new Error('EACCES'); } });
  assert.match((await repairLink({ sshArgs: TS_ARGS }, failing)).note ?? '', /could not be started \(EACCES\)/);
  const silent = fakeDeps();
  const r = await repairLink({ sshArgs: TS_ARGS }, silent);
  assert.equal(r.repaired, false);
  assert.match(r.note ?? '', /did not come up/);
  assert.equal(silent.started, 1);
});
