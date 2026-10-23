// Wispr's flow.sqlite as the learner sees it. The write surface is deliberately tiny:
// INSERT OR IGNORE new Dictionary rows, and UPDATE isDeleted/modifiedAt on existing
// ones. Never DELETE, never DDL — Wispr syncs Dictionary to its cloud and treats a
// soft delete (isDeleted=1 + a newer modifiedAt) as the delete, so a hard delete
// would just be resurrected by the next sync.
//
// The real History table has 63 columns and ~21k rows including audio BLOBs, so
// every query names its columns; never SELECT * from History.

import * as fs from 'fs';
import * as path from 'path';
import { createSqliteCli, sqlLit } from './sqlite-cli';
import type { SqliteCli } from './sqlite-cli';
import { DICTIONARY_COLUMNS, evaluateSchema } from './wispr-schema';
import type { PragmaColumn } from './wispr-schema';
import { normalizeWord, tokenize } from './text';
import { TEAM_DICTIONARY_DEFAULT } from './types';
import type { Dictation, DictionaryRow, NewDictionaryRow, SchemaCheck, WisprDb } from './types';

export function defaultWisprDbPath(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'Wispr Flow', 'flow.sqlite');
}

/** Wispr's own datetime text, e.g. '2026-10-22 08:12:56.682 +00:00'. */
export function wisprNow(d: Date | number): string {
  return new Date(d).toISOString().replace('T', ' ').replace('Z', ' +00:00');
}

/** Inverse of wisprNow; tolerates other offsets. NaN when unparseable. */
export function parseWisprTimestamp(s: string): number {
  if (typeof s !== 'string') return NaN;
  const iso = s.trim().replace(' ', 'T').replace(' +', '+').replace(' -', '-');
  return Date.parse(iso);
}

/** Exactly the row shape Wispr's own auto-learn writes (source 'user_edits', used once). */
export function newDictionaryRow(r: NewDictionaryRow): Record<string, string | number | null> {
  return {
    id: r.id,
    phrase: r.phrase,
    teamDictionaryId: TEAM_DICTIONARY_DEFAULT,
    replacement: null,
    replacementHtml: null,
    lastUsed: r.now,
    frequencyUsed: 1,
    remoteFrequencyUsed: 0,
    manualEntry: 0,
    createdAt: r.now,
    modifiedAt: r.now,
    isDeleted: 0,
    source: 'user_edits',
    observedSource: r.observedSource,
    isSnippet: 0,
    isStarred: 0,
  };
}

const inList = (values: string[]): string => values.map(sqlLit).join(', ');

export function insertSql(rows: NewDictionaryRow[]): string {
  const cols = DICTIONARY_COLUMNS.join(', ');
  const lines = rows.map((r) => {
    const row = newDictionaryRow(r);
    return `INSERT OR IGNORE INTO Dictionary (${cols}) VALUES (${DICTIONARY_COLUMNS.map((c) => sqlLit(row[c] ?? null)).join(', ')});`;
  });
  return ['BEGIN IMMEDIATE;', ...lines, 'COMMIT;'].join('\n');
}

export function softDeleteSql(ids: string[], modifiedAt: string): string {
  return [
    'BEGIN IMMEDIATE;',
    `UPDATE Dictionary SET isDeleted = 1, modifiedAt = ${sqlLit(modifiedAt)} WHERE id IN (${inList(ids)}) AND isDeleted = 0;`,
    'COMMIT;',
  ].join('\n');
}

interface RawDictionaryRow {
  id: string; phrase: string; replacement: string | null; observedSource: string | null; source: string | null;
  manualEntry: number; isDeleted: number; frequencyUsed: number; createdAt: string; modifiedAt: string;
}

export function createWisprDb(opts: { dbPath: string; readOnly?: boolean; cli?: SqliteCli }): WisprDb {
  const { dbPath } = opts;
  const readOnly = opts.readOnly ?? false;
  const cli = opts.cli ?? createSqliteCli({ dbPath });

  const exists = (): boolean => fs.existsSync(dbPath);
  const requireDb = (): void => { if (!exists()) throw new Error(`db-missing: ${dbPath}`); };
  const requireWritable = (): void => { if (readOnly) throw new Error('read-only'); };

  const readAll = async (): Promise<Record<string, unknown>[]> =>
    cli.query(`SELECT * FROM Dictionary ORDER BY createdAt ASC, id ASC`);

  return {
    dbPath,
    readOnly,
    exists,

    async checkSchema(): Promise<SchemaCheck> {
      requireDb();
      const dict = await cli.query<PragmaColumn>(`PRAGMA table_info('Dictionary')`);
      const hist = await cli.query<PragmaColumn>(`PRAGMA table_info('History')`);
      return evaluateSchema(dict, hist);
    },

    async readDictionary(): Promise<DictionaryRow[]> {
      requireDb();
      const rows = await cli.query<RawDictionaryRow>(
        'SELECT id, phrase, replacement, observedSource, source, manualEntry, isDeleted, frequencyUsed, createdAt, modifiedAt ' +
        'FROM Dictionary ORDER BY createdAt ASC, id ASC',
      );
      return rows.map((r) => ({
        id: r.id,
        phrase: r.phrase,
        replacement: r.replacement ?? null,
        observedSource: r.observedSource ?? null,
        source: r.source ?? null,
        manualEntry: Number(r.manualEntry) === 1,
        isDeleted: Number(r.isDeleted) === 1,
        frequencyUsed: Number(r.frequencyUsed) || 0,
        createdAt: r.createdAt,
        modifiedAt: r.modifiedAt,
      }));
    },

    async readDictations({ apps, afterTimestamp, throughTimestamp, limit }): Promise<Dictation[]> {
      requireDb();
      if (apps.length === 0) return [];
      const n = Math.max(0, Math.floor(limit));
      // Timestamps compare as text: Wispr writes one fixed-width UTC format, so string order = time order.
      const rows = await cli.query<{ id: string; timestamp: string; app: string; formattedText: string; asrText: string | null }>(
        'SELECT transcriptEntityId AS id, timestamp, app, formattedText, asrText FROM History ' +
        `WHERE app IN (${inList([...apps])}) AND formattedText IS NOT NULL AND isArchived = 0 ` +
        `AND timestamp > ${sqlLit(afterTimestamp)} AND timestamp <= ${sqlLit(throughTimestamp)} ` +
        `ORDER BY timestamp ASC LIMIT ${sqlLit(n)}`,
      );
      return rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        at: parseWisprTimestamp(r.timestamp),
        app: r.app,
        formattedText: r.formattedText,
        asrText: r.asrText ?? null,
      }));
    },

    async readOutputWordCounts(sinceTimestamp: string): Promise<Record<string, number>> {
      requireDb();
      // One text column over ~90 days is a couple of MB of JSON — well inside the CLI's buffer.
      const rows = await cli.query<{ t: string }>(
        `SELECT formattedText AS t FROM History WHERE formattedText IS NOT NULL AND timestamp > ${sqlLit(sinceTimestamp)}`,
      );
      const counts = new Map<string, number>();
      for (const r of rows) {
        if (typeof r.t !== 'string') continue;
        for (const tok of tokenize(r.t)) {
          const k = normalizeWord(tok);
          if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
      return Object.fromEntries(counts);
    },

    async insertDictionaryRows(rows: NewDictionaryRow[]): Promise<{ inserted: string[] }> {
      requireWritable();
      requireDb();
      if (rows.length === 0) return { inserted: [] };
      await cli.exec(insertSql(rows));
      // OR IGNORE swallows a duplicate phrase silently; what is there afterwards is the truth.
      const present = await cli.query<{ id: string }>(`SELECT id FROM Dictionary WHERE id IN (${inList(rows.map((r) => r.id))})`);
      const ids = new Set(present.map((p) => p.id));
      return { inserted: rows.map((r) => r.id).filter((id) => ids.has(id)) };
    },

    async softDelete(ids: string[], modifiedAt: string): Promise<{ updated: number }> {
      requireWritable();
      requireDb();
      if (ids.length === 0) return { updated: 0 };
      // changes() still reports the UPDATE after COMMIT. Counting rows afterwards would
      // also count ones a previous call already deleted with the same modifiedAt.
      const out = await cli.exec(`${softDeleteSql(ids, modifiedAt)}\nSELECT changes();`);
      const lines = out.trim().split('\n');
      const n = Number(lines[lines.length - 1]);
      return { updated: Number.isFinite(n) ? n : 0 };
    },

    async exportDictionary(toFile: string): Promise<number> {
      requireDb();
      const rows = await readAll();
      fs.mkdirSync(path.dirname(toFile), { recursive: true });
      const tmp = `${toFile}.tmp-${process.pid}-${Date.now()}`;
      await fs.promises.writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8');
      await fs.promises.rename(tmp, toFile);
      return rows.length;
    },
  };
}
