import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSqliteCli, sqlLit, SQLITE3_BIN } from './sqlite-cli';

describe('sqlLit', () => {
  it('quotes strings and doubles single quotes', () => {
    assert.equal(sqlLit("it's"), "'it''s'");
    assert.equal(sqlLit(''), "''");
  });
  it('renders null, booleans and finite numbers', () => {
    assert.equal(sqlLit(null), 'NULL');
    assert.equal(sqlLit(true), '1');
    assert.equal(sqlLit(false), '0');
    assert.equal(sqlLit(42), '42');
    assert.equal(sqlLit(-1.5), '-1.5');
  });
  it('throws on NUL and non-finite numbers', () => {
    assert.throws(() => sqlLit('a\0b'));
    assert.throws(() => sqlLit(NaN));
    assert.throws(() => sqlLit(Infinity));
  });
});

describe('createSqliteCli', () => {
  let dir = '';
  let dbPath = '';
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-db-'));
    dbPath = path.join(dir, 't.sqlite');
    await createSqliteCli({ dbPath }).exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL); PRAGMA journal_mode=WAL;");
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('uses the system sqlite3 by default', () => {
    assert.equal(SQLITE3_BIN, '/usr/bin/sqlite3');
  });

  it('query returns [] for an empty result', async () => {
    const cli = createSqliteCli({ dbPath });
    assert.deepEqual(await cli.query('SELECT * FROM t'), []);
  });

  it('reads a cleanly closed WAL database (no -shm) without writing to it', async () => {
    const fresh = path.join(dir, 'fresh.sqlite');
    const cli = createSqliteCli({ dbPath: fresh });
    await cli.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); PRAGMA journal_mode=WAL;');
    assert.equal(fs.existsSync(`${fresh}-shm`), false);
    assert.deepEqual(await cli.query('SELECT count(*) AS n FROM t'), [{ n: 0 }]);
    await assert.rejects(cli.query("INSERT INTO t (id, v) VALUES (8, 'x')"), /readonly/);
    assert.deepEqual(await cli.query('SELECT count(*) AS n FROM t'), [{ n: 0 }]);
  });

  it('exec writes and query reads JSON rows', async () => {
    const cli = createSqliteCli({ dbPath });
    await cli.exec(`BEGIN IMMEDIATE; INSERT INTO t (id, v) VALUES (1, ${sqlLit("it's")}); COMMIT;`);
    assert.deepEqual(await cli.query('SELECT id, v FROM t'), [{ id: 1, v: "it's" }]);
  });

  it('query is read-only', async () => {
    const cli = createSqliteCli({ dbPath });
    await assert.rejects(cli.query("INSERT INTO t (id, v) VALUES (9, 'x')"));
    assert.deepEqual(await cli.query('SELECT id FROM t WHERE id = 9'), []);
  });

  it('a bad statement inside BEGIN IMMEDIATE rejects and rolls back', async () => {
    const cli = createSqliteCli({ dbPath });
    const beforeRows = await cli.query('SELECT id, v FROM t ORDER BY id');
    await assert.rejects(
      cli.exec("BEGIN IMMEDIATE; INSERT INTO t (id, v) VALUES (2, 'ok'); INSERT INTO t (id, v) VALUES (3, NULL); COMMIT;"),
      /NOT NULL|exit/,
    );
    assert.deepEqual(await cli.query('SELECT id, v FROM t ORDER BY id'), beforeRows);
  });

  it('query rejects with stderr on a syntax error', async () => {
    await assert.rejects(createSqliteCli({ dbPath }).query('SELEC nope'), /sqlite3 query failed/);
  });
});
