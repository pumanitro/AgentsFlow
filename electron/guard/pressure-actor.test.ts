import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { GuardContainerRow, GuardPins } from '../../shared/types';
import type { Exec } from './docker-inventory';
import { MAX_STOPS_PER_TICK, NOTICE_MS, applyActions, planActions } from './pressure-actor';
import type { GuardAction } from './pressure-actor';

const NOW = Date.parse('2026-10-11T09:41:00Z');
const PINS: GuardPins = { version: 1, keep: [], mode: 'dry-run', idleMinutes: 120 };

function row(name: string, over: Partial<GuardContainerRow> = {}): GuardContainerRow {
  return {
    name, project: 'vitaminology', projectDir: '/Users/iij/IdeaProjects/nutrable/develop/.cache', autoRemove: false, pinned: false, running: true,
    cpuPct: 0, memMB: 300, publishedPorts: [], establishedConns: 0, lastActiveAt: null, idleMinutes: 133,
    verdict: 'stop-candidate', note: 'idle 2h13m, project vitaminology', ...over,
  };
}

/** Records every call; fails the test on anything but `docker stop <name>`. */
function recordingExec(result: string | null = 'ok'): { exec: Exec; calls: Array<{ cmd: string; args: string[]; timeoutMs: number }> } {
  const calls: Array<{ cmd: string; args: string[]; timeoutMs: number }> = [];
  return { calls, exec: async (cmd, args, timeoutMs) => { calls.push({ cmd, args, timeoutMs }); return result; } };
}
function silence<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
  return fn().then((value) => ({ value, lines })).finally(() => { console.log = log; console.warn = warn; });
}

test('plan: nothing unless the level is critical', () => {
  const rows = [row('a'), row('b'), row('redis', { project: null, projectDir: null })];
  for (const level of ['ok', 'warn', 'closed', 'unknown'] as const) {
    assert.deepEqual(planActions(level, rows, PINS, NOW), [], level);
  }
});

test('plan: critical — a stop candidate with a known project is stopped, reason carries the use note', () => {
  assert.deepEqual(planActions('critical', [row('customer-ui')], PINS, NOW), [
    { kind: 'stop', name: 'customer-ui', projectDir: '/Users/iij/IdeaProjects/nutrable/develop/.cache', reason: 'memory critical — idle 2h13m, project vitaminology' },
  ]);
});

test('plan: at most two stops a tick', () => {
  assert.equal(MAX_STOPS_PER_TICK, 2);
  const actions = planActions('critical', ['a', 'b', 'c', 'd', 'e'].map((n) => row(n)), PINS, NOW);
  assert.equal(actions.length, 2);
  assert.ok(actions.every((a) => a.kind === 'stop'));
});

test('plan: longest idle first — the order is about use, and a bigger container does not jump the queue', () => {
  const rows = [row('huge', { memMB: 9000, idleMinutes: 125 }), row('small', { memMB: 12, idleMinutes: 600 }), row('mid', { memMB: 500, idleMinutes: 300 })];
  assert.deepEqual(planActions('critical', rows, PINS, NOW).map((a) => a.name), ['small', 'mid']);
});

test('plan: never a pinned, auto-remove, live-chat, active, young or stopped row', () => {
  const rows: GuardContainerRow[] = [
    row('pinned', { verdict: 'keep-pinned', pinned: true }),
    row('rm', { verdict: 'keep-autoremove', autoRemove: true }),
    row('chat', { verdict: 'keep-live-chat' }),
    row('busy', { verdict: 'keep-active' }),
    row('new', { verdict: 'keep-young' }),
    row('gone', { verdict: 'stopped-by-guard', running: false }),
  ];
  assert.deepEqual(planActions('critical', rows, PINS, NOW), []);
});

test('plan: pinned never — even when the row still says stop-candidate (pin landed after the verdict)', () => {
  assert.deepEqual(planActions('critical', [row('a', { pinned: true })], PINS, NOW), []);
  assert.deepEqual(planActions('critical', [row('a')], { ...PINS, keep: ['a'] }, NOW), []);
  assert.deepEqual(planActions('critical', [row('a', { autoRemove: true })], PINS, NOW), []);
  assert.deepEqual(planActions('critical', [row('a', { running: false })], PINS, NOW), []);
});

test('plan: unknown project ⇒ a notice now, with the stop 60 s out — and no stop yet', () => {
  assert.equal(NOTICE_MS, 60_000);
  assert.deepEqual(planActions('critical', [row('redis', { project: null, projectDir: null })], PINS, NOW), [
    { kind: 'notice', name: 'redis', stoppingAt: NOW + 60_000 },
  ]);
});

test('plan: a project label with NO folder (supabase-shaped) is not "known" — notice first, never an immediate stop', () => {
  const supabase = row('supabase_db_shelly-monitor', { project: 'shelly-monitor', projectDir: null, note: 'idle 2h13m, project shelly-monitor (folder unknown)' });
  assert.deepEqual(planActions('critical', [supabase], PINS, NOW), [{ kind: 'notice', name: 'supabase_db_shelly-monitor', stoppingAt: NOW + 60_000 }]);
  // mixed with a real project: the one with a folder is stopped, the other only noticed
  const actions = planActions('critical', [supabase, row('customer-ui')], PINS, NOW);
  assert.deepEqual(actions.map((a) => `${a.kind}:${a.name}`).sort(), ['notice:supabase_db_shelly-monitor', 'stop:customer-ui']);
  // and once noticed it follows the same 60 s path as a container with no project at all
  const noticed = { ...supabase, verdict: 'stopping' as const, stoppingAt: new Date(NOW + 60_000).toISOString() };
  assert.deepEqual(planActions('critical', [noticed], PINS, NOW + 59_000), []);
  assert.equal(planActions('critical', [noticed], PINS, NOW + 60_000)[0].kind, 'stop');
});

test('plan: a noticed container waits out its 60 s, then is stopped if still critical', () => {
  const noticed = row('redis', { project: null, projectDir: null, verdict: 'stopping', stoppingAt: new Date(NOW + 60_000).toISOString(), note: 'idle 2h05m, no project' });
  assert.deepEqual(planActions('critical', [noticed], PINS, NOW + 30_000), []);
  assert.deepEqual(planActions('critical', [noticed], PINS, NOW + 60_000), [
    { kind: 'stop', name: 'redis', projectDir: null, reason: 'memory critical — idle 2h05m, no project' },
  ]);
});

test('plan: a notice is withdrawn when the level drops or the user pins it', () => {
  const noticed = row('redis', { project: null, projectDir: null, verdict: 'stopping', stoppingAt: new Date(NOW + 60_000).toISOString() });
  for (const level of ['ok', 'warn', 'closed', 'unknown'] as const) {
    assert.deepEqual(planActions(level, [noticed], PINS, NOW + 90_000), [{ kind: 'cancel-notice', name: 'redis' }], level);
  }
  assert.deepEqual(planActions('critical', [noticed], { ...PINS, keep: ['redis'] }, NOW + 90_000), [{ kind: 'cancel-notice', name: 'redis' }]);
  // a deadline that cannot be read is never a licence to stop
  assert.deepEqual(planActions('critical', [{ ...noticed, stoppingAt: undefined }], PINS, NOW + 90_000), [{ kind: 'cancel-notice', name: 'redis' }]);
});

test('plan: due notices share the two-stop budget with project candidates', () => {
  const due = (n: string) => row(n, { project: null, projectDir: null, verdict: 'stopping', stoppingAt: new Date(NOW - 1).toISOString(), idleMinutes: 500 });
  const actions = planActions('critical', [due('x'), due('y'), row('a'), row('b')], PINS, NOW);
  assert.deepEqual(actions.map((a) => `${a.kind}:${a.name}`), ['stop:x', 'stop:y']);
});

test('plan: pure — the same input gives the same plan and the rows are not touched', () => {
  const rows = [row('b'), row('a')];
  const copy = JSON.parse(JSON.stringify(rows));
  assert.deepEqual(planActions('critical', rows, PINS, NOW), planActions('critical', rows, PINS, NOW));
  assert.deepEqual(rows, copy);
});

const STOPS: GuardAction[] = [
  { kind: 'stop', name: 'customer-ui', projectDir: '/Users/iij/IdeaProjects/nutrable/develop/.cache', reason: 'memory critical — idle 2h13m, project vitaminology' },
  { kind: 'stop', name: 'redis', projectDir: null, reason: 'memory critical — idle 2h05m, no project' },
];

test('apply, DRY-RUN: exec is never called — no `docker stop`, no command at all', async () => {
  const { exec, calls } = recordingExec();
  const notes: string[] = [];
  const { value: entries, lines } = await silence(() => applyActions(
    [...STOPS, { kind: 'notice', name: 'pe-db', stoppingAt: NOW + 60_000 }, { kind: 'cancel-notice', name: 'old' }],
    { mode: 'dry-run', exec, notify: (t, b) => notes.push(`${t}|${b}`), now: NOW },
  ));
  assert.equal(calls.filter((c) => c.args[0] === 'stop').length, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(notes, []);                       // dry-run disturbs nobody
  assert.deepEqual(entries, [
    { at: '2026-10-11T09:41:00.000Z', by: 'peersflow-guard', kind: 'container', name: 'customer-ui', dry: true, reason: STOPS[0].kind === 'stop' ? STOPS[0].reason : '', projectDir: '/Users/iij/IdeaProjects/nutrable/develop/.cache' },
    { at: '2026-10-11T09:41:00.000Z', by: 'peersflow-guard', kind: 'container', name: 'redis', dry: true, reason: 'memory critical — idle 2h05m, no project' },
  ]);
  assert.equal(lines.filter((l) => l.startsWith('[agentsflow][guard] WOULD-STOP ')).length, 2);
  assert.ok(lines.includes('[agentsflow][guard] WOULD-STOP customer-ui (dry-run): memory critical — idle 2h13m, project vitaminology'));
});

test('apply, DRY-RUN is the meaning of every mode that is not exactly "live"', async () => {
  for (const mode of ['dry-run', 'LIVE', '', undefined, null, 'on']) {
    const { exec, calls } = recordingExec();
    const { value: entries } = await silence(() => applyActions(STOPS, { mode: mode as GuardPins['mode'], exec, notify: () => {}, now: NOW }));
    assert.deepEqual(calls, [], String(mode));
    assert.ok(entries.every((e) => e.dry === true), String(mode));
  }
});

test('apply, LIVE: exactly `docker stop <name>` per stop, 30 s timeout, entries dry:false', async () => {
  const { exec, calls } = recordingExec('customer-ui\n');
  const { value: entries, lines } = await silence(() => applyActions(STOPS, { mode: 'live', exec, notify: () => {}, now: NOW }));
  assert.deepEqual(calls, [
    { cmd: 'docker', args: ['stop', 'customer-ui'], timeoutMs: 30_000 },
    { cmd: 'docker', args: ['stop', 'redis'], timeoutMs: 30_000 },
  ]);
  assert.deepEqual(entries.map((e) => [e.name, e.dry, e.by, e.kind]), [['customer-ui', false, 'peersflow-guard', 'container'], ['redis', false, 'peersflow-guard', 'container']]);
  assert.equal(lines.filter((l) => l.includes('WOULD-STOP')).length, 0);
  assert.ok(lines.some((l) => l.includes('STOPPED customer-ui') && l.includes('docker start customer-ui')));
});

test('apply, LIVE: a stop that fails or times out leaves no kill-log entry', async () => {
  const { exec, calls } = recordingExec(null);
  const { value: entries } = await silence(() => applyActions(STOPS, { mode: 'live', exec, notify: () => {}, now: NOW }));
  assert.equal(calls.length, 2);
  assert.deepEqual(entries, []);
});

test('apply, LIVE: a notice sends the exact notification text and stops nothing', async () => {
  const { exec, calls } = recordingExec();
  const notes: Array<[string, string]> = [];
  const { value: entries } = await silence(() => applyActions([{ kind: 'notice', name: 'redis', stoppingAt: NOW + 60_000 }], { mode: 'live', exec, notify: (t, b) => notes.push([t, b]), now: NOW }));
  assert.deepEqual(notes, [['Memory guard', 'Memory critical — stopping container redis in 60 s. Pin it in Performance › Memory guard to keep it.']]);
  assert.deepEqual(calls, []);
  assert.deepEqual(entries, []);
});

test('apply: a throwing notify does not abort the pass; no actions is a no-op', async () => {
  const { exec, calls } = recordingExec('x');
  const { value: entries } = await silence(() => applyActions(
    [{ kind: 'notice', name: 'redis', stoppingAt: NOW + 60_000 }, STOPS[0]],
    { mode: 'live', exec, notify: () => { throw new Error('window gone'); }, now: NOW },
  ));
  assert.equal(entries.length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(await applyActions([], { mode: 'live', exec, notify: () => {}, now: NOW }), []);
});
