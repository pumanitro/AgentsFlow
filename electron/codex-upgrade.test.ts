import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexUpgradeDeps, upgradeCodexWhenIdle, upgradeNote } from './codex-upgrade';

interface World { server: string | null; installed: string; busy: string | null; restarts: string[]; logs: string[]; failRestart?: boolean; }

function deps(w: World): CodexUpgradeDeps {
  return {
    serverVersion: async () => w.server,
    available: async (running) => (running && running !== w.installed ? { from: running, to: w.installed } : null),
    busy: async () => w.busy,
    restart: async (note) => {
      w.restarts.push(note);
      if (w.failRestart) throw new Error('Cannot start Codex app-server');
      w.server = w.installed; // A fresh server pins whatever is installed now.
    },
    log: (message) => { w.logs.push(message); },
  };
}

const world = (over: Partial<World> = {}): World => ({ server: '0.154.0', installed: '0.155.0', busy: null, restarts: [], logs: [], ...over });

test.describe('upgradeCodexWhenIdle', () => {
  test('an idle server is restarted onto the newly installed CLI, and rows are told why', async () => {
    const w = world();
    assert.deepEqual(await upgradeCodexWhenIdle(deps(w)), { kind: 'upgraded', from: '0.154.0', to: '0.155.0' });
    assert.deepEqual(w.restarts, [upgradeNote('0.155.0')]);
    assert.equal(w.server, '0.155.0');
  });

  test('a working or open chat defers it — and it happens on a later check, once idle', async () => {
    const w = world({ busy: 'a Codex chat is working' });
    assert.deepEqual(await upgradeCodexWhenIdle(deps(w)), { kind: 'deferred', to: '0.155.0', reason: 'a Codex chat is working' });
    assert.deepEqual(w.restarts, []);
    w.busy = null;
    assert.equal((await upgradeCodexWhenIdle(deps(w))).kind, 'upgraded');
  });

  test('waiting is logged once, not on every check', async () => {
    const w = world({ busy: 'a Codex chat is open', installed: '0.156.0' });
    for (let i = 0; i < 5; i++) await upgradeCodexWhenIdle(deps(w));
    assert.equal(w.logs.length, 1);
  });

  test('already on the installed version: nothing happens', async () => {
    const w = world({ server: '0.155.0' });
    assert.deepEqual(await upgradeCodexWhenIdle(deps(w)), { kind: 'none' });
    assert.deepEqual(w.restarts, []);
  });

  test('no server running is not a reason to start one', async () => {
    const w = world({ server: null });
    assert.deepEqual(await upgradeCodexWhenIdle(deps(w)), { kind: 'none' });
    assert.deepEqual(w.restarts, []);
  });

  test('a restart that does not land on the new version is reported, not assumed', async () => {
    const w = world({ failRestart: true, installed: '0.157.0' });
    const outcome = await upgradeCodexWhenIdle(deps(w));
    assert.equal(outcome.kind, 'failed');
    assert.match((outcome as { error: string }).error, /Cannot start Codex app-server/);
  });
});
