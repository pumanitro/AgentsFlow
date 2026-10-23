import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSqliteCli, sqlLit } from './sqlite-cli';
import type { SqliteCli } from './sqlite-cli';
import { DICTIONARY_DDL, HISTORY_DDL_FOR_TESTS, evaluateSchema } from './wispr-schema';
import type { PragmaColumn } from './wispr-schema';
import {
  createWisprDb, defaultWisprDbPath, insertSql, newDictionaryRow, parseWisprTimestamp, softDeleteSql, wisprNow,
} from './wispr-db';
import { PEERS_FLOW_BUNDLE_IDS, TEAM_DICTIONARY_DEFAULT } from './types';

const NOW = '2026-10-22 08:12:56.682 +00:00';

let dir = '';
let dbPath = '';
let cli: SqliteCli;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-db-'));
  dbPath = path.join(dir, 'flow.sqlite');
  cli = createSqliteCli({ dbPath });
  await cli.exec(DICTIONARY_DDL + HISTORY_DDL_FOR_TESTS + 'PRAGMA journal_mode=WAL;');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('timestamps and paths', () => {
  it('wisprNow / parseWisprTimestamp round-trip Wispr text', () => {
    const ms = parseWisprTimestamp(NOW);
    assert.equal(ms, Date.UTC(2026, 9, 22, 8, 12, 56, 682));
    assert.equal(wisprNow(ms), NOW);
    assert.equal(wisprNow(new Date(ms)), NOW);
  });
  it('parses other offsets and is NaN-safe', () => {
    assert.equal(parseWisprTimestamp('2026-10-22 10:12:56.682 +02:00'), Date.UTC(2026, 9, 22, 8, 12, 56, 682));
    assert.equal(parseWisprTimestamp('2026-10-22 03:12:56.682 -05:00'), Date.UTC(2026, 9, 22, 8, 12, 56, 682));
    assert.ok(Number.isNaN(parseWisprTimestamp('garbage')));
  });
  it('default path is under Application Support/Wispr Flow', () => {
    assert.equal(defaultWisprDbPath('/h'), path.join('/h', 'Library', 'Application Support', 'Wispr Flow', 'flow.sqlite'));
  });
});

describe('SQL builders', () => {
  it('newDictionaryRow is Wispr\'s auto-learn shape', () => {
    assert.deepEqual(newDictionaryRow({ id: 'a', phrase: 'Peers Flow', observedSource: 'peers flow', now: NOW }), {
      id: 'a', phrase: 'Peers Flow', teamDictionaryId: TEAM_DICTIONARY_DEFAULT, replacement: null, replacementHtml: null,
      lastUsed: NOW, frequencyUsed: 1, remoteFrequencyUsed: 0, manualEntry: 0, createdAt: NOW, modifiedAt: NOW,
      isDeleted: 0, source: 'user_edits', observedSource: 'peers flow', isSnippet: 0, isStarred: 0,
    });
  });
  it('insertSql / softDeleteSql wrap in one IMMEDIATE transaction', () => {
    const ins = insertSql([{ id: 'a', phrase: "it's", observedSource: null, now: NOW }]);
    assert.match(ins, /^BEGIN IMMEDIATE;\nINSERT OR IGNORE INTO Dictionary \(id, phrase,.*'it''s'.*\);\nCOMMIT;$/s);
    assert.equal(
      softDeleteSql(['a', 'b'], NOW),
      `BEGIN IMMEDIATE;\nUPDATE Dictionary SET isDeleted = 1, modifiedAt = '${NOW}' WHERE id IN ('a', 'b') AND isDeleted = 0;\nCOMMIT;`,
    );
    assert.doesNotMatch(ins + softDeleteSql(['a'], NOW), /\b(DELETE|DROP|ALTER|CREATE)\b/);
  });
});

describe('createWisprDb', () => {
  it('inserts rows in Wispr\'s shape; a duplicate phrase is ignored, not an error', async () => {
    const db = createWisprDb({ dbPath, cli });
    const r1 = await db.insertDictionaryRows([
      { id: 'id-1', phrase: 'Peers Flow', observedSource: 'peers flow', now: NOW },
      { id: 'id-2', phrase: 'Wispr', observedSource: null, now: NOW },
    ]);
    assert.deepEqual(r1.inserted, ['id-1', 'id-2']);
    const rows = await db.readDictionary();
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.source, 'user_edits');
      assert.equal(r.frequencyUsed, 1);
      assert.equal(r.manualEntry, false);
      assert.equal(r.isDeleted, false);
      assert.equal(r.createdAt, NOW);
      assert.equal(r.modifiedAt, NOW);
    }
    assert.equal(rows.find((r) => r.id === 'id-1')?.observedSource, 'peers flow');

    const r2 = await db.insertDictionaryRows([
      { id: 'id-3', phrase: 'Peers Flow', observedSource: 'x', now: NOW },
      { id: 'id-4', phrase: 'Fable', observedSource: null, now: NOW },
    ]);
    assert.deepEqual(r2.inserted, ['id-4']);
    assert.equal((await db.readDictionary()).length, 3);
  });

  it('empty insert returns [] without spawning', async () => {
    let calls = 0;
    const spy: SqliteCli = { dbPath, query: async () => { calls++; return []; }, exec: async () => { calls++; return ''; } };
    assert.deepEqual(await createWisprDb({ dbPath, cli: spy }).insertDictionaryRows([]), { inserted: [] });
    assert.equal(calls, 0);
  });

  it('softDelete flips isDeleted, stamps modifiedAt, and is idempotent', async () => {
    const db = createWisprDb({ dbPath, cli });
    await db.insertDictionaryRows([{ id: 'id-1', phrase: 'glue123', observedSource: null, now: NOW }]);
    const later = wisprNow(parseWisprTimestamp(NOW) + 60_000);
    assert.deepEqual(await db.softDelete(['id-1', 'nope'], later), { updated: 1 });
    const [row] = await db.readDictionary();
    assert.equal(row.isDeleted, true);
    assert.equal(row.modifiedAt, later);
    assert.deepEqual(await db.softDelete(['id-1'], later), { updated: 0 });
    assert.equal((await db.readDictionary()).length, 1);  // soft, never a DELETE
  });

  it('readDictations honours apps, after, through and limit', async () => {
    const ts = (m: number) => wisprNow(Date.UTC(2026, 9, 22, 8, m));
    const hist = [
      ['h1', ts(1), PEERS_FLOW_BUNDLE_IDS[0], 'one', 0],
      ['h2', ts(2), PEERS_FLOW_BUNDLE_IDS[1], 'two', 0],
      ['h3', ts(3), 'com.apple.Safari', 'other app', 0],
      ['h4', ts(4), PEERS_FLOW_BUNDLE_IDS[0], 'archived', 1],
      ['h5', ts(5), PEERS_FLOW_BUNDLE_IDS[0], null, 0],
      ['h6', ts(6), PEERS_FLOW_BUNDLE_IDS[0], 'six', 0],
      ['h7', ts(7), PEERS_FLOW_BUNDLE_IDS[0], 'seven', 0],
    ] as const;
    await cli.exec(
      'BEGIN IMMEDIATE;\n' +
      hist.map(([id, t, app, text, arch]) =>
        `INSERT INTO History (transcriptEntityId, timestamp, app, formattedText, asrText, isArchived) VALUES (${sqlLit(id)}, ${sqlLit(t)}, ${sqlLit(app)}, ${sqlLit(text)}, 'asr', ${arch});`,
      ).join('\n') + '\nCOMMIT;',
    );
    const db = createWisprDb({ dbPath, readOnly: true, cli });
    const got = await db.readDictations({ apps: PEERS_FLOW_BUNDLE_IDS, afterTimestamp: ts(1), throughTimestamp: ts(6), limit: 10 });
    assert.deepEqual(got.map((d) => d.id), ['h2', 'h6']);
    assert.equal(got[0].at, Date.UTC(2026, 9, 22, 8, 2));
    assert.equal(got[0].timestamp, ts(2));
    assert.equal(got[0].asrText, 'asr');
    const limited = await db.readDictations({ apps: PEERS_FLOW_BUNDLE_IDS, afterTimestamp: '', throughTimestamp: ts(9), limit: 2 });
    assert.deepEqual(limited.map((d) => d.id), ['h1', 'h2']);
  });

  it('readOutputWordCounts counts normalized words in every app\'s output after the timestamp', async () => {
    const ts = (m: number) => wisprNow(Date.UTC(2026, 9, 22, 8, m));
    const hist = [
      ['h1', ts(1), 'Too old żeby'],
      ['h2', ts(2), 'Żeby to działało, to cron.'],
      ['h3', ts(3), null],
      ['h4', ts(4), 'run constructor to'],
    ] as const;
    await cli.exec(
      'BEGIN IMMEDIATE;\n' +
      hist.map(([id, t, text], i) =>
        `INSERT INTO History (transcriptEntityId, timestamp, app, formattedText, asrText, isArchived) VALUES (${sqlLit(id)}, ${sqlLit(t)}, ${sqlLit(i % 2 ? 'com.apple.Safari' : PEERS_FLOW_BUNDLE_IDS[0])}, ${sqlLit(text)}, 'asr', 0);`,
      ).join('\n') + '\nCOMMIT;',
    );
    const db = createWisprDb({ dbPath, readOnly: true, cli });
    const counts = await db.readOutputWordCounts(ts(1));
    assert.deepEqual({ ...counts }, { żeby: 1, to: 3, działało: 1, cron: 1, run: 1, constructor: 1 });
    assert.ok(Object.hasOwn(counts, 'constructor'));
    assert.deepEqual(await db.readOutputWordCounts(ts(9)), {});
  });

  it('exportDictionary writes every row (deleted included) atomically', async () => {
    const db = createWisprDb({ dbPath, cli });
    await db.insertDictionaryRows([
      { id: 'a', phrase: 'A', observedSource: null, now: NOW },
      { id: 'b', phrase: 'B', observedSource: null, now: NOW },
    ]);
    await db.softDelete(['b'], NOW);
    const out = path.join(dir, 'backup', 'dict.json');
    assert.equal(await db.exportDictionary(out), 2);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(parsed.length, 2);
    assert.deepEqual(fs.readdirSync(path.dirname(out)), ['dict.json']);
  });

  it('a read-only adapter rejects writes before spawning sqlite3', async () => {
    let calls = 0;
    const spy: SqliteCli = { dbPath, query: async () => { calls++; return []; }, exec: async () => { calls++; return ''; } };
    const db = createWisprDb({ dbPath, readOnly: true, cli: spy });
    assert.equal(db.readOnly, true);
    await assert.rejects(db.insertDictionaryRows([{ id: 'x', phrase: 'x', observedSource: null, now: NOW }]), /^Error: read-only$/);
    await assert.rejects(db.softDelete(['x'], NOW), /^Error: read-only$/);
    assert.equal(calls, 0);
  });

  it('checkSchema is ok on the real DDL', async () => {
    const check = await createWisprDb({ dbPath, readOnly: true, cli }).checkSchema();
    assert.equal(check.ok, true, check.detail);
    assert.deepEqual(check.missing, []);
    assert.deepEqual(check.unexpected, []);
  });

  it('every method but exists rejects with db-missing when the file is absent', async () => {
    const missing = path.join(dir, 'nope.sqlite');
    const db = createWisprDb({ dbPath: missing });
    assert.equal(db.exists(), false);
    const re = new RegExp(`^Error: db-missing: ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    await assert.rejects(db.checkSchema(), re);
    await assert.rejects(db.readDictionary(), re);
    await assert.rejects(db.readDictations({ apps: ['a'], afterTimestamp: '', throughTimestamp: NOW, limit: 1 }), re);
    await assert.rejects(db.readOutputWordCounts(''), re);
    await assert.rejects(db.insertDictionaryRows([]), re);
    await assert.rejects(db.softDelete([], NOW), re);
    await assert.rejects(db.exportDictionary(path.join(dir, 'x.json')), re);
    assert.equal(fs.existsSync(missing), false);
  });
});

describe('evaluateSchema', () => {
  const pragma = async (table: string) => cli.query<PragmaColumn>(`PRAGMA table_info('${table}')`);

  it('reports a dropped column as missing', async () => {
    const dict = (await pragma('Dictionary')).filter((c) => c.name !== 'observedSource');
    const check = evaluateSchema(dict, await pragma('History'));
    assert.equal(check.ok, false);
    assert.deepEqual(check.missing, ['Dictionary.observedSource']);
  });

  it('an extra nullable column is fine; an extra NOT NULL no-default column is not', async () => {
    const dict = await pragma('Dictionary');
    const hist = await pragma('History');
    const extra = (notnull: number, dflt: string | null): PragmaColumn =>
      ({ cid: 99, name: 'newCol', type: 'TEXT', notnull, dflt_value: dflt, pk: 0 });
    const optional = evaluateSchema([...dict, extra(0, null)], hist);
    assert.equal(optional.ok, true);
    assert.deepEqual(optional.unexpected, ['newCol']);
    assert.equal(evaluateSchema([...dict, extra(1, "'x'")], hist).ok, true);
    const blocking = evaluateSchema([...dict, extra(1, null)], hist);
    assert.equal(blocking.ok, false);
    assert.deepEqual(blocking.unexpected, ['newCol']);
    assert.match(blocking.detail, /newCol/);
  });

  it('a missing History column fails', async () => {
    const hist = (await pragma('History')).filter((c) => c.name !== 'isArchived');
    assert.deepEqual(evaluateSchema(await pragma('Dictionary'), hist).missing, ['History.isArchived']);
  });
});
