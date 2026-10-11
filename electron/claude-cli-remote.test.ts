import { strict as assert } from 'node:assert';
import { test, beforeEach, after } from 'node:test';
import type { AgentRow, JobStateJson } from '../shared/remote';
import { getRemoteHosts, setRemoteHosts, type RemoteHosts } from './remote/remote-hosts';

// The local path spawns CLAUDE_BIN, read once at module load. Point it at
// /usr/bin/false BEFORE claude-cli loads (hence the dynamic import below), so
// the "no host" tests exercise the real local code without a real `claude`.
process.env.CLAUDE_BIN = '/usr/bin/false';
type Cli = typeof import('./claude-cli');
let cli: Cli;

const HOST = 'patryk@studio.example';
const row = (sessionId: string, extra: Partial<AgentRow> = {}): AgentRow => ({
  pid: 4242, cwd: '/Users/patryk/pf-peer', kind: 'bg', startedAt: 1_700_000_000_000, sessionId, ...extra,
});

interface Fake {
  calls: string[];
  cachedRows: { rows: AgentRow[]; at: number } | null;
  freshRows: AgentRow[];
  refreshThrows: boolean;
  jobs: Map<string, { state: JobStateJson | null; mtimeMs: number }>;
  spawnReq: { cwd: string; prompt: string; args: string[] } | null;
  spawnThrows: boolean;
}

let fake: Fake;

function install(): void {
  fake = { calls: [], cachedRows: null, freshRows: [], refreshThrows: false, jobs: new Map(), spawnReq: null, spawnThrows: false };
  const f = fake;
  setRemoteHosts({
    agentsRows: (h: string) => { f.calls.push(`agentsRows ${h}`); return f.cachedRows; },
    jobState: (h: string, s: string) => { f.calls.push(`jobState ${h} ${s}`); return f.jobs.get(s) ?? null; },
    refreshAgents: async (h: string) => {
      f.calls.push(`refreshAgents ${h}`);
      if (f.refreshThrows) throw new Error(`host ${h} is connecting`);
      return f.freshRows;
    },
    spawn: async (h: string, req: { cwd: string; prompt: string; args: string[] }) => {
      f.calls.push(`spawn ${h}`);
      if (f.spawnThrows) throw new Error(`host ${h} is unreachable`);
      f.spawnReq = req;
      return { daemonShort: 'abcd1234', raw: 'backgrounded · abcd1234', code: 0 };
    },
    stopJob: async (h: string, s: string) => { f.calls.push(`stopJob ${h} ${s}`); throw new Error('boom'); },
    rmJob: async (h: string, s: string) => { f.calls.push(`rmJob ${h} ${s}`); },
    specFor: (h: string) => { f.calls.push(`specFor ${h}`); return null; },
    ptyCommand: (h: string) => { f.calls.push(`ptyCommand ${h}`); return null; },
  } as unknown as RemoteHosts);
}

beforeEach(async () => {
  if (!cli) cli = await import('./claude-cli');
  install();
});
after(() => setRemoteHosts(null));

test('listAgentsResult(host): a fresh cached listing is served without a round-trip', async () => {
  fake.cachedRows = { rows: [row('11111111-aaaa', { status: 'busy', waitingFor: 'x' })], at: Date.now() - 2_000 };
  const r = await cli.listAgentsResult(HOST);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.rows, [{ pid: 4242, cwd: '/Users/patryk/pf-peer', kind: 'bg', startedAt: 1_700_000_000_000, sessionId: '11111111-aaaa', status: 'busy', waitingFor: 'x' }]);
  assert.deepEqual(fake.calls, [`agentsRows ${HOST}`]);
});

test('listAgentsResult(host): a cache older than 10 s triggers refreshAgents', async () => {
  fake.cachedRows = { rows: [row('stale-0000')], at: Date.now() - 10_500 };
  fake.freshRows = [row('fresh-1111')];
  const r = await cli.listAgentsResult(HOST);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.rows.map((x) => x.sessionId), ['fresh-1111']);
  assert.deepEqual(fake.calls, [`agentsRows ${HOST}`, `refreshAgents ${HOST}`]);
});

test('listAgentsResult(host): no cache at all also refreshes', async () => {
  fake.freshRows = [row('fresh-2222')];
  const r = await cli.listAgentsResult(HOST);
  assert.deepEqual(r.ok && r.rows.map((x) => x.sessionId), ['fresh-2222']);
});

test('listAgentsResult(host): a failing refresh is { ok:false } — unknown, not empty', async () => {
  fake.refreshThrows = true;
  assert.deepEqual(await cli.listAgentsResult(HOST), { ok: false, reason: 'exit' });
  assert.deepEqual(await cli.listAgents(HOST), []);
});

test('listAgentsResult(host): no RemoteHosts at all is { ok:false }', async () => {
  setRemoteHosts(null);
  assert.deepEqual(await cli.listAgentsResult(HOST), { ok: false, reason: 'exit' });
});

test('readJobState(host) is a synchronous cache read; jobStateMtimeMs follows the cache', () => {
  fake.jobs.set('abcd1234', { state: { state: 'working', detail: 'reading files' }, mtimeMs: 1234 });
  const got = cli.readJobState('abcd1234', HOST);
  // Not a promise: the poller calls this on its hot path.
  assert.ok(!(got instanceof Promise));
  assert.deepEqual(got, { state: 'working', detail: 'reading files' });
  assert.equal(cli.jobStateMtimeMs('abcd1234', HOST), 1234);
  assert.equal(cli.readJobState('unknown0', HOST), null);
  assert.equal(cli.jobStateMtimeMs('unknown0', HOST), 0);
  setRemoteHosts(null);
  assert.equal(cli.readJobState('abcd1234', HOST), null);
  assert.equal(cli.jobStateMtimeMs('abcd1234', HOST), 0);
});

test('dispatchBackground(host): args in the local argv order, minus --bg and the prompt', async () => {
  const r = await cli.dispatchBackground({
    cwd: '/Users/patryk/pf-peer', prompt: 'do the thing', host: HOST,
    model: 'opus', mcpConfigPath: '/Users/patryk/.peersflow/mcp-configs/c1.json', appendSystemPrompt: 'REGISTRY',
  });
  assert.deepEqual(r, { daemonShort: 'abcd1234', raw: 'backgrounded · abcd1234', code: 0 });
  assert.deepEqual(fake.spawnReq, {
    cwd: '/Users/patryk/pf-peer',
    prompt: 'do the thing',
    args: ['--permission-mode', 'bypassPermissions', '--model', 'opus', '--mcp-config', '/Users/patryk/.peersflow/mcp-configs/c1.json', '--append-system-prompt', 'REGISTRY'],
  });
});

test('dispatchBackground(host): optional flags are omitted, a spawn failure is a parseable miss', async () => {
  await cli.dispatchBackground({ cwd: '/d', prompt: 'p', host: HOST });
  assert.deepEqual(fake.spawnReq!.args, ['--permission-mode', 'bypassPermissions']);
  fake.spawnThrows = true;
  const r = await cli.dispatchBackground({ cwd: '/d', prompt: 'p', host: HOST });
  assert.equal(r.daemonShort, null);
  assert.equal(r.code, -1);
  assert.match(r.raw, /unreachable/);
});

test('hasLiveDaemon(host): matches against the host rows, confirms a miss with a fresh listing, fails open', async () => {
  fake.cachedRows = { rows: [row('abcd1234-0000-0000')], at: Date.now() };
  assert.equal(await cli.hasLiveDaemon('abcd1234', HOST), true);
  assert.equal(await cli.hasLiveDaemon('abcd1234-0000-0000', HOST), true);

  // Cached miss, fresh listing has it (a session spawned after the cache).
  fake.calls = [];
  fake.freshRows = [row('feed0000-1111')];
  assert.equal(await cli.hasLiveDaemon('feed0000', HOST), true);
  assert.deepEqual(fake.calls, [`agentsRows ${HOST}`, `refreshAgents ${HOST}`]);

  // Miss in both.
  fake.freshRows = [];
  assert.equal(await cli.hasLiveDaemon('dead0000', HOST), false);

  // Listing failed → fail open (attach, never a forking --resume).
  fake.cachedRows = null;
  fake.refreshThrows = true;
  assert.equal(await cli.hasLiveDaemon('dead0000', HOST), true);
});

test('resolveSessionByDaemonShort(host) and resolveLatestSessionInCwd(host) poll fresh host rows', async () => {
  fake.cachedRows = { rows: [], at: Date.now() };
  fake.freshRows = [row('abcd1234-9999', { startedAt: Date.now() })];
  const byShort = await cli.resolveSessionByDaemonShort('abcd1234', 1_000, HOST);
  assert.equal(byShort?.sessionId, 'abcd1234-9999');
  const latest = await cli.resolveLatestSessionInCwd({
    cwd: '/Users/patryk/pf-peer', startedAfterMs: Date.now() - 5_000, excludeSessionIds: new Set(), maxWaitMs: 1_000, host: HOST,
  });
  assert.equal(latest?.sessionId, 'abcd1234-9999');
  assert.ok(fake.calls.every((c) => c === `refreshAgents ${HOST}`), fake.calls.join(','));
});

test('stopAgent / removeAgent(host) route to stopJob / rmJob and swallow errors', async () => {
  await cli.stopAgent('abcd1234', HOST); // fake stopJob throws
  await cli.removeAgent('abcd1234', HOST);
  assert.deepEqual(fake.calls, [`stopJob ${HOST} abcd1234`, `rmJob ${HOST} abcd1234`]);
  setRemoteHosts(null);
  await cli.stopAgent('abcd1234', HOST);
});

test('no host: every function takes the local path and never consults RemoteHosts', async () => {
  assert.equal(getRemoteHosts() !== null, true);
  // CLAUDE_BIN=/usr/bin/false → the local CLI "fails", which is fine: the point
  // is which path ran.
  const r = await cli.listAgentsResult();
  assert.deepEqual(r, { ok: false, reason: 'exit' });
  assert.deepEqual(await cli.listAgents(), []);
  assert.equal(cli.readJobState('zz000000'), null);
  assert.equal(cli.jobStateMtimeMs('zz000000'), 0);
  const d = await cli.dispatchBackground({ cwd: process.cwd(), prompt: 'p' });
  assert.equal(d.daemonShort, null);
  assert.equal(await cli.hasLiveDaemon('zz000000'), true); // local fail-open
  await cli.stopAgent('zz000000');
  await cli.removeAgent('zz000000');
  assert.equal(await cli.resolveSessionByDaemonShort('zz000000', 300), null);
  assert.deepEqual(fake.calls, []);
});
