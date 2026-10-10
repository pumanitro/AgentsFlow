import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRoutinesStore } from './routines-store';
import { SEED_ROUTINES, ensureSeedRoutines } from './routines-seed';
import type { TrackedDirectory } from '../shared/types';

const NOW = new Date(2026, 9, 10, 14, 0).toISOString();
const store = () => createRoutinesStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routines-seed-')), 'routines.json'));
const dir = (id: string, p: string, displayName = path.posix.basename(p), extra: Partial<TrackedDirectory> = {}): TrackedDirectory =>
  ({ id, path: p, displayName, addedAt: NOW, ...extra });

describe('ensureSeedRoutines', () => {
  it('ships exactly the Reddit daily seed', () => {
    assert.deepEqual(SEED_ROUTINES.map((s) => [s.seedKey, s.name, s.peerBasename, s.prompt, s.schedule.cadence, s.schedule.time]),
      [['reddit-daily', 'Reddit daily', 'atlas-of-doors', '/reddit-daily-routine', 'daily', '09:00']]);
  });

  it('matches the peer by path basename and creates it enabled, createdAt = enabledAt = now', () => {
    const s = store();
    const res = ensureSeedRoutines(s, [dir('a', '/srv/other'), dir('b', '/srv/code/atlas-of-doors')], NOW);
    assert.equal(res.created.length, 1);
    const r = s.listRoutines()[0];
    assert.equal(r.directoryId, 'b');
    assert.equal(r.enabled, true);
    assert.equal(r.createdAt, NOW);
    assert.equal(r.enabledAt, NOW);
    assert.equal(r.seedKey, 'reddit-daily');
    assert.equal(r.icon, 'reddit');
    assert.equal(r.provider, 'claude');
  });

  it('matches by displayName, case-insensitively, remote peers included', () => {
    const s = store();
    ensureSeedRoutines(s, [dir('r', '/home/x/game', 'Atlas-Of-Doors', { remote: { host: 'h', user: 'u', sshArgs: [], claudeBin: 'claude' } as any })], NOW);
    assert.equal(s.listRoutines()[0].directoryId, 'r');
  });

  it('a trailing slash on the path still matches', () => {
    const s = store();
    ensureSeedRoutines(s, [dir('t', '/srv/atlas-of-doors/', 'whatever')], NOW);
    assert.equal(s.listRoutines()[0].directoryId, 't');
  });

  it('no tracked peer → created disabled with directoryId empty', () => {
    const s = store();
    const res = ensureSeedRoutines(s, [dir('a', '/srv/other')], NOW);
    const r = res.created[0];
    assert.equal(r.directoryId, '');
    assert.equal(r.enabled, false);
    assert.equal(r.enabledAt, undefined);
  });

  it('is idempotent on seedKey and never re-points or re-enables an existing seed', () => {
    const s = store();
    ensureSeedRoutines(s, [], NOW);
    const first = s.listRoutines()[0];
    const res = ensureSeedRoutines(s, [dir('b', '/srv/atlas-of-doors')], NOW);
    assert.deepEqual(res, { created: [], skipped: ['reddit-daily'] });
    assert.equal(s.listRoutines().length, 1);
    assert.equal(s.listRoutines()[0].directoryId, '');
    assert.equal(s.listRoutines()[0].enabled, false);
    s.updateRoutine(first.id, { enabled: false });
    assert.equal(ensureSeedRoutines(s, [dir('b', '/srv/atlas-of-doors')], NOW).created.length, 0);
  });

  it('survives a reload: the seed persisted, not re-created', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routines-seed-')), 'routines.json');
    const a = createRoutinesStore(file);
    ensureSeedRoutines(a, [dir('b', '/srv/atlas-of-doors')], NOW);
    a.flushSync();
    const b = createRoutinesStore(file);
    assert.equal(ensureSeedRoutines(b, [dir('b', '/srv/atlas-of-doors')], NOW).created.length, 0);
    assert.equal(b.listRoutines().length, 1);
  });

  it('does not bring back a seed the owner deleted, across a relaunch', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routines-seed-')), 'routines.json');
    const a = createRoutinesStore(file);
    const [seed] = ensureSeedRoutines(a, [dir('b', '/srv/atlas-of-doors')], NOW).created;
    a.removeRoutine(seed.id);
    assert.deepEqual(ensureSeedRoutines(a, [dir('b', '/srv/atlas-of-doors')], NOW), { created: [], skipped: ['reddit-daily'] });
    a.flushSync();
    const b = createRoutinesStore(file);
    assert.deepEqual(ensureSeedRoutines(b, [dir('b', '/srv/atlas-of-doors')], NOW), { created: [], skipped: ['reddit-daily'] });
    assert.equal(b.listRoutines().length, 0);
  });

  it('a renamed or paused seed is still a seed, not a deletion', () => {
    const s = store();
    const [seed] = ensureSeedRoutines(s, [dir('b', '/srv/atlas-of-doors')], NOW).created;
    s.updateRoutine(seed.id, { name: 'Reddit morning', enabled: false });
    assert.equal(s.isSeedDeleted('reddit-daily'), false);
    assert.equal(ensureSeedRoutines(s, [dir('b', '/srv/atlas-of-doors')], NOW).created.length, 0);
    assert.equal(s.listRoutines().length, 1);
  });
});
