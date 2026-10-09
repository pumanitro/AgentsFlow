import { test, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentRow, JobStateJson } from '../../shared/remote';
import type { RemoteHostStatus, RemotePeerSpec, TrackedDirectory } from '../../shared/types';
import type { RunResult } from './remote-exec';
import { remoteCommand } from './remote-exec';
import { BUNDLE_FILES, RemoteHosts, type RemoteHostsDeps, type RemoteTransport } from './remote-hosts';

const HOME = '/Users/patryk';
const spec: RemotePeerSpec = {
  host: 'studio', user: 'patryk', sshArgs: [], claudeBin: '/opt/claude', nodeBin: 'node',
  extraPath: [], permissionMode: 'bypassPermissions',
};
const KEY = 'patryk@studio';

// A tiny NDJSON agent: enough of the remote-agent-script protocol to drive
// hello / agents / watch pushes / spawn / error / channel death.
const AGENT = `
const rl = require('readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stderr.write('agent up\\n');
rl.on('line', (line) => {
  const c = JSON.parse(line);
  switch (c.cmd) {
    case 'hello': return out({ t: 'hello', id: c.id, protocol: 1, hostname: 'studio.local', home: ${JSON.stringify(HOME)}, pid: process.pid, claudeVersion: '2.1.295', nodeVersion: process.version });
    case 'agents': return out({ t: 'agents', id: c.id, at: 1234, rows: [{ pid: 7, cwd: '/w', kind: 'bg', startedAt: 1, sessionId: 's1' }] });
    case 'watch':
      out({ t: 'done', id: c.id });
      for (const j of c.jobs) out({ t: 'job', id: '', short: j, state: { state: 'working', detail: 'gen' }, mtimeMs: 5 });
      return;
    case 'spawn': return out({ t: 'spawned', id: c.id, daemonShort: 'abc12345', raw: 'len=' + c.prompt.length + ' args=' + c.args.join(','), code: 0 });
    case 'peerinfo': return out({ t: 'peerinfo', id: c.id, cache: { exists: true, hasClaudeMd: true, hasAgentsMd: false, hasProjectMcp: false, hasCodexConfig: false, skills: [], hostname: 'studio.local', home: ${JSON.stringify(HOME)}, claudeVersion: '2.1.295', nodeVersion: process.version } });
    case 'skills': return out({ t: 'skills', id: c.id, entries: [{ name: 'deploy', description: 'd', source: 'project' }] });
    case 'read': return out({ t: 'file', id: c.id, contentBase64: Buffer.from('héllo').toString('base64'), size: 6, truncated: false });
    case 'exec':
      if (c.argv[0] === 'die') process.exit(3);
      return out({ t: 'exec', id: c.id, code: 0, stdout: c.argv.join(' '), stderr: '', timedOut: false });
    case 'tail': case 'fswatch':
      out({ t: 'done', id: c.id });
      if (c.cmd === 'fswatch') out({ t: 'fsevent', id: '', dir: c.dir });
      return;
    case 'write': return out({ t: Buffer.from(c.contentBase64, 'base64').toString() === 'x' ? 'done' : 'error', id: c.id, message: 'bad content' });
    default: return out({ t: 'error', id: c.id, message: 'unknown cmd ' + c.cmd });
  }
});
`;

interface Rec { runs: string[]; puts: { path: string; mode?: number; content: string }[]; forwards: string[]; cancels: number; closes: number; closesAtRun: number[]; sockChecks: number; channels: ChildProcess[]; channelCmds: string[] }

// sockOk answers `test -S <bridge sock>`; default: the socket exists.
function makeTransport(opts: { reachable: () => boolean; sockOk?: () => boolean }): { t: RemoteTransport; rec: Rec } {
  const rec: Rec = { runs: [], puts: [], forwards: [], cancels: 0, closes: 0, closesAtRun: [], sockChecks: 0, channels: [], channelCmds: [] };
  const uploaded = new Set<string>();
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
  const t: RemoteTransport = {
    run: async (_s, _i, command) => {
      rec.runs.push(command);
      if (!opts.reachable()) return { code: 255, stdout: '', stderr: 'ssh: connect to host studio port 22: Connection refused\nmore', timedOut: false };
      if (command === 'echo ok') return ok('ok\n');
      if (command.startsWith('printf')) return ok(`${HOME}\nstudio.local\n`);
      if (command.startsWith('test -S ')) { rec.sockChecks++; return { ...ok(), code: (opts.sockOk ?? (() => true))() ? 0 : 1 }; }
      if (command.startsWith('test -f ')) return { ...ok(), code: [...uploaded].some((p) => command.includes(p)) ? 0 : 1 };
      return ok();
    },
    openChannel: (_s, _i, command) => {
      rec.channelCmds.push(command);
      const child = spawn(process.execPath, ['-e', AGENT], { stdio: ['pipe', 'pipe', 'pipe'] });
      rec.channels.push(child);
      return child;
    },
    putFile: async (_s, _i, p, content, mode) => {
      rec.puts.push({ path: p, mode, content: content.toString() });
      if (p.endsWith('/.ok')) uploaded.add(p);
      return ok();
    },
    addReverseForward: async (_s, _i, r, l) => { rec.forwards.push(`${r}:${l}`); return ok(); },
    cancelReverseForward: async () => { rec.cancels++; return ok(); },
    masterAlive: async () => true,
    closeMaster: async () => { rec.closes++; rec.closesAtRun.push(rec.runs.length); },
  };
  return { t, rec };
}

function makeBundle(): { root: string; hash: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-bundle-'));
  const h = crypto.createHash('sha1');
  // Only two of the four files exist, like a dev build mid-wave: the rest are skipped.
  for (const rel of BUNDLE_FILES.slice(0, 2)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    const body = `// ${rel}\n`;
    fs.writeFileSync(path.join(root, rel), body);
    h.update(body);
  }
  return { root, hash: h.digest('hex') };
}

interface Seen { hosts: RemoteHostStatus[][]; jobs: [string, string, JobStateJson | null, number][]; rows: [string, AgentRow[], number][]; fs: string[]; updates: [string, Partial<TrackedDirectory>][] }

function makeDeps(dirs: TrackedDirectory[], transport: RemoteTransport, bundleRoot: string): { deps: RemoteHostsDeps; seen: Seen } {
  const seen: Seen = { hosts: [], jobs: [], rows: [], fs: [], updates: [] };
  const deps: RemoteHostsDeps = {
    instanceId: '/tmp/userdata-test', bundleRoot, localBridgeSock: '/tmp/local-bridge.sock',
    getDirectories: () => dirs,
    updateDirectory: (id, patch) => { seen.updates.push([id, patch]); },
    onHostsChanged: (h) => { seen.hosts.push(h); },
    onJobState: (k, s, st, m) => { seen.jobs.push([k, s, st, m]); },
    onAgentsRows: (k, r, at) => { seen.rows.push([k, r, at]); },
    onFsEvent: (k, d) => { seen.fs.push(`${k}:${d}`); },
    transport,
  };
  return { deps, seen };
}

const flush = () => new Promise<void>((r) => setImmediate(r));
async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

const remoteDir: TrackedDirectory = { id: 'd1', path: '/Users/patryk/pf-peer', displayName: 'pf', addedAt: '', remote: spec };

test('connects: probe, home, bundle upload, bridge forward, channel, hello → ready', async () => {
  const { root, hash } = makeBundle();
  const { t, rec } = makeTransport({ reachable: () => true });
  const { deps, seen } = makeDeps([remoteDir], t, root);
  const hosts = new RemoteHosts(deps);
  assert.equal(hosts.ptyCommand(KEY, ['claude']), null);
  hosts.start();
  await waitFor(() => hosts.status(KEY)?.state === 'ready', 'ready');

  const bundle = `${HOME}/.peersflow/bundles/${hash}`;
  assert.deepEqual(rec.runs.slice(0, 3), ['echo ok', `printf '%s\\n%s\\n' "$HOME" "$(hostname)"`, `test -f '${bundle}/.ok'`]);
  assert.deepEqual(rec.puts.map((p) => [p.path, p.mode]), [
    [`${bundle}/${BUNDLE_FILES[0]}`, 0o644], [`${bundle}/${BUNDLE_FILES[1]}`, 0o644], [`${bundle}/.ok`, 0o644],
  ]);
  const sock = hosts.remoteBridgeSock(KEY)!;
  assert.match(sock, /^\/Users\/patryk\/\.peersflow\/bridge-[0-9a-f]{8}\.sock$/);
  assert.ok(rec.runs.includes(`rm -f '${sock}'`));
  assert.deepEqual(rec.forwards, [`${sock}:/tmp/local-bridge.sock`]);
  // First connect of this process closed any leftover master before probing.
  assert.deepEqual(rec.closesAtRun, [0]);
  // Forward sequence: cancel → rm → add → verify with test -S.
  const rmAt = rec.runs.indexOf(`rm -f '${sock}'`);
  assert.equal(rec.runs[rmAt + 1], `test -S '${sock}'`);
  assert.equal(rec.cancels, 1);
  assert.equal(rec.channelCmds[0], remoteCommand(spec, ['node', `${bundle}/electron/remote/remote-agent-script.js`], { exec: true, env: { PEERSFLOW_CLAUDE_BIN: '/opt/claude' } }));

  const st = hosts.status(KEY)!;
  assert.equal(st.hostname, 'studio.local');
  assert.equal(st.claudeVersion, '2.1.295');
  assert.equal(st.bundleHash, hash);
  assert.equal(st.bridgeForwarded, true);
  assert.equal(st.agentPid, rec.channels[0].pid);
  assert.deepEqual(st.directoryIds, ['d1']);
  assert.ok(seen.hosts.some((hs) => hs[0]?.state === 'connecting'));
  assert.equal(hosts.bundlePath(KEY), bundle);
  assert.equal(hosts.mcpConfigDir(KEY), `${HOME}/.peersflow/mcp-configs`);
  assert.equal(hosts.attachmentsDir(KEY, 'c1'), `${HOME}/.peersflow/attachments/c1`);
  assert.equal(await hosts.ensureBridgeForward(KEY), true);
  assert.equal(rec.forwards.length, 1, 'socket present → no re-forward');

  // After ready: peerinfo for every dir on the host lands in the tracked dir.
  await waitFor(() => seen.updates.length > 0, 'peerinfo update');
  assert.equal(seen.updates[0][0], 'd1');
  assert.equal(seen.updates[0][1].remoteCache?.hostname, 'studio.local');
  assert.ok(seen.updates[0][1].remoteCache?.refreshedAt);

  const pty = hosts.ptyCommand(KEY, ['claude', 'attach', 'abc'], { cwd: '/w' })!;
  assert.equal(pty.bin, 'ssh');
  assert.ok(pty.args.includes('-tt'));
  assert.equal(pty.args.at(-1), remoteCommand(spec, ['claude', 'attach', 'abc'], { cwd: '/w', exec: true }));
  await hosts.reconnect(KEY);
  assert.equal(rec.closes, 1, 'later reconnects keep the master');
  await hosts.stop();
  assert.equal(rec.cancels, 3);
  assert.equal(rec.closes, 2);
});

test('commands resolve on their typed reply; events reach caches and callbacks', async () => {
  const { root } = makeBundle();
  const { t } = makeTransport({ reachable: () => true });
  const { deps, seen } = makeDeps([remoteDir], t, root);
  const hosts = new RemoteHosts(deps);
  hosts.start();
  await waitFor(() => hosts.status(KEY)?.state === 'ready', 'ready');

  assert.equal(hosts.agentsRows(KEY), null);
  const rows = await hosts.refreshAgents(KEY);
  assert.equal(rows[0].sessionId, 's1');
  assert.deepEqual(hosts.agentsRows(KEY), { rows, at: 1234 });
  assert.deepEqual(seen.rows.at(-1), [KEY, rows, 1234]);

  const sp = await hosts.spawn(KEY, { cwd: '/w', prompt: 'hello "world"\n', args: ['--model', 'opus'] });
  assert.deepEqual(sp, { daemonShort: 'abc12345', raw: 'len=14 args=--model,opus', code: 0 });

  hosts.setWatched(KEY, ['j2', 'j1', 'j1']);
  await waitFor(() => seen.jobs.length === 2, 'job pushes');
  assert.deepEqual(seen.jobs.map((j) => j[1]).sort(), ['j1', 'j2']);
  assert.deepEqual(hosts.jobState(KEY, 'j1'), { state: { state: 'working', detail: 'gen' }, mtimeMs: 5 });
  hosts.setWatched(KEY, ['j1', 'j2']); // same set → nothing sent
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(seen.jobs.length, 2);

  await assert.rejects(hosts.stopJob(KEY, 'x'), /unknown cmd stop/);
  await assert.rejects(hosts.writeFile(KEY, '/f', 'nope'), /bad content/);
  await hosts.writeFile(KEY, '/f', 'x');
  const f = await hosts.readFile(KEY, '/f');
  assert.equal(f.content.toString('utf8'), 'héllo');
  const skills = await hosts.skills(KEY, '/w');
  assert.equal(skills[0].name, 'deploy');
  assert.equal(await hosts.skills(KEY, '/w'), skills, 'second call served from the 30 s cache');
  const ex = await hosts.exec(KEY, ['git', 'status']);
  assert.deepEqual(ex, { code: 0, stdout: 'git status', stderr: '', timedOut: false });
  await hosts.fsWatch(KEY, '/w');
  await waitFor(() => seen.fs.length === 1, 'fsevent');
  assert.deepEqual(seen.fs, [`${KEY}:/w`]);

  // Rows go stale after 30 s on the laptop clock.
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 31_000 });
  try { assert.equal(hosts.agentsRows(KEY), null); } finally { mock.timers.reset(); }

  await assert.rejects(hosts.refreshAgents('nobody@nowhere'), /host nobody@nowhere is unknown/);
  await hosts.stop();
});

test('channel death rejects pending commands, backs off, reconnects and replays subscriptions', async () => {
  const { root } = makeBundle();
  const { t, rec } = makeTransport({ reachable: () => true });
  const { deps, seen } = makeDeps([remoteDir], t, root);
  const hosts = new RemoteHosts(deps);
  hosts.start();
  await waitFor(() => hosts.status(KEY)?.state === 'ready', 'ready');
  hosts.setWatched(KEY, ['j1']);
  await waitFor(() => seen.jobs.length === 1, 'first job push');
  const uploadsBefore = rec.puts.length;

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await assert.rejects(hosts.exec(KEY, ['die']), new RegExp(`host ${KEY} disconnected`));
    await waitFor(() => hosts.status(KEY)?.state === 'connecting', 'connecting');
    assert.match(hosts.status(KEY)!.error!, /agent channel exited/);
    await assert.rejects(hosts.refreshAgents(KEY), new RegExp(`host ${KEY} is connecting`));
    assert.equal(rec.channels.length, 1);
    mock.timers.tick(4_999);
    await flush();
    assert.equal(rec.channels.length, 1, 'no retry before 5 s');
    mock.timers.tick(1);
    await waitFor(() => hosts.status(KEY)?.state === 'ready', 'ready again');
  } finally { mock.timers.reset(); }
  assert.equal(rec.channels.length, 2);
  assert.equal(rec.puts.length, uploadsBefore, 'bundle .ok present → no re-upload');
  await waitFor(() => seen.jobs.length === 2, 'watch replayed after reconnect');
  assert.equal(seen.jobs[1][1], 'j1');
  await hosts.stop();
});

test('unreachable host: one-line error, 5 s → 10 s backoff, reconnect() retries now and resets', async () => {
  const { root } = makeBundle();
  let reachable = false;
  const { t, rec } = makeTransport({ reachable: () => reachable });
  const { deps } = makeDeps([remoteDir], t, root);
  const hosts = new RemoteHosts(deps);
  const probes = () => rec.runs.filter((r) => r === 'echo ok').length;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    hosts.start();
    await waitFor(() => hosts.status(KEY)?.state === 'unreachable', 'unreachable');
    const st = hosts.status(KEY)!;
    assert.equal(st.error, 'ssh: connect to host studio port 22: Connection refused');
    assert.ok(!Number.isNaN(Date.parse(st.since)));
    assert.equal(probes(), 1);
    mock.timers.tick(5_000);
    await waitFor(() => probes() === 2, 'retry at 5 s');
    mock.timers.tick(9_999);
    await flush();
    assert.equal(probes(), 2, 'second retry waits 10 s');
    mock.timers.tick(1);
    await waitFor(() => probes() === 3, 'retry at 10 s');
    reachable = true;
    await hosts.reconnect(KEY);
    assert.equal(probes(), 4);
    assert.equal(hosts.status(KEY)?.state, 'ready');
  } finally { mock.timers.reset(); }
  await hosts.stop();
});

test('hostKeyForPath: local dirs win, otherwise the longest remote prefix', () => {
  const other: RemotePeerSpec = { ...spec, user: 'theo' };
  const dirs: TrackedDirectory[] = [
    { id: 'r1', path: '/Users/patryk', displayName: '', addedAt: '', remote: other },
    { id: 'r2', path: '/Users/patryk/pf-peer', displayName: '', addedAt: '', remote: spec },
    { id: 'l1', path: '/Users/iij/proj', displayName: '', addedAt: '' },
    { id: 'r3', path: '/Users/iij/proj/sub', displayName: '', addedAt: '', remote: spec },
  ];
  const { t } = makeTransport({ reachable: () => true });
  const hosts = new RemoteHosts(makeDeps(dirs, t, '/nonexistent').deps);
  assert.equal(hosts.hostKeyForPath('/Users/patryk/pf-peer/src/a.ts'), KEY);
  assert.equal(hosts.hostKeyForPath('/Users/patryk/pf-peer'), KEY);
  assert.equal(hosts.hostKeyForPath('/Users/patryk/other'), 'theo@studio');
  assert.equal(hosts.hostKeyForPath('/Users/patryk/pf-peerX'), 'theo@studio');
  assert.equal(hosts.hostKeyForPath('/Users/iij/proj/sub/x'), null);
  assert.equal(hosts.hostKeyForPath('/tmp/x'), null);
  assert.equal(hosts.hostKeyForDir(dirs[1]), KEY);
  assert.equal(hosts.hostKeyForDir(dirs[2]), null);
});

test('syncFromDirectories drops hosts that own no dir any more', async () => {
  const { root } = makeBundle();
  const { t, rec } = makeTransport({ reachable: () => true });
  const dirs = [remoteDir];
  const { deps } = makeDeps(dirs, t, root);
  const hosts = new RemoteHosts(deps);
  hosts.start();
  await waitFor(() => hosts.status(KEY)?.state === 'ready', 'ready');
  dirs.length = 0;
  hosts.syncFromDirectories();
  assert.equal(hosts.status(KEY), null);
  assert.deepEqual(hosts.statuses(), []);
  await waitFor(() => rec.closes === 2, 'master closed');
  await waitFor(() => rec.channels[0].exitCode !== null || rec.channels[0].signalCode !== null, 'channel killed');
  await hosts.stop();
});

test('bridge verify failure: retries once, reports bridgeForwarded false, ensureBridgeForward recovers', async () => {
  const { root } = makeBundle();
  let sockOk = false;
  const { t, rec } = makeTransport({ reachable: () => true, sockOk: () => sockOk });
  const { deps } = makeDeps([remoteDir], t, root);
  const hosts = new RemoteHosts(deps);
  hosts.start();
  await waitFor(() => hosts.status(KEY)?.state === 'ready', 'ready');
  assert.equal(hosts.status(KEY)!.bridgeForwarded, false, 'forward "succeeded" but no socket → false');
  assert.equal(rec.forwards.length, 2, 'one retry');
  assert.equal(rec.cancels, 2);
  assert.equal(await hosts.ensureBridgeForward(KEY), false);
  assert.equal(rec.forwards.length, 4);
  sockOk = true;
  assert.equal(await hosts.ensureBridgeForward(KEY), true);
  assert.equal(rec.forwards.length, 5);
  assert.equal(hosts.status(KEY)!.bridgeForwarded, true);
  await hosts.stop();
});

test('watchdog re-forwards when the bridge socket disappears', async () => {
  const { root } = makeBundle();
  let sockOk = true;
  const { t, rec } = makeTransport({ reachable: () => true, sockOk: () => sockOk });
  const { deps, seen } = makeDeps([remoteDir], t, root);
  const hosts = new RemoteHosts(deps);
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    hosts.start();
    await waitFor(() => hosts.status(KEY)?.state === 'ready', 'ready');
    assert.equal(rec.forwards.length, 1);
    const checks = rec.sockChecks;
    mock.timers.tick(60_000);
    await waitFor(() => rec.sockChecks === checks + 1, 'watchdog probe');
    await flush();
    assert.equal(rec.forwards.length, 1, 'socket present → nothing to do');
    // The socket vanishes (sshd dropped the listener): next tick re-forwards.
    let missingOnce = true;
    sockOk = false;
    const emitted = seen.hosts.length;
    const orig = t.run;
    t.run = async (s2, i, c, o) => {
      if (c.startsWith('test -S ') && missingOnce) { missingOnce = false; rec.sockChecks++; return { code: 1, stdout: '', stderr: '', timedOut: false }; }
      if (c.startsWith('test -S ')) { rec.sockChecks++; return { code: 0, stdout: '', stderr: '', timedOut: false }; }
      return orig(s2, i, c, o);
    };
    mock.timers.tick(60_000);
    await waitFor(() => rec.forwards.length === 2, 're-forward');
    await waitFor(() => seen.hosts.length > emitted, 'status pushed');
    assert.equal(hosts.status(KEY)!.bridgeForwarded, true);
  } finally { mock.timers.reset(); }
  await hosts.stop();
});
