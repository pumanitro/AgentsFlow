import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import type { Conversation, DeferredMarker, GuardSnapshot, KeeperSnapshot, KillLogEntry, MemLevel } from '../shared/types';
import type { ClaudeAgentJsonRow } from './claude-cli';
import type { Exec } from './guard/docker-inventory';
import { GUARD_TICK_MS, __resetGuardForTests, __setGuardFilesForTests, getGuardSnapshot, getMemLevel, runGuardOnce } from './guard/guard';
import type { GuardDeps } from './guard/guard';
import { appendKillLog, parseKillLogLine, readKillLogSince } from './guard/kill-log';
import { fixture } from './guard/test-fixtures';
import { listDeferredMarkers, parseDeferredMarker } from './keeper/deferred-markers';
import { __resetKeeperForTests, attributeKill, getKeeperSnapshot, runKeeperOnce, type KeeperDeps } from './keeper/keeper';
import { NUDGE_COOLDOWN_MS, hhmm, killedText, memoryFreeText } from './keeper/keeper-policy';
import type { TranscriptSignals } from './keeper/transcript-signals';

// The seams between three things that were built apart and never import each
// other: the admission hook and the launchd memguard (shell), the memory guard
// and the Keeper (this app). The files they exchange are the whole interface,
// so every test here uses the REAL artefact on the writing side — the hook's
// own marker, the memguard's own kill-log lines, the guard's own appendKillLog
// and admission file — and the real reader on the other.
//
// Nothing here can touch the machine: both scripts run with fake memory
// readings and every path they write pointed into a temp dir; the memguard runs
// dry three times over (--dry-run, MEMGUARD_DRY_RUN=1, MEMGUARD_ACTION=notify)
// against a ps fixture of dead pids; the guard's exec is a fake that only
// RECORDS `docker stop`; the Keeper types into a list.

const HOOK = path.join(os.homedir(), '.claude', 'hooks', 'mem-admission.sh');
const MEMGUARD = path.join(os.homedir(), 'Library', 'Scripts', 'memguard-system.sh');
const MEM_BUDGET = path.join(os.homedir(), '.claude', 'tools', 'cpu-gate', 'mem-budget.mjs');
const PS_FIXTURE = path.join(os.homedir(), '.claude', 'tools', 'cpu-gate', 'fixtures', 'ps-2026-09-22.txt');
const BASH = '/bin/bash';
const EXEC_TIMEOUT_MS = 20_000;

function onPath(bin: string): boolean {
  return (process.env.PATH || '').split(path.delimiter).some((d) => !!d && fs.existsSync(path.join(d, bin)));
}

function missing(...files: string[]): string | false {
  if (process.platform !== 'darwin') return 'the hook and the memguard are macOS scripts';
  if (!fs.existsSync(BASH)) return `${BASH} is missing`;
  if (!onPath('jq')) return 'jq is not on PATH';
  for (const f of files) if (!fs.existsSync(f)) return `${f} is missing`;
  return false;
}
const SKIP_HOOK = missing(HOOK, MEM_BUDGET);
const SKIP_MEMGUARD = missing(MEMGUARD, MEM_BUDGET, PS_FIXTURE);

const SID = '5e55aaaa-1111-4222-8333-444455556666';
const SHORT = SID.slice(0, 8);
const CLAUDE_PID = 4242;
const HOUR = 60 * 60_000;

// Both loops log what they do; a passing run should not read like an incident.
const logLines: string[] = [];
const realLog = console.log;
const realWarn = console.warn;
const scratch: string[] = [];
before(() => {
  console.log = (...a: unknown[]) => { logLines.push(a.map(String).join(' ')); };
  console.warn = (...a: unknown[]) => { logLines.push(a.map(String).join(' ')); };
});
after(() => {
  console.log = realLog;
  console.warn = realWarn;
  __resetKeeperForTests();
  __resetGuardForTests();
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `keeper-guard-${label}-`));
  scratch.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// The shell side
// ---------------------------------------------------------------------------

/** The scripts' own knobs must come from the test, never from whoever runs it. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(MEM_|MEMGUARD_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, MEM_NODE: process.execPath, ...extra };
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { env, timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as unknown as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    child.stdin?.end(stdin);
  });
}

function hookPayload(over: { session_id?: string; description?: string } = {}): string {
  const p: Record<string, unknown> = {
    session_id: SID,
    transcript_path: '/Users/demo/.claude/projects/-Users-demo-proj/5e55aaaa.jsonl',
    cwd: '/Users/demo/proj',
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { prompt: 'Probe the staging database and report its size.', description: over.description ?? 'spawn: probe', subagent_type: 'general-purpose', model: 'sonnet' },
  };
  if ('session_id' in over) {
    if (over.session_id === undefined) delete p.session_id;
    else p.session_id = over.session_id;
  }
  return JSON.stringify(p);
}

interface HookRun { dir: string; deferDir: string; log: string; code: number | null; stdout: string; stderr: string; files: string[] }

/** One run of the real hook: fake reading, every path it writes under a temp dir. */
async function runHook(opts: { availGB: number; payload?: string; closedFile?: string; dir?: string }): Promise<HookRun> {
  const dir = opts.dir ?? tmp('hook');
  const deferDir = path.join(dir, 'mem-deferred');
  const log = path.join(dir, 'mem-admission.log');
  const r = await run(BASH, [HOOK], cleanEnv({
    MEM_FAKE_AVAIL_GB: String(opts.availGB),
    MEM_ADMISSION_WAIT_S: '1',
    MEM_ADMISSION_DEFER_DIR: deferDir,
    MEM_ADMISSION_LOG: log,
    MEM_LOCK_DIR: path.join(dir, 'locks'),
    MEM_ADMISSION_CLOSED_FILE: opts.closedFile ?? path.join(dir, 'locks', 'mem-admission-closed'),
  }), opts.payload ?? hookPayload());
  return { dir, deferDir, log, ...r, files: fs.existsSync(deferDir) ? fs.readdirSync(deferDir).sort() : [] };
}

let deniedOnce: Promise<HookRun> | null = null;
/** The hook refusing one spawn at a fake-critical reading; run once, shared by the tests that only read its marker. */
function deniedHook(): Promise<HookRun> {
  if (!deniedOnce) deniedOnce = runHook({ availGB: 5 });
  return deniedOnce;
}

interface MemguardRun { dir: string; killLog: string; log: string; code: number | null; stdout: string; stderr: string; lines: string[] }
let memguardOnce: Promise<MemguardRun> | null = null;
/**
 * One DRY tick of the real memguard at a fake-critical reading, the selftest's
 * recipe: fake ps (dead pids), throwaway log/state/kill-log, no notification,
 * no Docker. Dry is forced three ways; nothing is ever signalled.
 */
function memguardDry(): Promise<MemguardRun> {
  if (!memguardOnce) {
    memguardOnce = (async () => {
      const dir = tmp('memguard');
      const killLog = path.join(dir, 'kills.jsonl');
      const log = path.join(dir, 'memguard.log');
      const r = await run(BASH, [MEMGUARD, '--once', '--dry-run'], cleanEnv({
        MEMGUARD_DRY_RUN: '1',
        MEMGUARD_ACTION: 'notify',
        MEMGUARD_NO_NOTIFY: '1',
        MEMGUARD_LOG: log,
        MEM_LOCK_DIR: path.join(dir, 'locks'),
        MEMGUARD_KILL_LOG: killLog,
        MEMGUARD_DOCKER_PROC: 'keeper-guard-test-no-such-process',
        MEMGUARD_CRIT_TICKS: '1',
        MEM_FAKE_AVAIL_GB: '3',
        MEM_FAKE_PS: PS_FIXTURE,
      }), '');
      const lines = fs.existsSync(killLog) ? fs.readFileSync(killLog, 'utf8').split('\n').filter(Boolean) : [];
      return { dir, killLog, log, ...r, lines };
    })();
  }
  return memguardOnce;
}

// ---------------------------------------------------------------------------
// The Keeper's world: a store, a process list, a clock — and REAL files
// ---------------------------------------------------------------------------

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'a', sessionId: SID, daemonShort: SHORT, sessionName: '', directoryId: 'd', directoryPath: '/Users/demo/proj',
    displayName: 'proj', title: 'Chat A', description: '', pinned: true, state: 'working', status: 'idle', intent: '',
    createdAt: new Date(Date.now() - HOUR).toISOString(), lastPrompt: '',
    // 'once': nothing keeps this chat alive, so every nudge below is a retry it was owed.
    contract: 'once', contractSource: 'chip',
    ...over,
  };
}

function liveRow(over: Partial<ClaudeAgentJsonRow> = {}): ClaudeAgentJsonRow {
  return { pid: CLAUDE_PID, cwd: '/Users/demo/proj', kind: 'bg', startedAt: Date.now() - HOUR, sessionId: SID, status: 'idle', ...over };
}

const SIGNALS: TranscriptSignals = { lastAssistantText: 'step 1 done.', lastAssistantAt: 0, declaredDone: false, hasCron: false, hasLoopCommand: false, openTasks: 0 };

interface World {
  deps: KeeperDeps;
  convs: Map<string, Conversation>;
  rows: ClaudeAgentJsonRow[];
  now: number;
  mem: MemLevel | (() => MemLevel);
  nudges: Array<{ id: string; text: string }>;
  relaunches: string[];
  killReads: Array<{ from: number; to: number; entries: number }>;
  deferredDir: string;
  killLog: string;
  tick: (ms?: number) => Promise<KeeperSnapshot>;
}

/** `startAt` must not be before the real artefacts' timestamps (they are stamped by the scripts' own clocks). */
function world(opts: { convs?: Conversation[]; startAt?: number } = {}): World {
  __resetKeeperForTests();
  const dir = tmp('world');
  const w = {
    convs: new Map((opts.convs ?? [conv()]).map((c) => [c.id, c])),
    rows: [liveRow()],
    now: opts.startAt ?? Date.now() + 2_000,
    mem: 'ok' as World['mem'],
    nudges: [] as World['nudges'],
    relaunches: [] as string[],
    killReads: [] as World['killReads'],
    deferredDir: path.join(dir, 'mem-deferred'),
    killLog: path.join(dir, 'memguard-kills.jsonl'),
  } as World;
  fs.mkdirSync(w.deferredDir, { recursive: true });
  w.deps = {
    getConversations: () => Array.from(w.convs.values()),
    getConversation: (id) => w.convs.get(id) ?? null,
    updateConversation: (id, patch) => {
      const prev = w.convs.get(id);
      if (prev) w.convs.set(id, { ...prev, ...patch });
    },
    liveRows: () => ({ rows: w.rows, at: w.now }),
    jobQuietAt: () => 0,
    isWalled: () => false,
    poolHasHeadroom: async () => true,
    memLevel: () => (typeof w.mem === 'function' ? w.mem() : w.mem),
    // The guard's real reader over a real file — the wiring main.ts uses.
    readKillsSince: (offset) => {
      const r = readKillLogSince(offset, w.killLog);
      w.killReads.push({ from: offset, to: r.offset, entries: r.entries.length });
      return r;
    },
    nudge: async (c, text) => { w.nudges.push({ id: c.id, text }); return { ok: true }; },
    relaunch: async (c) => { w.relaunches.push(c.id); return { ok: true }; },
    notify: () => {},
    onSnapshot: () => {},
    now: () => w.now,
    readSignals: () => SIGNALS,
    // Never the default: that is the real ~/.claude/locks/mem-deferred.
    deferredDir: w.deferredDir,
  };
  w.tick = async (ms = 0) => {
    w.now += ms;
    await runKeeperOnce(w.deps);
    return getKeeperSnapshot();
  };
  return w;
}

/** Hand the Keeper the hook's own file, byte for byte, under its own name. */
function deliverMarker(w: World, h: HookRun, name: string = h.files[0]): string {
  const to = path.join(w.deferredDir, name);
  fs.copyFileSync(path.join(h.deferDir, name), to);
  return to;
}

/** The memguard's own stamp: UTC, whole seconds, no milliseconds. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A real kill-log line with only the named fields changed — everything else stays as the script wrote it. */
function edited(line: string, patch: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), ...patch });
}

function writeLines(file: string, lines: string[]): void {
  fs.writeFileSync(file, lines.map((l) => l + '\n').join(''));
}

// ---------------------------------------------------------------------------
// The guard's world: a fake exec over the captured inventory
// ---------------------------------------------------------------------------

interface GuardHarness {
  pins: string; killLog: string; admission: string;
  state: { now: number; pressure: string; liveRows: ClaudeAgentJsonRow[] };
  calls: string[][]; snaps: GuardSnapshot[];
  tick: (advanceMs?: number) => Promise<MemLevel>;
  stops: () => string[][];
  entries: () => KillLogEntry[];
}

function guardHarness(startAt: number, killLog?: string): GuardHarness {
  const dir = tmp('guard');
  const h = {
    pins: path.join(dir, 'locks', 'memguard-pins.json'),
    killLog: killLog ?? path.join(dir, 'locks', 'memguard-kills.jsonl'),
    admission: path.join(dir, 'locks', 'mem-admission-closed'),
    state: { now: startAt, pressure: '1\n', liveRows: [] as ClaudeAgentJsonRow[] },
    calls: [] as string[][],
    snaps: [] as GuardSnapshot[],
  };
  const stopped = new Set<string>();
  // Answers the read-only commands from WP-02's captures and only RECORDS
  // `docker stop`; anything else throws, so nothing real can run from here.
  const exec: Exec = async (cmd, args) => {
    h.calls.push([cmd, ...args]);
    if (cmd === 'vm_stat') return fixture('vm_stat.txt');
    if (cmd === 'sysctl' && args[1] === 'kern.memorystatus_vm_pressure_level') return h.state.pressure;
    if (cmd === 'sysctl' && args[1] === 'vm.swapusage') return fixture('swapusage.txt');
    if (cmd === 'pgrep') return '';
    if (cmd === 'netstat') return fixture('netstat-established.txt');
    if (cmd === 'docker') {
      if (args[0] === 'ps') {
        return fixture('docker-ps.jsonl').split('\n').filter(Boolean).map((l) => {
          const j = JSON.parse(l);
          if (stopped.has(j.Names)) j.State = 'exited';
          return JSON.stringify(j);
        }).join('\n');
      }
      if (args[0] === 'inspect') return fixture('docker-inspect.tsv');
      if (args[0] === 'stats') return fixture('docker-stats.tsv').split('\n').filter((l) => !stopped.has(l.split('\t')[0])).join('\n');
      if (args[0] === 'compose') return fixture('docker-compose-ls.json');
      if (args[0] === 'stop' && args.length === 2) { stopped.add(args[1]); return 'ok\n'; }
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
  const deps: GuardDeps = {
    liveRows: () => h.state.liveRows,
    getConversations: () => [],
    notify: () => {},
    onSnapshot: (s) => { h.snaps.push(s); },
    exec,
    now: () => h.state.now,
  };
  __resetGuardForTests();
  __setGuardFilesForTests({ pins: h.pins, killLog: h.killLog, admission: h.admission });
  return {
    ...h,
    tick: async (advanceMs = 0) => { h.state.now += advanceMs; await runGuardOnce(deps); return getMemLevel(); },
    stops: () => h.calls.filter((c) => c[0] === 'docker' && c[1] === 'stop'),
    entries: () => (fs.existsSync(h.killLog) ? fs.readFileSync(h.killLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as KillLogEntry) : []),
  };
}

function writePinsLive(h: GuardHarness): void {
  fs.mkdirSync(path.dirname(h.pins), { recursive: true });
  fs.writeFileSync(h.pins, JSON.stringify({ version: 1, keep: [], mode: 'live', idleMinutes: 120 }));
}

/** One calm tick (every container first seen), then three hours later two kernel-critical ticks. */
async function driveToCritical(h: GuardHarness): Promise<void> {
  await h.tick();
  h.state.pressure = '4\n';
  await h.tick(3 * HOUR);
  assert.equal(await h.tick(GUARD_TICK_MS), 'critical');
}

// The guard's captured containers started 07:49Z on this day.
const GUARD_T0 = Date.parse('2026-10-11T09:20:00Z');

// ===========================================================================
// Seam 1 — admission hook → marker file → Keeper
// ===========================================================================

test('hook → marker: a refused spawn leaves exactly one marker, written atomically, that the Keeper\'s parser accepts whole', { skip: SKIP_HOOK }, async () => {
  const h = await deniedHook();
  assert.equal(h.code, 0, `the hook always exits 0 (stderr: ${h.stderr})`);
  const out = JSON.parse(h.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /its Keeper will tell you when memory is free/);

  // One file, <session first 8>-<epoch ms>.json, and no temp file left beside it.
  assert.equal(h.files.length, 1, `files in the deferred dir: ${h.files.join(', ')}`);
  assert.match(h.files[0], new RegExp(`^${SHORT}-\\d{13}\\.json$`));
  const raw = fs.readFileSync(path.join(h.deferDir, h.files[0]), 'utf8');

  const marker = parseDeferredMarker(raw);
  assert.ok(marker, `parseDeferredMarker rejected the hook's own marker: ${raw}`);
  const { at, ...rest } = marker;
  assert.deepEqual(rest, {
    schema: 1,
    sessionId: SID,
    cwd: '/Users/demo/proj',
    transcriptPath: '/Users/demo/.claude/projects/-Users-demo-proj/5e55aaaa.jsonl',
    toolName: 'Agent',
    what: 'spawn: probe',
    reason: 'critical (avail 5.0 < 10)',
    availGB: 5,
    state: 'critical',
    subagentType: 'general-purpose',
    model: 'sonnet',
  } satisfies Omit<DeferredMarker, 'at'>);
  assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Math.abs(Date.now() - Date.parse(at)) < 5 * 60_000, 'stamped with the real clock, in UTC');
  // Nothing the parser had to invent or drop: the file holds exactly the DeferredMarker keys.
  assert.deepEqual(Object.keys(JSON.parse(raw) as object).sort(), Object.keys(marker).sort());

  // The directory reader agrees, and the hook's log names the same file.
  const listed = listDeferredMarkers(h.deferDir, Date.now());
  assert.deepEqual(listed.map((m) => path.basename(m.file)), h.files);
  assert.deepEqual(listed[0].marker, marker);
  const logged = fs.readFileSync(h.log, 'utf8').trim().split('\n');
  assert.equal(logged.length, 1);
  assert.match(logged[0], new RegExp(` DENY\\+DEFER avail=5 state=critical waited=\\d+ marker=${h.files[0]} model=sonnet type=general-purpose iso= session=${SHORT} cwd=/Users/demo/proj$`));
});

test('hook → Keeper: nothing is typed while memory is not ok or the chat is busy; then exactly one nudge and the marker is gone', { skip: SKIP_HOOK }, async () => {
  const h = await deniedHook();
  const marker = parseDeferredMarker(fs.readFileSync(path.join(h.deferDir, h.files[0]), 'utf8'));
  assert.ok(marker);
  const w = world();
  const file = deliverMarker(w, h);

  for (const level of ['critical', 'closed', 'warn', 'unknown'] as MemLevel[]) {
    w.mem = level;
    const snap = await w.tick(30_000);
    assert.deepEqual(w.nudges, [], `typed into the chat at memory level ${level}`);
    assert.ok(fs.existsSync(file), `marker consumed at memory level ${level}`);
    assert.deepEqual(
      snap.deferred.map((d) => ({ file: d.file, sessionId: d.sessionId, conversationId: d.conversationId, what: d.what, waitingFor: d.waitingFor })),
      [{ file, sessionId: SID, conversationId: 'a', what: 'spawn: probe', waitingFor: 'memory' }],
    );
    assert.equal(snap.items.find((i) => i.conversationId === 'a')?.status, 'waiting-memory');
  }

  // Memory is back, but the chat is mid-turn: typing now would land in the middle of its work.
  w.mem = 'ok';
  w.rows = [liveRow({ status: 'busy' })];
  let snap = await w.tick(30_000);
  assert.deepEqual(w.nudges, []);
  assert.ok(fs.existsSync(file));
  assert.equal(snap.deferred[0]?.waitingFor, 'idle-chat');

  w.rows = [liveRow()];
  snap = await w.tick(30_000);
  const expected = memoryFreeText('spawn: probe', hhmm(Date.parse(marker.at)));
  assert.deepEqual(w.nudges, [{ id: 'a', text: expected }]);
  assert.match(expected, /^Memory is free again — retry the step that was deferred at \d\d:\d\d \(spawn: probe\)\.$/);
  assert.equal(fs.existsSync(file), false, 'the marker file must be consumed by the nudge');
  assert.deepEqual(fs.readdirSync(w.deferredDir), []);
  assert.deepEqual(snap.deferred, []);
  assert.equal(w.convs.get('a')?.keeper?.lastNudgeReason, 'memory-deferred');
  assert.equal(snap.recent[0]?.cause, 'memory-deferred');

  // Told once: no second message, even after the cooldown has passed.
  await w.tick(NUDGE_COOLDOWN_MS + 60_000);
  await w.tick(30_000);
  assert.equal(w.nudges.length, 1);
  assert.deepEqual(w.relaunches, []);
});

test('hook → Keeper: two refusals in one chat are told in one message, and both markers are consumed', { skip: SKIP_HOOK }, async () => {
  const first = await deniedHook();
  // A second refusal, a real one, at least a millisecond later (its file name is its epoch ms).
  const second = await runHook({ availGB: 5, payload: hookPayload({ description: 'spawn: reviewer' }) });
  assert.equal(second.files.length, 1);
  assert.notEqual(second.files[0], first.files[0]);

  const w = world({ startAt: Date.now() + 2_000 });
  deliverMarker(w, first);
  deliverMarker(w, second);
  assert.equal(listDeferredMarkers(w.deferredDir, w.now).length, 2);

  await w.tick();
  assert.equal(w.nudges.length, 1);
  assert.match(w.nudges[0].text, /^Memory is free again — retry the step that was deferred at \d\d:\d\d \(spawn: probe, and 1 more\)\.$/);
  assert.deepEqual(fs.readdirSync(w.deferredDir), []);
});

test('hook → Keeper: a marker belongs to its own chat only — another chat is never told, and the marker waits', { skip: SKIP_HOOK }, async () => {
  const h = await deniedHook();
  const other = 'bbbb2222-0000-4000-8000-000000000002';
  const w = world({ convs: [conv({ id: 'b', sessionId: other, daemonShort: other.slice(0, 8), title: 'Chat B' })] });
  w.rows = [liveRow({ sessionId: other })];
  const file = deliverMarker(w, h);

  const snap = await w.tick(30_000);
  assert.deepEqual(w.nudges, []);
  assert.ok(fs.existsSync(file), 'an unclaimed marker is kept (until its TTL), not consumed');
  assert.deepEqual(snap.deferred.map((d) => [d.sessionId, d.conversationId]), [[SID, null]]);
});

test('hook → Keeper: a payload with no session id leaves a `nosess-` marker nobody can be told about — the reader drops it', { skip: SKIP_HOOK }, async () => {
  const h = await runHook({ availGB: 5, payload: hookPayload({ session_id: undefined }) });
  assert.equal(h.files.length, 1, `files in the deferred dir: ${h.files.join(', ')}`);
  assert.match(h.files[0], /^nosess-\d{13}\.json$/);
  const raw = fs.readFileSync(path.join(h.deferDir, h.files[0]), 'utf8');
  assert.equal((JSON.parse(raw) as { sessionId: unknown }).sessionId, '');
  // The two sides differ here on purpose: the hook always leaves a note, the
  // Keeper only keeps notes it can deliver.
  assert.equal(parseDeferredMarker(raw), null);

  const w = world();
  const file = deliverMarker(w, h);
  await w.tick();
  assert.deepEqual(w.nudges, []);
  assert.ok(fs.existsSync(file), 'younger than the half-written grace: left alone for now');
  // Past the grace (by the file's own mtime) it is rubbish and is removed.
  w.now = fs.statSync(file).mtimeMs + 11_000;
  const snap = await w.tick();
  assert.deepEqual(w.nudges, []);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(snap.deferred, []);
});

// ===========================================================================
// Seam 2 — launchd memguard → kill log → Keeper
// ===========================================================================

test('memguard → kill log: every line the real script writes (dry tick) is accepted by the guard\'s parser, field for field', { skip: SKIP_MEMGUARD }, async () => {
  const m = await memguardDry();
  assert.equal(m.code, 0, `memguard tick failed: ${m.stderr}`);
  assert.equal(m.stdout + m.stderr, '', 'a tick prints nothing');
  const log = fs.readFileSync(m.log, 'utf8');
  assert.match(log, / WOULD-KILL family=vitest .* mode=dry-run /);
  assert.doesNotMatch(log, /^\S+ \S+ KILL /m, 'a dry tick must never log a real KILL');
  assert.equal(m.lines.length, 3, `kill-log lines: ${m.lines.join(' | ')}`);

  const parsed = m.lines.map((l) => parseKillLogLine(l));
  for (const [i, e] of parsed.entries()) {
    assert.ok(e, `parseKillLogLine rejected the memguard's own line: ${m.lines[i]}`);
    // Nothing dropped on the way in: every key the script wrote survives the parser.
    assert.deepEqual(e, JSON.parse(m.lines[i]), `the parser lost or changed a field of: ${m.lines[i]}`);
    assert.equal(e.by, 'memguard-system');
    assert.equal(e.kind, 'process-group');
    assert.equal(e.dry, true);
    assert.equal(e.name, e.family);
    assert.equal(typeof e.pgid, 'number');
    assert.match(e.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(e.reason, 'memory critical (avail 3.0, comp 0.0)');
  }
  assert.deepEqual(parsed.map((e) => e?.family), ['vitest', 'tsc', 'playwright']);

  const read = readKillLogSince(0, m.killLog);
  assert.deepEqual(read.entries, parsed);
  assert.equal(read.offset, fs.statSync(m.killLog).size);
  assert.deepEqual(readKillLogSince(read.offset, m.killLog), { entries: [], offset: read.offset });
});

test('memguard → Keeper: WOULD-KILL lines (dry:true) never reach a chat; the same lines with dry:false produce exactly one nudge', { skip: SKIP_MEMGUARD }, async () => {
  const m = await memguardDry();
  assert.equal(m.lines.length, 3);
  // The fixture's process groups are long dead, so the script could name no
  // claude ancestor. Here they ran under this chat's claude process.
  const dryLines = m.lines.map((l) => edited(l, { claudePid: CLAUDE_PID }));
  const liveLines = dryLines.map((l) => edited(l, { dry: false }));

  // Control: attributable, fresh, idle chat, memory ok — the only reason not to tell it is `dry`.
  let w = world();
  writeLines(w.killLog, dryLines);
  const entries = readKillLogSince(0, w.killLog).entries;
  assert.equal(entries.length, 3);
  assert.equal(attributeKill(entries[0], w.deps.getConversations(), w.rows)?.id, 'a');
  await w.tick();
  await w.tick(30_000);
  assert.deepEqual(w.nudges, [], 'a dry-run entry was reported to the chat as a real stop');
  assert.deepEqual(w.killReads[0], { from: 0, to: fs.statSync(w.killLog).size, entries: 3 });

  w = world();
  writeLines(w.killLog, liveLines);
  const snap = await w.tick();
  const at = hhmm(Date.parse((JSON.parse(m.lines[0]) as { at: string }).at));
  assert.deepEqual(w.nudges, [{
    id: 'a',
    text: `Your vitest run was stopped at ${at} to protect the machine's memory — rerun it. `
      + `Your tsc run was stopped at ${at} to protect the machine's memory — rerun it. `
      + `Your playwright run was stopped at ${at} to protect the machine's memory — rerun it.`,
  }]);
  assert.equal(w.convs.get('a')?.keeper?.lastNudgeReason, 'killed-workload');
  assert.equal(snap.recent[0]?.cause, 'killed-workload');

  // All three were consumed by that one message.
  await w.tick(NUDGE_COOLDOWN_MS + 60_000);
  assert.equal(w.nudges.length, 1);
});

test('memguard → Keeper: a kill is attributed through claudePid to the chat that owns that process, not to a chat in the same folder', { skip: SKIP_MEMGUARD }, async () => {
  const m = await memguardDry();
  const otherSid = 'bbbb2222-0000-4000-8000-000000000002';
  // Chat B is newer and sits in the folder the kill names — the directory rule alone would pick it.
  const a = conv();
  const b = conv({ id: 'b', sessionId: otherSid, daemonShort: otherSid.slice(0, 8), title: 'Chat B', createdAt: new Date().toISOString() });
  const w = world({ convs: [a, b] });
  w.rows = [liveRow(), liveRow({ pid: 5151, sessionId: otherSid })];
  writeLines(w.killLog, [edited(m.lines[0], { dry: false, claudePid: CLAUDE_PID, cwd: '/Users/demo/proj' })]);

  await w.tick();
  assert.deepEqual(w.nudges.map((n) => n.id), ['a']);
  assert.match(w.nudges[0].text, /^Your vitest run was stopped at \d\d:\d\d to protect the machine's memory — rerun it\.$/);
  await w.tick(NUDGE_COOLDOWN_MS + 60_000);
  assert.equal(w.nudges.length, 1, 'chat B was never told');
});

test('kill log → Keeper: a log that shrank is a replay — what a chat was already told is not said again; later entries still are', { skip: SKIP_MEMGUARD }, async () => {
  const m = await memguardDry();
  const live = m.lines.map((l) => edited(l, { dry: false, claudePid: CLAUDE_PID }));
  const w = world();
  writeLines(w.killLog, live);
  const fullSize = fs.statSync(w.killLog).size;

  await w.tick();
  assert.equal(w.nudges.length, 1);
  const toldAt = w.now;

  // Rotated/truncated: the log now holds only its first line again.
  writeLines(w.killLog, [live[0]]);
  const smallSize = fs.statSync(w.killLog).size;
  assert.ok(smallSize < fullSize);
  await w.tick(NUDGE_COOLDOWN_MS + 60_000);
  assert.deepEqual(w.killReads.at(-1), { from: fullSize, to: smallSize, entries: 1 }, 'the reader restarted from the top and handed the old entry back');
  assert.equal(w.nudges.length, 1, 'a replayed kill was announced a second time');

  // A new stop appended after the shrink is read from the new offset and told.
  fs.appendFileSync(w.killLog, edited(live[1], { at: isoSeconds(toldAt + 7 * 60_000), name: 'tsc', family: 'tsc' }) + '\n');
  await w.tick(NUDGE_COOLDOWN_MS + 60_000);
  assert.equal(w.killReads.at(-1)?.from, smallSize);
  assert.equal(w.nudges.length, 2);
  assert.match(w.nudges[1].text, /^Your tsc run was stopped at \d\d:\d\d to protect the machine's memory — rerun it\.$/);
  const toldAgainAt = w.now;

  // A rotation that already carries a newer stop: the replay filter is by time, so the new one gets through.
  writeLines(w.killLog, [edited(live[2], { at: isoSeconds(toldAgainAt + 60_000) })]);
  assert.ok(fs.statSync(w.killLog).size < w.killReads.at(-1)!.to);
  await w.tick(NUDGE_COOLDOWN_MS + 60_000);
  assert.equal(w.nudges.length, 3);
  assert.match(w.nudges[2].text, /^Your playwright run was stopped at /);
  await w.tick(NUDGE_COOLDOWN_MS + 60_000);
  assert.equal(w.nudges.length, 3);
});

// ===========================================================================
// Seam 3 — memory guard ↔ Keeper
// ===========================================================================

test('guard → Keeper: the guard\'s own level gates the deferred retry — nothing at critical or while it settles, one nudge at ok', { skip: SKIP_HOOK }, async () => {
  const h = await deniedHook();
  const start = Date.now() + 2_000;
  const g = guardHarness(start);
  const w = world({ startAt: start });
  w.mem = getMemLevel;                       // main.ts: memLevel: () => guard.getMemLevel()
  const file = deliverMarker(w, h);
  const both = async (advanceMs: number): Promise<MemLevel> => {
    const level = await g.tick(advanceMs);
    w.now = g.state.now;
    await w.tick();
    return level;
  };

  const seen: MemLevel[] = [await both(0)];
  g.state.pressure = '4\n';
  for (let i = 0; i < 4 && seen.at(-1) !== 'critical'; i++) seen.push(await both(GUARD_TICK_MS));
  assert.equal(seen.at(-1), 'critical', `levels: ${seen.join(' → ')}`);
  assert.equal(w.nudges.length, 0, `nudged on the way up (${seen.join(' → ')})`);
  assert.equal(getKeeperSnapshot().deferred[0]?.waitingFor, 'memory');
  assert.equal(getKeeperSnapshot().items[0]?.status, 'waiting-memory');

  g.state.pressure = '1\n';
  const down: MemLevel[] = [];
  for (let i = 0; i < 6 && down.at(-1) !== 'ok'; i++) {
    const sent: number = w.nudges.length;
    const level = await both(GUARD_TICK_MS);
    down.push(level);
    if (level !== 'ok') {
      assert.equal(w.nudges.length, sent, `nudged while the guard still read ${level}`);
      assert.ok(fs.existsSync(file));
    }
  }
  assert.equal(down.at(-1), 'ok', `levels on the way down: ${down.join(' → ')}`);
  assert.ok(down.length >= 2, `leaving critical is confirmed over more than one tick (${down.join(' → ')})`);
  assert.equal(w.nudges.length, 1);
  assert.match(w.nudges.at(0)?.text ?? '', /^Memory is free again — retry the step that was deferred at \d\d:\d\d \(spawn: probe\)\.$/);
  assert.equal(fs.existsSync(file), false);
});

test('guard → hook → Keeper: while the guard holds admission closed the real hook refuses even with free memory; the guard reopening lets it through', { skip: SKIP_HOOK }, async () => {
  const start = Date.now() + 2_000;
  const g = guardHarness(start);
  await g.tick();
  g.state.pressure = '4\n';
  await g.tick(GUARD_TICK_MS);
  assert.equal(await g.tick(GUARD_TICK_MS), 'critical');
  assert.ok(fs.existsSync(g.admission), 'the guard writes the admission-closed file at critical');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(g.admission, 'utf8')) as object).sort(), ['level', 'reason', 'since', 'writtenAt']);

  // 60 GB "free" by the hook's own reading: only the guard's file is in the way.
  const closed = await runHook({ availGB: 60, closedFile: g.admission });
  assert.equal(closed.code, 0);
  assert.equal((JSON.parse(closed.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(closed.files.length, 1);
  const marker = parseDeferredMarker(fs.readFileSync(path.join(closed.deferDir, closed.files[0]), 'utf8'));
  assert.ok(marker);
  assert.equal(marker.state, 'ok');
  assert.equal(marker.reason, 'admission closed by the Peers Flow memory guard (state ok)');

  // The Keeper holds that retry for as long as the guard says so…
  const w = world({ startAt: start });
  w.mem = getMemLevel;
  deliverMarker(w, closed);
  w.now = g.state.now;
  await w.tick();
  assert.equal(w.nudges.length, 0);

  // …and the guard reopening is what releases both sides.
  g.state.pressure = '1\n';
  let level: MemLevel = 'critical';
  for (let i = 0; i < 6 && level !== 'ok'; i++) level = await g.tick(GUARD_TICK_MS);
  assert.equal(level, 'ok');
  assert.equal(fs.existsSync(g.admission), false, 'the guard removes the file once the level is ok');
  const open = await runHook({ availGB: 60, closedFile: g.admission });
  assert.equal(open.stdout, '', 'an allowed spawn prints nothing');
  assert.deepEqual(open.files, []);
  assert.match(fs.readFileSync(open.log, 'utf8'), / ALLOW avail=60 state=ok /);

  w.now = g.state.now;
  await w.tick();
  assert.equal(w.nudges.length, 1);
  assert.match(w.nudges.at(0)?.text ?? '', /^Memory is free again — retry the step that was deferred at /);
});

test('guard → Keeper: a container entry written by the guard\'s appendKillLog tells the chat which container and how to start it', async () => {
  const w = world({ convs: [conv({ directoryPath: '/Users/demo/shop' })] });
  w.rows = [liveRow({ cwd: '/Users/demo/shop' })];
  const stoppedAt = w.now - 60_000;
  const entry: KillLogEntry = {
    at: new Date(stoppedAt).toISOString(), by: 'peersflow-guard', kind: 'container', name: 'postgres-arrow', dry: false,
    reason: 'memory critical — idle 3h00m, project shop', projectDir: '/Users/demo/shop/infra',
  };
  appendKillLog({ ...entry, name: 'redis-dry', dry: true }, w.killLog);
  appendKillLog(entry, w.killLog);
  assert.deepEqual(readKillLogSince(0, w.killLog).entries.map((e) => [e.name, e.dry, e.projectDir]), [['redis-dry', true, '/Users/demo/shop/infra'], ['postgres-arrow', false, '/Users/demo/shop/infra']]);

  await w.tick();
  assert.deepEqual(w.nudges, [{
    id: 'a',
    text: `The container postgres-arrow was stopped at ${hhmm(stoppedAt)} to free memory — run \`docker start postgres-arrow\` and retry.`,
  }]);
  assert.doesNotMatch(w.nudges[0].text, /redis-dry/);
  await w.tick(NUDGE_COOLDOWN_MS + 60_000);
  assert.equal(w.nudges.length, 1);
});

test('guard (dry-run, end to end) → Keeper: WOULD-STOP entries name a project folder the Keeper can match to a chat, and the chat is told nothing', async () => {
  const g = guardHarness(GUARD_T0);
  await driveToCritical(g);
  assert.equal(getGuardSnapshot().mode, 'dry-run');
  assert.deepEqual(g.stops(), [], 'dry-run must never run docker stop');
  const entries = g.entries();
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.dry === true && e.by === 'peersflow-guard' && e.kind === 'container' && !!e.projectDir), JSON.stringify(entries));

  // The chat that would own it: not running when the guard looked, back (and idle) afterwards.
  const dir = entries[0].projectDir!;
  const w = world({ convs: [conv({ directoryPath: dir })], startAt: g.state.now });
  w.rows = [liveRow({ cwd: dir })];
  w.killLog = g.killLog;
  const read = readKillLogSince(0, g.killLog);
  assert.deepEqual(read.entries, entries, 'the Keeper\'s reader sees exactly what the guard appended');
  assert.equal(attributeKill(read.entries[0], w.deps.getConversations(), w.rows)?.id, 'a');

  await w.tick(30_000);
  await w.tick(30_000);
  assert.deepEqual(w.nudges, [], 'a WOULD-STOP was reported to the chat as a real stop');
});

test('guard (live, recorded exec) → Keeper: a real stop reaches the chat of that project once it is back, naming `docker start <name>`', async () => {
  const g = guardHarness(GUARD_T0);
  writePinsLive(g);
  await driveToCritical(g);
  const entries = g.entries();
  assert.deepEqual(g.stops(), entries.map((e) => ['docker', 'stop', e.name]));
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.dry === false && !!e.projectDir));

  const dir = entries[0].projectDir!;
  const mine = entries.filter((e) => e.projectDir === dir || e.projectDir!.startsWith(dir + '/'));
  const w = world({ convs: [conv({ directoryPath: dir })], startAt: g.state.now });
  w.rows = [liveRow({ cwd: dir })];
  w.killLog = g.killLog;

  await w.tick(30_000);
  assert.equal(w.nudges.length, 1);
  const texts: string[] = [];
  for (const e of mine) {
    const t = killedText(e, hhmm(Date.parse(e.at)));
    if (!texts.includes(t)) texts.push(t);
    assert.ok(w.nudges[0].text.includes(`The container ${e.name} was stopped at ${hhmm(g.state.now)} to free memory — run \`docker start ${e.name}\` and retry.`), w.nudges[0].text);
  }
  assert.equal(w.nudges[0].text, texts.join(' '));
  await w.tick(NUDGE_COOLDOWN_MS + 60_000);
  assert.equal(w.nudges.length, 1);
});

test('guard ↔ Keeper: a chat that is live in a project never gets a container nudge for it — the guard keeps that project\'s containers', async () => {
  // Who would be stopped with nobody around…
  let g = guardHarness(GUARD_T0);
  writePinsLive(g);
  await driveToCritical(g);
  const dir = g.entries()[0].projectDir!;

  // …and the same morning with a chat running in that folder.
  g = guardHarness(GUARD_T0);
  writePinsLive(g);
  g.state.liveRows = [liveRow({ cwd: dir, startedAt: GUARD_T0 })];
  await driveToCritical(g);
  for (let i = 0; i < 6; i++) await g.tick(GUARD_TICK_MS);
  const entries = g.entries();
  assert.ok(entries.length > 0, 'the guard still acted on other projects');
  assert.deepEqual(entries.filter((e) => e.projectDir === dir), [], 'a container of the live chat\'s project was stopped');

  // Nothing in the log is a stop the chat should be told about.
  const w = world({ convs: [conv({ directoryPath: dir })], startAt: g.state.now });
  w.rows = [liveRow({ cwd: dir })];
  w.killLog = g.killLog;
  const convs = w.deps.getConversations();
  for (const e of entries) {
    if (attributeKill(e, convs, w.rows)) {
      // Only a project nested inside this chat's folder could match; the guard protects those too.
      assert.fail(`the guard stopped ${e.name} (${e.projectDir}) although the chat in ${dir} would be told about it`);
    }
  }
  await w.tick(30_000);
  assert.deepEqual(w.nudges, []);
});
