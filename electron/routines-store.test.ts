import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRoutinesStore } from './routines-store';
import type { Routine, RoutineRun } from '../shared/routines';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 9, 10, 12, 0).getTime();

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routines-store-')), 'routines.json');
}

const routine = (id: string, extra: Partial<Routine> = {}): Routine => ({
  id, name: `R ${id}`, directoryId: 'dir-1', provider: 'claude', prompt: '/do-it',
  schedule: { cadence: 'daily', time: '09:00' }, icon: 'star', enabled: true,
  createdAt: new Date(T0 - 10 * DAY).toISOString(), updatedAt: new Date(T0 - 10 * DAY).toISOString(), ...extra,
});

const run = (id: string, routineId: string, slotMs: number, extra: Partial<RoutineRun> = {}): RoutineRun => ({
  id, routineId, slotAt: new Date(slotMs).toISOString(), trigger: 'schedule', status: 'success',
  startedAt: new Date(slotMs).toISOString(), endedAt: new Date(slotMs + 60_000).toISOString(), ...extra,
});

describe('routines store', () => {
  it('round-trips routines and runs through the file', () => {
    const file = tmpFile();
    const a = createRoutinesStore(file, { now: () => T0 });
    a.addRoutine(routine('r1', { model: 'opus', seedKey: 'seed-1', enabledAt: new Date(T0 - DAY).toISOString() }));
    a.upsertRun(run('u1', 'r1', T0 - DAY, { conversationId: 'c1', summary: 'ok' }));
    a.flushSync();
    const b = createRoutinesStore(file, { now: () => T0 });
    assert.deepEqual(b.listRoutines(), a.listRoutines());
    assert.deepEqual(b.listRuns(), a.listRuns());
    assert.equal(b.findRun('r1', new Date(T0 - DAY).toISOString())?.id, 'u1');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.version, 1);
  });

  it('writes atomically: no temp file left behind, file always parses', () => {
    const file = tmpFile();
    const s = createRoutinesStore(file, { now: () => T0 });
    s.addRoutine(routine('r1'));
    s.flushSync();
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['routines.json']);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
  });

  it('debounces writes and still lands them', async () => {
    const file = tmpFile();
    const s = createRoutinesStore(file, { now: () => T0 });
    s.addRoutine(routine('r1'));
    s.addRoutine(routine('r2'));
    assert.equal(fs.existsSync(file), false, 'nothing written synchronously');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).routines.length, 2);
  });

  it('sanitizes on load: drops unknown cadence, bad runs and orphan runs; fixes fields', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      routines: [
        routine('ok', { icon: 'nope' as any, provider: 'weird' as any }),
        routine('future', { schedule: { cadence: 'hourly' as any, time: '09:00' } }),
        routine('nodir', { directoryId: '', enabled: true }),
        { name: 'no id' },
      ],
      runs: [
        run('good', 'ok', T0 - DAY),
        run('badstatus', 'ok', T0 - 2 * DAY, { status: 'exploded' as any }),
        run('orphan', 'gone', T0 - DAY),
        { id: 'noslot', routineId: 'ok' },
      ],
    }));
    const s = createRoutinesStore(file, { now: () => T0 });
    assert.deepEqual(s.listRoutines().map((r) => r.id), ['ok', 'nodir']);
    assert.equal(s.getRoutine('ok')?.icon, 'star');
    assert.equal(s.getRoutine('ok')?.provider, 'claude');
    assert.equal(s.getRoutine('nodir')?.enabled, false, 'a peer-less routine can never be enabled');
    assert.deepEqual(s.listRuns().map((r) => r.id), ['good']);
  });

  it('survives a corrupt file by starting empty', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{not json');
    const origError = console.error;
    console.error = () => {};
    try {
      const s = createRoutinesStore(file, { now: () => T0 });
      assert.deepEqual(s.listRoutines(), []);
    } finally { console.error = origError; }
  });

  it('updateRoutine stamps updatedAt, and enabledAt only on a false→true flip', () => {
    let now = T0;
    const s = createRoutinesStore(tmpFile(), { now: () => now });
    s.addRoutine(routine('r1', { enabled: false }));
    now = T0 + 1000;
    const renamed = s.updateRoutine('r1', { name: 'New' })!;
    assert.equal(renamed.updatedAt, new Date(now).toISOString());
    assert.equal(renamed.enabledAt, undefined);
    now = T0 + 2000;
    const on = s.updateRoutine('r1', { enabled: true })!;
    assert.equal(on.enabledAt, new Date(now).toISOString());
    now = T0 + 3000;
    const again = s.updateRoutine('r1', { enabled: true })!;
    assert.equal(again.enabledAt, new Date(T0 + 2000).toISOString(), 'true→true keeps the old enabledAt');
    assert.equal(s.updateRoutine('missing', { name: 'x' }), null);
  });

  it('removeRoutine deletes its runs and only its runs', () => {
    const s = createRoutinesStore(tmpFile(), { now: () => T0 });
    s.addRoutine(routine('r1'));
    s.addRoutine(routine('r2'));
    s.upsertRun(run('a', 'r1', T0 - DAY));
    s.upsertRun(run('b', 'r2', T0 - DAY));
    s.removeRoutine('r1');
    assert.equal(s.getRoutine('r1'), null);
    assert.deepEqual(s.listRuns().map((r) => r.id), ['b']);
    assert.equal(s.findRun('r1', new Date(T0 - DAY).toISOString()), null);
  });

  it('listRuns filters by routine and since, ascending by slot; upsert replaces by id', () => {
    const s = createRoutinesStore(tmpFile(), { now: () => T0 });
    s.addRoutine(routine('r1'));
    s.upsertRun(run('late', 'r1', T0 - DAY));
    s.upsertRun(run('early', 'r1', T0 - 3 * DAY));
    s.upsertRun(run('other', 'r2', T0 - 2 * DAY));
    assert.deepEqual(s.listRuns().map((r) => r.id), ['early', 'other', 'late']);
    assert.deepEqual(s.listRuns({ routineId: 'r1' }).map((r) => r.id), ['early', 'late']);
    assert.deepEqual(s.listRuns({ sinceMs: T0 - 2 * DAY }).map((r) => r.id), ['other', 'late']);
    s.upsertRun({ ...s.getRun('late')!, status: 'failed' });
    assert.equal(s.getRun('late')?.status, 'failed');
    assert.equal(s.findRun('r1', new Date(T0 - DAY).toISOString())?.status, 'failed');
  });

  it('snapshot keeps runs inside RUNS_SNAPSHOT_DAYS plus every non-ended run', () => {
    const s = createRoutinesStore(tmpFile(), { now: () => T0 });
    s.addRoutine(routine('r1'));
    s.upsertRun(run('recent', 'r1', T0 - 10 * DAY));
    s.upsertRun(run('old', 'r1', T0 - 130 * DAY));
    s.upsertRun(run('oldLive', 'r1', T0 - 140 * DAY, { status: 'running', endedAt: undefined }));
    const snap = s.snapshot(T0);
    assert.deepEqual(snap.runs.map((r) => r.id).sort(), ['oldLive', 'recent']);
    assert.equal(snap.now, new Date(T0).toISOString());
    assert.equal(snap.routines.length, 1);
  });

  it('prunes ended runs past RUNS_RETENTION_DAYS on load, keeps live ones', () => {
    const file = tmpFile();
    const a = createRoutinesStore(file, { now: () => T0 - 200 * DAY });
    a.addRoutine(routine('r1'));
    a.upsertRun(run('ancient', 'r1', T0 - 190 * DAY));
    a.upsertRun(run('ancientLive', 'r1', T0 - 191 * DAY, { status: 'running', endedAt: undefined }));
    a.upsertRun(run('fresh', 'r1', T0 - 5 * DAY));
    a.flushSync();
    const b = createRoutinesStore(file, { now: () => T0 });
    assert.deepEqual(b.listRuns().map((r) => r.id).sort(), ['ancientLive', 'fresh']);
  });

  it('prunes again once a day while running', () => {
    let now = T0;
    const s = createRoutinesStore(tmpFile(), { now: () => now });
    s.addRoutine(routine('r1'));
    s.upsertRun(run('aging', 'r1', T0 - 179 * DAY));
    assert.ok(s.getRun('aging'));
    now = T0 + 2 * DAY;
    s.upsertRun(run('new', 'r1', now));
    assert.equal(s.getRun('aging'), null);
    assert.ok(s.getRun('new'));
  });

  it('removing a seeded routine leaves a tombstone that survives a reload', () => {
    const file = tmpFile();
    const a = createRoutinesStore(file, { now: () => T0 });
    a.addRoutine(routine('seeded', { seedKey: 'reddit-daily' }));
    a.addRoutine(routine('plain'));
    assert.equal(a.isSeedDeleted('reddit-daily'), false);
    a.removeRoutine('plain');
    a.removeRoutine('seeded');
    assert.equal(a.isSeedDeleted('reddit-daily'), true);
    a.flushSync();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).deletedSeedKeys, ['reddit-daily']);
    const b = createRoutinesStore(file, { now: () => T0 });
    assert.equal(b.isSeedDeleted('reddit-daily'), true);
    assert.equal(b.isSeedDeleted('other'), false);
  });

  it('reads a file without deletedSeedKeys and ignores junk entries in it', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ version: 1, routines: [], runs: [] }));
    assert.equal(createRoutinesStore(file, { now: () => T0 }).isSeedDeleted('reddit-daily'), false);
    fs.writeFileSync(file, JSON.stringify({ version: 1, routines: [], runs: [], deletedSeedKeys: [42, '', null, 'reddit-daily'] }));
    const s = createRoutinesStore(file, { now: () => T0 });
    assert.equal(s.isSeedDeleted('reddit-daily'), true);
    s.flushSync();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).deletedSeedKeys, ['reddit-daily']);
  });
});
