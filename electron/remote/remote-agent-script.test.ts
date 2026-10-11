// Runs the COMPILED agent script as a child, exactly as the remote host would,
// against a temp CLAUDE_HOME / config and a fake `claude` this test writes.
import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { REMOTE_PROTOCOL_VERSION } from '../../shared/remote';

const SCRIPT = path.join(__dirname, 'remote-agent-script.js');

// Fake claude: --version, agents --json (>8 KB, to exercise the tempfile path),
// --bg (creates a job dir + logs its argv), stop/rm.
const FAKE_CLAUDE_JS = `
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const home = process.env.PEERSFLOW_CLAUDE_HOME;
if (a[0] === '--version') { process.stdout.write('\\x1b[32m1.2.3\\x1b[0m (Claude Code)\\nextra\\n'); process.exit(0); }
if (a[0] === 'agents' && a[1] === '--json') {
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push({ pid: 1000 + i, cwd: '/work/p' + i, kind: 'bg', startedAt: 1700000000000 + i, sessionId: 'sess-' + i, name: 'agent number ' + i, state: 'idle' });
  process.stdout.write(JSON.stringify(rows)); process.exit(0);
}
if (a[0] === '--bg') {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: a, cwd: process.cwd() }));
  const dir = path.join(home, 'jobs', 'abcdef12');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ state: 'running', daemonShort: 'abcdef12' }));
  process.stdout.write('\\x1b[1mbackgrounded · abcdef12 · fake\\x1b[0m\\n'); process.exit(0);
}
if (a[0] === 'stop' || a[0] === 'rm') process.exit(0);
process.stderr.write('fake claude: unknown args ' + a.join(' ')); process.exit(2);
`;

type Ev = Record<string, any>;

class Agent {
  readonly child: ChildProcess;
  readonly events: Ev[] = [];
  private buf = '';
  private waiters: { pred: (e: Ev) => boolean; resolve: (e: Ev) => void }[] = [];
  private seq = 0;
  stderr = '';

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const ev = JSON.parse(line) as Ev; // a non-JSON stdout line fails the test, by design
        this.events.push(ev);
        this.waiters = this.waiters.filter((w) => (w.pred(ev) ? (w.resolve(ev), false) : true));
      }
    });
    this.child.stderr!.on('data', (d: Buffer) => { this.stderr += d.toString(); });
  }

  waitFor(pred: (e: Ev) => boolean, timeoutMs = 8000, fromIndex = 0): Promise<Ev> {
    const hit = this.events.slice(fromIndex).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting; stderr=${this.stderr.slice(-500)}`)), timeoutMs);
      this.waiters.push({ pred, resolve: (e) => { clearTimeout(timer); resolve(e); } });
    });
  }

  async req(cmd: Record<string, unknown>, timeoutMs = 15000): Promise<Ev> {
    const id = `r${++this.seq}`;
    const p = this.waitFor((e) => e.id === id, timeoutMs);
    this.child.stdin!.write(JSON.stringify({ ...cmd, id }) + '\n');
    return p;
  }
}

let tmp: string;
let claudeHome: string;
let configPath: string;
let proj: string;
let fakeLog: string;
let env: NodeJS.ProcessEnv;
let agent: Agent;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-agent-')));
  claudeHome = path.join(tmp, 'claude-home');
  configPath = path.join(tmp, 'claude.json');
  proj = path.join(tmp, 'proj');
  fakeLog = path.join(tmp, 'fake-log.json');
  fs.mkdirSync(path.join(claudeHome, 'jobs'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'fake-claude.js'), FAKE_CLAUDE_JS);
  const fake = path.join(bin, 'claude');
  fs.writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake-claude.js')}" "$@"\n`);
  fs.chmodSync(fake, 0o755);
  env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PEERSFLOW_CLAUDE_BIN: fake,
    PEERSFLOW_CLAUDE_HOME: claudeHome,
    PEERSFLOW_CLAUDE_CONFIG: configPath,
    FAKE_LOG: fakeLog,
  };
  agent = new Agent(env);
});

after(() => {
  agent.child.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('compiled script requires only node built-ins', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // Code only: the header comment mentions require() in prose.
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  const reqs = [...code.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(reqs.length > 0);
  for (const r of reqs) assert.match(r, /^["']node:[a-z_/]+["']$/, `non-builtin require: ${r}`);
});

test('hello reports versions from the fake claude', async () => {
  const ev = await agent.req({ cmd: 'hello' });
  assert.equal(ev.t, 'hello');
  assert.equal(ev.protocol, REMOTE_PROTOCOL_VERSION);
  assert.equal(ev.claudeVersion, '1.2.3 (Claude Code)');
  assert.equal(ev.nodeVersion, process.version);
  assert.equal(ev.hostname, os.hostname());
  assert.equal(ev.home, os.homedir());
  assert.equal(typeof ev.pid, 'number');
});

test('agents parses >8 KB of rows via the tempfile', async () => {
  const ev = await agent.req({ cmd: 'agents' });
  assert.equal(ev.t, 'agents');
  assert.equal(ev.rows.length, 200);
  assert.equal(ev.rows[199].sessionId, 'sess-199');
});

test('unknown command and handler failures answer error; the channel survives', async () => {
  const a = await agent.req({ cmd: 'nope' });
  assert.deepEqual(a, { t: 'error', id: a.id, message: 'unknown command: nope' });
  const b = await agent.req({ cmd: 'read', path: path.join(tmp, 'missing.txt') });
  assert.equal(b.t, 'error');
  const c = await agent.req({ cmd: 'job', short: '../etc' });
  assert.equal(c.t, 'error');
  const d = await agent.req({ cmd: 'hello' });
  assert.equal(d.t, 'hello');
});

test('watch pushes job state on add and after a tmp+rename rewrite; agents are pushed', async () => {
  const short = 'aaaa1111';
  const dir = path.join(claudeHome, 'jobs', short);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ state: 'running' }));
  const start = agent.events.length;
  const done = await agent.req({ cmd: 'watch', jobs: [short] });
  assert.equal(done.t, 'done');
  const first = await agent.waitFor((e) => e.t === 'job' && e.id === '' && e.short === short, 5000, start);
  assert.equal(first.state.state, 'running');
  assert.ok(first.mtimeMs > 0);

  await new Promise((r) => setTimeout(r, 100));
  const mark = agent.events.length;
  const tmpFile = path.join(dir, 'state.json.tmp');
  fs.writeFileSync(tmpFile, JSON.stringify({ state: 'done', output: { result: 'ok' } }));
  fs.renameSync(tmpFile, path.join(dir, 'state.json'));
  const pushed = await agent.waitFor((e) => e.t === 'job' && e.id === '' && e.state?.state === 'done', 5000, mark);
  assert.equal(pushed.state.output.result, 'ok');

  const job = await agent.req({ cmd: 'job', short });
  assert.equal(job.t, 'job');
  assert.equal(job.state.state, 'done');

  const push = await agent.waitFor((e) => e.t === 'agents' && e.id === '', 8000, start);
  assert.equal(push.rows.length, 200);

  assert.equal((await agent.req({ cmd: 'watch', jobs: [] })).t, 'done');
});

test('spawn runs claude --bg with args + prompt in cwd and extracts the short', async () => {
  const ev = await agent.req({ cmd: 'spawn', cwd: proj, prompt: 'do the thing', args: ['--permission-mode', 'bypassPermissions'] });
  assert.equal(ev.t, 'spawned');
  assert.equal(ev.daemonShort, 'abcdef12');
  assert.equal(ev.code, 0);
  assert.match(ev.raw, /backgrounded · abcdef12/);
  const logged = JSON.parse(fs.readFileSync(fakeLog, 'utf8'));
  assert.deepEqual(logged.argv, ['--bg', '--permission-mode', 'bypassPermissions', 'do the thing']);
  assert.equal(fs.realpathSync(logged.cwd), proj);
  assert.ok(fs.existsSync(path.join(claudeHome, 'jobs', 'abcdef12', 'state.json')));
  assert.ok(!agent.stderr.includes('do the thing'), 'prompt must never be logged');
  assert.equal((await agent.req({ cmd: 'stop', short: 'abcdef12' })).t, 'done');
  assert.equal((await agent.req({ cmd: 'rm', short: 'abcdef12' })).t, 'done');
});

test('trust patches project trust + bypass disclaimer, keeps other keys, is idempotent, refuses junk', async () => {
  fs.writeFileSync(configPath, JSON.stringify({ keep: 1, projects: { '/other': { a: 1 } } }));
  const ev = await agent.req({ cmd: 'trust', dir: proj });
  assert.deepEqual(ev, { t: 'done', id: ev.id, changed: true });
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(cfg.keep, 1);
  assert.deepEqual(cfg.projects['/other'], { a: 1 });
  assert.equal(cfg.projects[proj].hasTrustDialogAccepted, true);
  assert.equal(cfg.bypassPermissionsModeAccepted, true);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  const again = await agent.req({ cmd: 'trust', dir: proj });
  assert.equal(again.changed, false);
  // Dir already trusted but the bypass disclaimer never accepted: still a change.
  fs.writeFileSync(configPath, JSON.stringify({ keep: 2, bypassPermissionsModeAccepted: false, projects: { [proj]: { hasTrustDialogAccepted: true, x: 1 } } }));
  const bypassOnly = await agent.req({ cmd: 'trust', dir: proj });
  assert.equal(bypassOnly.changed, true);
  const cfg2 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(cfg2.bypassPermissionsModeAccepted, true);
  assert.equal(cfg2.keep, 2);
  assert.deepEqual(cfg2.projects[proj], { hasTrustDialogAccepted: true, x: 1 });
  assert.equal((await agent.req({ cmd: 'trust', dir: proj })).changed, false);
  // Bypass accepted but dir untrusted: trust is added, the flag kept.
  fs.writeFileSync(configPath, JSON.stringify({ bypassPermissionsModeAccepted: true }));
  assert.equal((await agent.req({ cmd: 'trust', dir: proj })).changed, true);
  const cfg3 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(cfg3, { bypassPermissionsModeAccepted: true, projects: { [proj]: { hasTrustDialogAccepted: true } } });
  fs.writeFileSync(configPath, '{not json');
  assert.equal((await agent.req({ cmd: 'trust', dir: proj })).t, 'error');
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{not json');
});

function writeMd(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

test('skills: user + project scope, project shadows user, sorted', async () => {
  writeMd(path.join(claudeHome, 'commands', 'foo.md'), '---\ndescription: "foo cmd"\n---\nbody');
  writeMd(path.join(claudeHome, 'commands', 'git', 'commit.md'), '# Title\n\ncommit things');
  writeMd(path.join(claudeHome, 'skills', 'shared', 'SKILL.md'), '---\nname: shared\ndescription: user shared\n---\n');
  writeMd(path.join(proj, '.claude', 'skills', 'shared', 'SKILL.md'), '---\ndescription: project shared\n---\n');
  writeMd(path.join(proj, '.claude', 'commands', 'bar.md'), 'bar line');
  writeMd(path.join(proj, '.agents', 'skills', 'agentskill', 'SKILL.md'), 'agent skill desc');

  const user = await agent.req({ cmd: 'skills', dir: null });
  assert.deepEqual(user.entries.map((e: Ev) => e.name), ['foo', 'git:commit', 'shared']);
  assert.equal(user.entries[0].description, 'foo cmd');
  assert.equal(user.entries[1].description, 'commit things');
  assert.equal(user.entries[1].invocation, '/git:commit');

  const both = await agent.req({ cmd: 'skills', dir: proj });
  assert.deepEqual(both.entries.map((e: Ev) => e.name), ['agentskill', 'bar', 'foo', 'git:commit', 'shared']);
  const shared = both.entries.find((e: Ev) => e.name === 'shared');
  assert.deepEqual(shared, {
    name: 'shared', invocation: '/shared', description: 'project shared', scope: 'project', kind: 'skill',
    source: path.join(proj, '.claude', 'skills', 'shared', 'SKILL.md'),
  });
  assert.equal(both.entries.find((e: Ev) => e.name === 'foo').scope, 'user');
});

test('peerinfo reports flags, project skills only and host facts', async () => {
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# hi');
  fs.writeFileSync(path.join(proj, '.mcp.json'), '{}');
  const ev = await agent.req({ cmd: 'peerinfo', dir: proj });
  assert.equal(ev.t, 'peerinfo');
  const c = ev.cache;
  assert.equal(c.exists, true);
  assert.equal(c.hasClaudeMd, true);
  assert.equal(c.hasAgentsMd, false);
  assert.equal(c.hasProjectMcp, true);
  assert.equal(c.hasCodexConfig, false);
  assert.deepEqual(c.skills, [
    { name: 'agentskill', description: 'agent skill desc', kind: 'skill' },
    { name: 'bar', description: 'bar line', kind: 'command' },
    { name: 'shared', description: 'project shared', kind: 'skill' },
  ]);
  assert.equal(c.claudeVersion, '1.2.3 (Claude Code)');
  assert.equal(c.nodeVersion, process.version);
  const missing = await agent.req({ cmd: 'peerinfo', dir: path.join(tmp, 'nope') });
  assert.equal(missing.cache.exists, false);
  assert.deepEqual(missing.cache.skills, []);
});

test('tail streams a growing transcript, skips non-text turns, dedupes by uuid', async () => {
  const cwd = '/some/proj.x';
  const file = path.join(claudeHome, 'projects', '-some-proj-x', 'sess-1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = (o: object) => JSON.stringify(o) + '\n';
  fs.writeFileSync(file,
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-09T10:00:00Z', message: { content: 'hello there' } })
    + line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-09T10:00:01Z', message: { content: [{ type: 'text', text: 'part one' }, { type: 'tool_use' }, { type: 'text', text: 'part two' }] } })
    + line({ type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', content: 'x' }] } })
    + line({ type: 'summary', summary: 'nope' })
    + line({ type: 'user', uuid: 'u1', message: { content: 'hello there' } }));
  const start = agent.events.length;
  const done = await agent.req({ cmd: 'tail', sessionId: 'sess-1', cwd });
  assert.equal(done.t, 'done');
  const first = await agent.waitFor((e) => e.t === 'transcript' && e.sessionId === 'sess-1', 5000, start);
  assert.deepEqual(first.records, [
    { type: 'user', text: 'hello there', at: '2026-10-09T10:00:00Z' },
    { type: 'assistant', text: 'part one\npart two', at: '2026-10-09T10:00:01Z' },
  ]);

  // Grow it, including a line split across two writes.
  const mark = agent.events.length;
  const tail = line({ type: 'assistant', uuid: 'a2', timestamp: '2026-10-09T10:00:05Z', message: { content: 'é split ünïcode' } });
  const half = Buffer.from(tail).subarray(0, 20);
  fs.appendFileSync(file, line({ type: 'user', uuid: 'u3', timestamp: '2026-10-09T10:00:04Z', message: { content: 'more' } }));
  fs.appendFileSync(file, half);
  await new Promise((r) => setTimeout(r, 700));
  fs.appendFileSync(file, Buffer.from(tail).subarray(20));
  const second = await agent.waitFor((e) => e.t === 'transcript' && e.records.some((r: Ev) => r.text === 'é split ünïcode'), 5000, mark);
  const all = agent.events.slice(mark).filter((e) => e.t === 'transcript').flatMap((e) => e.records);
  assert.deepEqual(all.map((r: Ev) => r.text), ['more', 'é split ünïcode']);
  assert.ok(second);

  // Fallback scan: the cwd the laptop passes does not match the project dir.
  const other = path.join(claudeHome, 'projects', '-elsewhere', 'sess-2.jsonl');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, line({ type: 'user', uuid: 'z', message: { content: 'found by scan' } }));
  const m2 = agent.events.length;
  await agent.req({ cmd: 'tail', sessionId: 'sess-2', cwd: '/wrong/cwd' });
  const scanned = await agent.waitFor((e) => e.t === 'transcript' && e.sessionId === 'sess-2', 5000, m2);
  assert.equal(scanned.records[0].text, 'found by scan');

  assert.equal((await agent.req({ cmd: 'untail', sessionId: 'sess-1' })).t, 'done');
  assert.equal((await agent.req({ cmd: 'untail', sessionId: 'sess-2' })).t, 'done');
});

test('list, gitstatus and search on a temp git repo; walk on a plain dir', async () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a needle here\nnone\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
  git('add', 'tracked.txt', '.gitignore');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'Needle again\n');
  fs.writeFileSync(path.join(repo, 'ignored.log'), 'needle ignored\n');
  fs.appendFileSync(path.join(repo, 'tracked.txt'), 'changed\n');

  const list = await agent.req({ cmd: 'list', dir: repo });
  const byPath = Object.fromEntries(list.entries.map((e: Ev) => [e.path, e.isIgnored]));
  assert.deepEqual(byPath, { '.gitignore': false, 'tracked.txt': false, 'untracked.txt': false, 'ignored.log': true });

  const st = await agent.req({ cmd: 'gitstatus', dir: repo });
  assert.equal(st.result.isRepo, true);
  assert.equal(st.result.branch, 'main');
  const statuses = Object.fromEntries(st.result.entries.map((e: Ev) => [e.path, e.status]));
  assert.deepEqual(statuses, { 'tracked.txt': 'modified', 'untracked.txt': 'untracked' });

  const s = await agent.req({ cmd: 'search', dir: repo, query: 'needle' });
  assert.deepEqual(s.result.files.map((f: Ev) => f.path).sort(), ['tracked.txt', 'untracked.txt']);
  assert.deepEqual(s.result.files.find((f: Ev) => f.path === 'tracked.txt').matches, [{ line: 1, text: 'a needle here', ranges: [[2, 8]] }]);
  const cs = await agent.req({ cmd: 'search', dir: repo, query: 'Needle', caseSensitive: true });
  assert.equal(cs.result.totalMatches, 1);
  const bad = await agent.req({ cmd: 'search', dir: repo, query: '(', isRegex: true });
  assert.match(bad.result.error, /Invalid pattern/);

  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(path.join(plain, 'sub', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'sub', 'a.txt'), 'x');
  fs.writeFileSync(path.join(plain, 'sub', 'node_modules', 'skip.js'), 'x');
  const walk = await agent.req({ cmd: 'list', dir: plain });
  assert.deepEqual(walk.entries, [{ path: path.join('sub', 'a.txt'), isIgnored: false }]);
  const notRepo = await agent.req({ cmd: 'gitstatus', dir: plain });
  assert.deepEqual(notRepo.result, { isRepo: false, entries: [] });
});

test('write/read round-trip, stat, mkfile, rename, remove', async () => {
  const p = path.join(tmp, 'files', 'deep', 'f.bin');
  const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 65]);
  assert.equal((await agent.req({ cmd: 'write', path: p, contentBase64: bytes.toString('base64') })).t, 'done');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  const r = await agent.req({ cmd: 'read', path: p });
  assert.equal(r.t, 'file');
  assert.deepEqual(Buffer.from(r.contentBase64, 'base64'), bytes);
  assert.equal(r.size, bytes.length);
  assert.equal(r.truncated, false);
  const part = await agent.req({ cmd: 'read', path: p, maxBytes: 3 });
  assert.deepEqual(Buffer.from(part.contentBase64, 'base64'), bytes.subarray(0, 3));
  assert.equal(part.truncated, true);

  const st = await agent.req({ cmd: 'stat', path: p });
  assert.equal(st.result.exists, true);
  assert.equal(st.result.isFile, true);
  assert.equal(st.result.size, bytes.length);
  const none = await agent.req({ cmd: 'stat', path: path.join(tmp, 'nope') });
  assert.deepEqual(none.result, { exists: false, isFile: false, isDirectory: false, size: 0, mtimeMs: 0 });

  const nf = path.join(tmp, 'files', 'new.txt');
  assert.equal((await agent.req({ cmd: 'mkfile', path: nf })).t, 'done');
  assert.equal((await agent.req({ cmd: 'mkfile', path: nf })).t, 'error');
  assert.equal((await agent.req({ cmd: 'rename', from: nf, to: p })).t, 'error');
  const moved = path.join(tmp, 'files', 'moved.txt');
  assert.equal((await agent.req({ cmd: 'rename', from: nf, to: moved })).t, 'done');
  assert.ok(fs.existsSync(moved) && !fs.existsSync(nf));

  assert.equal((await agent.req({ cmd: 'remove', path: '/' })).t, 'error');
  assert.equal((await agent.req({ cmd: 'remove', path: '/tmp' })).t, 'error');
  assert.equal((await agent.req({ cmd: 'remove', path: path.join(tmp, 'files') })).t, 'done');
  assert.ok(!fs.existsSync(path.join(tmp, 'files')));
});

test('fswatch pushes a debounced fsevent and ignores node_modules', async () => {
  const dir = path.join(tmp, 'watched');
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  assert.equal((await agent.req({ cmd: 'fswatch', dir })).t, 'done');
  await new Promise((r) => setTimeout(r, 200));
  const mark = agent.events.length;
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'x');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(agent.events.slice(mark).filter((e) => e.t === 'fsevent').length, 0);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const ev = await agent.waitFor((e) => e.t === 'fsevent', 5000, mark);
  assert.equal(ev.dir, dir);
  assert.equal((await agent.req({ cmd: 'fsunwatch', dir })).t, 'done');
});

test('exec runs argv with cwd, captures output and code, honours timeout', async () => {
  const ev = await agent.req({ cmd: 'exec', argv: ['sh', '-c', 'pwd; echo err >&2; exit 3'], cwd: proj });
  assert.equal(ev.t, 'exec');
  assert.equal(ev.code, 3);
  assert.equal(fs.realpathSync(ev.stdout.trim()), proj);
  assert.equal(ev.stderr, 'err\n');
  assert.equal(ev.timedOut, false);
  const slow = await agent.req({ cmd: 'exec', argv: ['sleep', '5'], timeoutMs: 200 });
  assert.equal(slow.timedOut, true);
});

test('answers in-flight commands then exits 0 when stdin ends', () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: '{"cmd":"hello","id":"1"}\n{"cmd":"nope","id":"2"}\nnot json\n',
    encoding: 'utf8', timeout: 15_000, env,
  });
  assert.equal(r.status, 0, r.stderr);
  const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.length, 3);
  const byId = Object.fromEntries(events.map((e) => [e.id, e]));
  assert.equal(byId['1'].t, 'hello');
  assert.equal(byId['1'].claudeVersion, '1.2.3 (Claude Code)');
  assert.deepEqual(byId['2'], { t: 'error', id: '2', message: 'unknown command: nope' });
  assert.deepEqual(byId[''], { t: 'error', id: '', message: 'bad json' });
});

test('exits 0 on SIGTERM', async () => {
  const a = new Agent(env);
  await a.req({ cmd: 'hello' });
  const code = await new Promise<number | null>((resolve) => { a.child.on('exit', (c) => resolve(c)); a.child.kill('SIGTERM'); });
  assert.equal(code, 0);
});
