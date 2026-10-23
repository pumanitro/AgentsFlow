import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Candidate, LedgerState } from './types';
import { cloneLedger, emptyLedger, insertsSince, loadLedger, pruneLedger, recordEvidence } from './ledger';

const DAY = 24 * 60 * 60 * 1000;
const CURSOR = '2026-10-22 08:12:56.682 +00:00';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-ledger-')), 'nested', 'ledger.json');
}

function cand(dictationId: string, heard = 'sferis pl', sent = 'sferis.pl'): Candidate {
  return { heard, sent, key: 'sferis.pl', dictationId, similarity: 0.9, soundsAlike: true, inVocabulary: false };
}

test('emptyLedger has the documented shape', () => {
  assert.deepEqual(emptyLedger(CURSOR), {
    version: 1, cursor: CURSOR, messagesIngestedThrough: 0, evidence: {}, vocab: {}, inserts: [], lastJanitorAt: 0, backupDoneAt: null,
  });
});

test('a missing file loads empty; save and saveSync round-trip', async () => {
  const file = tmpFile();
  const l = loadLedger(file, CURSOR);
  assert.equal(l.file, file);
  assert.deepEqual(l.state, emptyLedger(CURSOR));

  l.state.cursor = 'next';
  l.state.inserts.push({ at: 5, kind: 'vocabulary', phrase: 'AgentsFlow', key: 'agentsflow', id: 'id1' });
  await l.save();
  assert.deepEqual(loadLedger(file, CURSOR).state, l.state);

  l.state.lastJanitorAt = 42;
  l.saveSync();
  assert.equal(loadLedger(file, CURSOR).state.lastJanitorAt, 42);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['ledger.json'], 'no tmp file left behind');
});

test('a corrupt or wrong-version file is set aside and the ledger starts fresh', () => {
  for (const body of ['{oops', JSON.stringify({ ...emptyLedger('x'), version: 2 })]) {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...a: unknown[]) => void warnings.push(a);
    try {
      const l = loadLedger(file, CURSOR);
      assert.deepEqual(l.state, emptyLedger(CURSOR));
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /^\[agentsflow\]\[wispr-learner\]/);
    const files = fs.readdirSync(path.dirname(file));
    assert.equal(files.length, 1);
    assert.match(files[0], /^ledger\.json\.corrupt-\d+$/);
    assert.equal(fs.readFileSync(path.join(path.dirname(file), files[0]), 'utf8'), body);
  }
});

test('cloneLedger does not alias', () => {
  const a: LedgerState = emptyLedger(CURSOR);
  recordEvidence(a, cand('d1'), 10);
  a.vocab.figma = { c: 1, s: ['s'], f: { Figma: 1 }, mid: 1, last: 1 };
  const b = cloneLedger(a);
  assert.deepEqual(b, a);
  recordEvidence(b, cand('d2'), 20);
  b.vocab.figma.c = 9;
  b.inserts.push({ at: 1, kind: 'correction', phrase: 'x', key: 'x', id: 'i' });
  assert.deepEqual(a.evidence['sferis.pl'].dictationIds, ['d1']);
  assert.equal(a.vocab.figma.c, 1);
  assert.equal(a.inserts.length, 0);
});

test('recordEvidence counts distinct dictations', () => {
  const s = emptyLedger(CURSOR);
  assert.equal(recordEvidence(s, cand('d1'), 100), 1);
  assert.equal(recordEvidence(s, cand('d1'), 50), 1, 're-recording the same dictation does not add evidence');
  assert.equal(recordEvidence(s, cand('d2', 'serious pl'), 200), 2);
  const e = s.evidence['sferis.pl'];
  assert.deepEqual(e.heard, { 'sferis pl': 2, 'serious pl': 1 });
  assert.deepEqual(e.forms, { 'sferis.pl': 3 });
  assert.deepEqual(e.dictationIds, ['d1', 'd2']);
  assert.equal(e.firstAt, 50);
  assert.equal(e.lastAt, 200);
});

test('recordEvidence handles prototype-named keys', () => {
  const s = emptyLedger(CURSOR);
  const c: Candidate = { ...cand('d1', 'constructor', 'constructor'), key: 'constructor' };
  assert.equal(recordEvidence(s, c, 1), 1);
  const k: string = 'constructor';
  assert.deepEqual(s.evidence[k].heard, { constructor: 1 });
});

test('insertsSince filters by kind and time', () => {
  const s = emptyLedger(CURSOR);
  s.inserts = [
    { at: 10, kind: 'correction', phrase: 'a', key: 'a', id: '1' },
    { at: 20, kind: 'vocabulary', phrase: 'b', key: 'b', id: '2' },
    { at: 30, kind: 'correction', phrase: 'c', key: 'c', id: '3' },
  ];
  assert.equal(insertsSince(s, 'any', 0), 3);
  assert.equal(insertsSince(s, 'correction', 10), 2);
  assert.equal(insertsSince(s, 'correction', 11), 1);
  assert.equal(insertsSince(s, 'vocabulary', 20), 1);
  assert.equal(insertsSince(s, 'any', 31), 0);
});

test('pruneLedger drops evidence idle > 30 d and inserts > 14 d', () => {
  const now = 100 * DAY;
  const s = emptyLedger(CURSOR);
  recordEvidence(s, { ...cand('old'), key: 'old' }, now - 31 * DAY);
  recordEvidence(s, { ...cand('new'), key: 'new' }, now - 29 * DAY);
  s.inserts = [
    { at: now - 15 * DAY, kind: 'correction', phrase: 'a', key: 'a', id: '1' },
    { at: now - 13 * DAY, kind: 'vocabulary', phrase: 'b', key: 'b', id: '2' },
  ];
  pruneLedger(s, now);
  assert.deepEqual(Object.keys(s.evidence), ['new']);
  assert.deepEqual(s.inserts.map((i) => i.id), ['2']);
});
