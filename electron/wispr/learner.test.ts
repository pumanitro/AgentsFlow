import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readAudit } from './audit';
import { cloneLedger } from './ledger';
import {
  INITIAL_BACKFILL_MS, SETTLE_MS, __resetForTests, getLearnerStatus, learnerDir, readConfig, runLearnerTick,
} from './learner';
import type { LearnerDeps } from './learner';
import { createSqliteCli, sqlLit } from './sqlite-cli';
import type { SqliteCli } from './sqlite-cli';
import { stopwordsFrom } from './stopwords';
import { PEERS_FLOW_BUNDLE_IDS } from './types';
import type { PlanInput, TickPlan, TruthSource, UserMessage, WisprDb } from './types';
import { createWisprDb, wisprNow } from './wispr-db';
import { DICTIONARY_DDL, HISTORY_DDL_FOR_TESTS } from './wispr-schema';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0, 0);

let dir = '';
let userData = '';
let dbPath = '';
let cli: SqliteCli;

async function makeDb(ddl = DICTIONARY_DDL): Promise<void> {
  cli = createSqliteCli({ dbPath });
  await cli.exec(ddl + HISTORY_DDL_FOR_TESTS);
}
async function addDictation(id: string, atMs: number, text = 'please open peers flow now'): Promise<void> {
  await cli.exec(
    'INSERT INTO History (transcriptEntityId, asrText, formattedText, timestamp, status, app, isArchived) VALUES ' +
    `(${sqlLit(id)}, ${sqlLit(text)}, ${sqlLit(text)}, ${sqlLit(wisprNow(atMs))}, 'formatted', ${sqlLit(PEERS_FLOW_BUNDLE_IDS[0])}, 0);`,
  );
}
async function addDictionaryRow(id: string, phrase: string): Promise<void> {
  const t = sqlLit(wisprNow(NOW - 86_400_000));
  await cli.exec(
    'INSERT INTO Dictionary (id, phrase, createdAt, modifiedAt, source, observedSource) VALUES ' +
    `(${sqlLit(id)}, ${sqlLit(phrase)}, ${t}, ${t}, 'user_edits', 'x');`,
  );
}

const truth: TruthSource = {
  name: 'claude',
  async readMessages(): Promise<UserMessage[]> {
    return [{ at: NOW - SETTLE_MS - 60_000, text: 'please open Peers Flow now', source: 'claude', sessionId: 's1' }];
  },
};

/** A planner stand-in: inserts the phrases it is given, soft-deletes the ids it is given. */
function cannedPlan(phrases: string[], deleteIds: string[] = [], calls: PlanInput[] = []): (input: PlanInput) => TickPlan {
  return (input) => {
    calls.push(input);
    const ledger = cloneLedger(input.ledger);
    if (input.dictations.length) ledger.cursor = input.dictations[input.dictations.length - 1].timestamp;
    ledger.lastJanitorAt = input.nowMs;
    const inserts = phrases.map((phrase) => ({
      phrase, observedSource: phrase.toLowerCase(), kind: 'correction' as const, key: phrase.toLowerCase(), evidence: 2, why: 'test',
    }));
    for (const i of inserts) ledger.inserts.push({ at: input.nowMs, kind: i.kind, phrase: i.phrase, key: i.key, id: `id-${i.key.replace(/\W/g, '')}` });
    return {
      inserts,
      deletes: deleteIds.map((id) => ({ id, phrase: id, observedSource: 'x', rule: 'prefix-junk' })),
      rejected: [], skipped: [], paired: input.dictations.length, unpaired: 0, ledger,
    };
  };
}

function deps(over: Partial<LearnerDeps> = {}): LearnerDeps {
  return {
    userDataDir: userData,
    db: createWisprDb({ dbPath }),
    truth: [truth],
    knownNames: () => [],
    now: () => NOW,
    env: {},
    stopwords: async () => stopwordsFrom([], 'none'),
    plan: cannedPlan([]),
    ...over,
  };
}

function spyDb(db: WisprDb): { db: WisprDb; calls: string[] } {
  const calls: string[] = [];
  const wrapped = { ...db } as WisprDb;
  for (const k of ['checkSchema', 'readDictionary', 'readDictations', 'readOutputWordCounts', 'insertDictionaryRows', 'softDelete', 'exportDictionary'] as const) {
    const fn = db[k] as (...a: unknown[]) => unknown;
    (wrapped as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => { calls.push(k); return fn(...a); };
  }
  return { db: wrapped, calls };
}

const ldir = (): string => learnerDir(userData);
const backups = (): string[] => fs.readdirSync(ldir()).filter((f) => f.startsWith('dictionary-backup-'));

beforeEach(async () => {
  __resetForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-learner-'));
  userData = path.join(dir, 'userData');
  dbPath = path.join(dir, 'flow.sqlite');
  await makeDb();
});
afterEach(() => {
  __resetForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readConfig', () => {
  it('defaults, config.json overrides, env wins', () => {
    const d = path.join(dir, 'cfg');
    assert.deepEqual(readConfig(d, {}), { enabled: true, dryRun: false });
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ dryRun: false, enabled: true }));
    assert.deepEqual(readConfig(d, { PEERSFLOW_WISPR_LEARNER: 'dry' }), { enabled: true, dryRun: true });
    for (const v of ['0', 'off', 'false', 'OFF']) assert.equal(readConfig(d, { PEERSFLOW_WISPR_LEARNER: v }).enabled, false);
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ dryRun: true, enabled: false }));
    assert.deepEqual(readConfig(d, {}), { enabled: false, dryRun: true });
    fs.writeFileSync(path.join(d, 'config.json'), '{garbage');
    assert.deepEqual(readConfig(d, {}), { enabled: true, dryRun: false });
  });
});

describe('runLearnerTick — write mode', () => {
  it('backs up once, inserts in Wispr shape, soft-deletes, audits, saves the ledger', async () => {
    await addDictionaryRow('junk1', 'xxPeers');
    await addDictionaryRow('junk2', 'yyFlow');
    await addDictation('d1', NOW - SETTLE_MS - 120_000);
    const r1 = await runLearnerTick(deps({ plan: cannedPlan(['Peers Flow', 'Kebe'], ['junk1', 'junk2']) }));
    assert.equal(r1.skipped, undefined);
    assert.deepEqual(r1.errors, []);
    assert.deepEqual(r1.applied, { inserted: 2, softDeleted: 2 });
    assert.equal(backups().length, 1);
    const backup = JSON.parse(fs.readFileSync(path.join(ldir(), backups()[0]), 'utf8')) as unknown[];
    assert.equal(backup.length, 2);

    const rows = await cli.query<Record<string, unknown>>("SELECT * FROM Dictionary WHERE id = 'id-peersflow'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phrase, 'Peers Flow');
    assert.equal(rows[0].source, 'user_edits');
    assert.equal(rows[0].observedSource, 'peers flow');
    assert.equal(rows[0].createdAt, wisprNow(NOW));
    assert.equal(Number(rows[0].frequencyUsed), 1);
    const del = await cli.query<{ id: string; isDeleted: number; modifiedAt: string }>(
      "SELECT id, isDeleted, modifiedAt FROM Dictionary WHERE id IN ('junk1','junk2')");
    assert.deepEqual(del.map((d) => [d.isDeleted, d.modifiedAt]), [[1, wisprNow(NOW)], [1, wisprNow(NOW)]]);

    const ledger = JSON.parse(fs.readFileSync(path.join(ldir(), 'ledger.json'), 'utf8'));
    assert.equal(ledger.backupDoneAt, NOW);
    assert.equal(ledger.cursor, wisprNow(NOW - SETTLE_MS - 120_000));
    assert.equal(ledger.inserts.length, 2);

    // Second tick: new dictation, new insert — still exactly one backup file.
    await addDictation('d2', NOW - SETTLE_MS - 60_000);
    const r2 = await runLearnerTick(deps({ now: () => NOW + 1000, plan: cannedPlan(['Codex']) }));
    assert.deepEqual(r2.applied, { inserted: 1, softDeleted: 0 });
    assert.equal(backups().length, 1);

    const actions = readAudit(path.join(ldir(), 'audit.jsonl')).map((e) => e.action);
    assert.deepEqual(actions.filter((a) => a === 'backup'), ['backup']);
    assert.equal(actions.filter((a) => a === 'insert').length, 3);
    assert.equal(actions.filter((a) => a === 'soft-delete').length, 2);
    assert.ok(fs.existsSync(path.join(ldir(), 'learner.lock')));
  });

  it('reads settled dictations past the cursor and messages from before them', async () => {
    await addDictation('old', NOW - INITIAL_BACKFILL_MS - 60_000);
    await addDictation('ok', NOW - SETTLE_MS - 60_000);
    await addDictation('fresh', NOW - SETTLE_MS + 60_000);
    const calls: PlanInput[] = [];
    let range: [number, number] = [0, 0];
    const src: TruthSource = { name: 'codex', async readMessages(f, t) { range = [f, t]; return []; } };
    await runLearnerTick(deps({ truth: [src], plan: cannedPlan([], [], calls) }));
    assert.deepEqual(calls[0].dictations.map((d) => d.id), ['ok']);
    assert.equal(range[0], NOW - INITIAL_BACKFILL_MS - 5_000);
    assert.equal(range[1], NOW);
    assert.equal(calls[0].janitorDue, true);
    // Nothing new and janitor ran just now → no plan.
    const r = await runLearnerTick(deps({ plan: cannedPlan([], [], calls) }));
    assert.equal(r.skipped, 'no-new');
    assert.equal(calls.length, 1);
  });
});

describe('runLearnerTick — Wispr word counts and limits', () => {
  it('passes 90-day Wispr word counts to the plan, cached for a day', async () => {
    await addDictation('d1', NOW - SETTLE_MS - 60_000, 'żeby to było');
    await addDictation('ancient', NOW - 91 * 86_400_000, 'stare słowo');
    const spy = spyDb(createWisprDb({ dbPath }));
    const calls: PlanInput[] = [];
    await runLearnerTick(deps({ db: spy.db, plan: cannedPlan([], [], calls) }), { dryRun: true, persist: false });
    assert.deepEqual(calls[0].wisprCounts, { żeby: 1, to: 1, było: 1 });
    await runLearnerTick(deps({ db: spy.db, now: () => NOW + 3_600_000, plan: cannedPlan([], [], calls) }), { dryRun: true, persist: false, forceJanitor: true });
    await runLearnerTick(deps({ db: spy.db, now: () => NOW + 25 * 3_600_000, plan: cannedPlan([], [], calls) }), { dryRun: true, persist: false, forceJanitor: true });
    assert.equal(spy.calls.filter((c) => c === 'readOutputWordCounts').length, 2);
  });

  it('a failed count is an error entry and an empty map, not a failed tick', async () => {
    await addDictation('d1', NOW - SETTLE_MS - 60_000);
    const base = createWisprDb({ dbPath });
    const db: WisprDb = { ...base, readOutputWordCounts: async () => { throw new Error('locked'); } };
    const calls: PlanInput[] = [];
    const r = await runLearnerTick(deps({ db, plan: cannedPlan([], [], calls) }), { dryRun: true, persist: false });
    assert.deepEqual(calls[0].wisprCounts, {});
    assert.ok(r.plan);
    assert.deepEqual(r.errors, ['wispr word counts failed: locked']);
  });

  it('maxDictations raises the per-tick cap', async () => {
    for (let i = 0; i < 105; i++) await addDictation(`d${i}`, NOW - SETTLE_MS - (200 - i) * 1000);
    const calls: PlanInput[] = [];
    await runLearnerTick(deps({ plan: cannedPlan([], [], calls) }), { dryRun: true, persist: false });
    await runLearnerTick(deps({ plan: cannedPlan([], [], calls) }), { dryRun: true, persist: false, maxDictations: 5000 });
    assert.deepEqual(calls.map((c) => c.dictations.length), [100, 105]);
  });
});

describe('runLearnerTick — dry run', () => {
  it('leaves the DB alone, writes no ledger, audits would-* lines', async () => {
    await addDictionaryRow('junk1', 'xxPeers');
    await addDictation('d1', NOW - SETTLE_MS - 60_000);
    const r = await runLearnerTick(deps({ plan: cannedPlan(['Peers Flow'], ['junk1']) }), { dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.plan?.inserts.length, 1);
    assert.equal(r.applied, undefined);
    const rows = await cli.query<{ id: string; isDeleted: number }>('SELECT id, isDeleted FROM Dictionary');
    assert.deepEqual(rows, [{ id: 'junk1', isDeleted: 0 }]);
    assert.ok(!fs.existsSync(path.join(ldir(), 'ledger.json')));
    assert.equal(backups().length, 0);
    assert.deepEqual(readAudit(path.join(ldir(), 'audit.jsonl')).map((e) => [e.action, e.dryRun]),
      [['would-insert', true], ['would-soft-delete', true]]);
  });

  it('persist:false touches nothing on disk', async () => {
    await addDictation('d1', NOW - SETTLE_MS - 60_000);
    const r = await runLearnerTick(deps({ plan: cannedPlan(['Peers Flow']) }), { dryRun: true, persist: false, sinceMs: NOW - 48 * 3_600_000 });
    assert.equal(r.plan?.inserts.length, 1);
    assert.ok(!fs.existsSync(ldir()));
  });

  it('env "dry" beats config.json dryRun:false', async () => {
    fs.mkdirSync(ldir(), { recursive: true });
    fs.writeFileSync(path.join(ldir(), 'config.json'), JSON.stringify({ dryRun: false }));
    await addDictation('d1', NOW - SETTLE_MS - 60_000);
    const r = await runLearnerTick(deps({ env: { PEERSFLOW_WISPR_LEARNER: 'dry' }, plan: cannedPlan(['Peers Flow']) }));
    assert.equal(r.dryRun, true);
    assert.deepEqual(await cli.query('SELECT id FROM Dictionary'), []);
  });
});

describe('runLearnerTick — guards', () => {
  it('PEERSFLOW_WISPR_LEARNER=0 → disabled, no DB query', async () => {
    const spy = spyDb(createWisprDb({ dbPath }));
    const r = await runLearnerTick(deps({ db: spy.db, env: { PEERSFLOW_WISPR_LEARNER: '0' } }));
    assert.equal(r.skipped, 'disabled');
    await runLearnerTick(deps({ db: spy.db, env: { PEERSFLOW_WISPR_LEARNER: '0' } }));
    assert.deepEqual(spy.calls, []);
    assert.deepEqual(readAudit(path.join(ldir(), 'audit.jsonl')).map((e) => e.action), ['disabled']);
  });

  it('schema mismatch → schema, disabledReason, verdict cached', async () => {
    fs.rmSync(dbPath, { force: true });
    await makeDb(DICTIONARY_DDL.replace(', `observedSource` VARCHAR(255)', ''));
    const spy = spyDb(createWisprDb({ dbPath }));
    const r = await runLearnerTick(deps({ db: spy.db }));
    assert.equal(r.skipped, 'schema');
    assert.match(getLearnerStatus().disabledReason ?? '', /observedSource/);
    assert.equal(getLearnerStatus().enabled, false);
    const r2 = await runLearnerTick(deps({ db: spy.db }));
    assert.equal(r2.skipped, 'schema');
    assert.deepEqual(spy.calls, ['checkSchema']);
    assert.deepEqual(readAudit(path.join(ldir(), 'audit.jsonl')).map((e) => e.action), ['error']);
  });

  it('db missing → db-missing', async () => {
    const r = await runLearnerTick(deps({ db: createWisprDb({ dbPath: path.join(dir, 'nope.sqlite') }) }));
    assert.equal(r.skipped, 'db-missing');
  });

  it('a live other pid holds the lock → locked; a dead pid does not', async () => {
    await addDictation('d1', NOW - SETTLE_MS - 60_000);
    fs.mkdirSync(ldir(), { recursive: true });
    const lock = path.join(ldir(), 'learner.lock');
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, at: NOW - 60_000 }));
      assert.equal((await runLearnerTick(deps())).skipped, 'locked');
      // Same live pid but the lock is over an hour old → stale, taken over.
      fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, at: NOW - 2 * 3_600_000 }));
      assert.equal((await runLearnerTick(deps())).skipped, undefined);
    } finally {
      child.kill();
    }
    const dead = spawnSync('true').pid;
    fs.writeFileSync(lock, JSON.stringify({ pid: dead, at: NOW - 60_000 }));
    await addDictation('d2', NOW - SETTLE_MS - 30_000);
    const r = await runLearnerTick(deps({ now: () => NOW + 1 }));
    assert.equal(r.skipped, undefined);
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  });

  it('overlapping call → running', async () => {
    await addDictation('d1', NOW - SETTLE_MS - 60_000);
    const a = runLearnerTick(deps());
    const b = runLearnerTick(deps());
    assert.equal((await b).skipped, 'running');
    assert.equal((await a).skipped, undefined);
  });

  it('a failed insert is audited as error and dropped from the ledger', async () => {
    await addDictation('d1', NOW - SETTLE_MS - 60_000);
    const base = createWisprDb({ dbPath });
    const db: WisprDb = { ...base, insertDictionaryRows: async () => { throw new Error('boom'); } };
    const r = await runLearnerTick(deps({ db, plan: cannedPlan(['Peers Flow']) }));
    assert.equal(r.applied?.inserted, 0);
    assert.ok(r.errors.some((e) => /boom/.test(e)));
    const ledger = JSON.parse(fs.readFileSync(path.join(ldir(), 'ledger.json'), 'utf8'));
    assert.deepEqual(ledger.inserts, []);
    assert.deepEqual(readAudit(path.join(ldir(), 'audit.jsonl')).map((e) => e.action), ['backup', 'error']);
  });
});
