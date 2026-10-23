// The slice of Wispr's schema the learner depends on. Wispr ships schema migrations
// with app updates; when the shape drifts the learner disables itself rather than
// writing rows a newer Wispr may not understand (or that our INSERT can't satisfy).

import type { SchemaCheck } from './types';

export const DICTIONARY_COLUMNS: readonly string[] = [
  'id', 'phrase', 'replacement', 'teamDictionaryId', 'lastUsed', 'frequencyUsed',
  'remoteFrequencyUsed', 'manualEntry', 'createdAt', 'modifiedAt', 'isDeleted', 'source',
  'isSnippet', 'observedSource', 'isStarred', 'replacementHtml',
];

export const HISTORY_REQUIRED_COLUMNS: readonly string[] = [
  'transcriptEntityId', 'asrText', 'formattedText', 'editedText', 'timestamp', 'status', 'app', 'isArchived',
];

/** Verbatim from Wispr's flow.sqlite (`.schema Dictionary`); used for test DBs. */
export const DICTIONARY_DDL =
  "CREATE TABLE \"Dictionary\" (`id` VARCHAR(36) NOT NULL PRIMARY KEY, `phrase` VARCHAR(255) NOT NULL, `replacement` VARCHAR(255), `teamDictionaryId` VARCHAR(36) NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000', `lastUsed` DATETIME, `frequencyUsed` INTEGER NOT NULL DEFAULT 0, `remoteFrequencyUsed` INTEGER NOT NULL DEFAULT 0, `manualEntry` TINYINT(1) NOT NULL DEFAULT 0, `createdAt` DATETIME NOT NULL, `modifiedAt` DATETIME NOT NULL, `isDeleted` TINYINT(1) NOT NULL DEFAULT 0, `source` VARCHAR(255), `isSnippet` TINYINT(1) NOT NULL DEFAULT 0, `observedSource` VARCHAR(255), `isStarred` TINYINT(1) NOT NULL DEFAULT 0, `replacementHtml` TEXT, CONSTRAINT `uq_dictionary_phrase_team_dictionary_id` UNIQUE (`phrase`, `teamDictionaryId`));";

/** The real History has 63 columns (audio BLOBs included); tests only need the ones we read. */
export const HISTORY_DDL_FOR_TESTS =
  'CREATE TABLE "History" (`transcriptEntityId` VARCHAR(36) NOT NULL PRIMARY KEY, `asrText` TEXT, `formattedText` TEXT, `editedText` TEXT, `timestamp` DATETIME, `status` TEXT, `app` TEXT, `isArchived` TINYINT(1) NOT NULL DEFAULT 0, `userEditMetaData` JSON);';

export interface PragmaColumn { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

export function evaluateSchema(dict: PragmaColumn[], hist: PragmaColumn[]): SchemaCheck {
  const dictNames = new Set(dict.map((c) => c.name));
  const histNames = new Set(hist.map((c) => c.name));
  const missing = [
    ...DICTIONARY_COLUMNS.filter((c) => !dictNames.has(c)).map((c) => `Dictionary.${c}`),
    ...HISTORY_REQUIRED_COLUMNS.filter((c) => !histNames.has(c)).map((c) => `History.${c}`),
  ];
  const extra = dict.filter((c) => !DICTIONARY_COLUMNS.includes(c.name));
  const unexpected = extra.map((c) => c.name);
  // An extra column is harmless unless it is NOT NULL without a default: our INSERT names
  // only the known 16 columns, so such a column would make every insert fail.
  const blocking = extra.filter((c) => c.notnull === 1 && c.dflt_value === null).map((c) => c.name);

  let detail: string;
  if (dict.length === 0) detail = 'The Dictionary table was not found.';
  else if (hist.length === 0) detail = 'The History table was not found.';
  else if (missing.length) detail = `Wispr's schema changed: missing ${missing.join(', ')}.`;
  else if (blocking.length) detail = `Wispr's Dictionary gained required column(s) ${blocking.join(', ')} that our insert cannot fill.`;
  else if (unexpected.length) detail = `Schema ok; Dictionary has extra optional column(s) ${unexpected.join(', ')}.`;
  else detail = 'Schema ok.';

  return { ok: dict.length > 0 && hist.length > 0 && missing.length === 0 && blocking.length === 0, missing, unexpected, detail };
}
