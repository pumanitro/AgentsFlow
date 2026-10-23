// The fixture is the user's real Wispr Dictionary (2026-10). The point of these
// tests is the NOT-glued half: every real correction in it must survive.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectGlue, janitorTargets, JANITOR_MAX_FREQUENCY } from './glue';
import type { DictionaryRow } from './types';

type Tuple = [string, string | null, string, 0 | 1, 0 | 1, number];

const SNAPSHOT: Tuple[] = [
  ['Patryk', null, 'default', 0, 0, 78],
  ['Wispr Flow', null, 'default', 0, 0, 14],
  ['btw', null, 'default', 1, 0, 0],
  ['my Flow referral', null, 'default', 1, 0, 0],
  ['my email address', null, 'default', 0, 0, 0],
  ['organize thoughts prompt', null, 'default', 1, 0, 0],
  ['Patryk Janik', null, 'manual', 0, 0, 38],
  ['patrykjanik1710@gmail.com', null, 'manual', 0, 0, 6],
  ['3C', '3', 'user_edits', 0, 0, 1],
  ['3charts', 'charts', 'user_edits', 0, 0, 7],
  ['4090', '490', 'user_edits', 0, 0, 34],
  ['6722091647', '67-043611', 'user_edits', 0, 0, 1],
  ['ACI', 'ASCII', 'user_edits', 0, 0, 5],
  ['Abi', 'Abielisen', 'user_edits', 0, 0, 39],
  ['D10', 'can', 'user_edits', 0, 0, 11],
  ['DosunaleAddit', 'Dosunale', 'user_edits', 0, 0, 1],
  ['Figma', 'Sigma', 'user_edits', 0, 0, 231],
  ['FlowP', 'Flow', 'user_edits', 0, 0, 1],
  ['Jonathan', 'enatan', 'user_edits', 0, 0, 5],
  ['Leymans Terms', 'Lejman Sturms', 'user_edits', 0, 0, 104],
  ['Majameas', 'Maja', 'user_edits', 0, 0, 1],
  ['Majedmerge', 'Majed', 'user_edits', 0, 1, 0],
  ['MordorBRO', 'Mordor', 'user_edits', 0, 0, 1],
  ['Nutrable', 'Nutrabull', 'user_edits', 0, 0, 69],
  ['Reddittiktok', 'Reddit', 'user_edits', 0, 1, 0],
  ['Rumlet', 'ramlet', 'user_edits', 0, 0, 1],
  ['Signala', 'sygnala', 'user_edits', 0, 0, 52],
  ['SzybietS', 'Szybiet', 'user_edits', 0, 0, 1],
  ['TLD', 'from me', 'user_edits', 0, 1, 0],
  ['Trucam', 'drukami', 'user_edits', 0, 0, 19],
  ['WAT', 'VAT', 'user_edits', 0, 0, 1],
  ['WYTFURNIA', 'WYTFURNIA.PL', 'user_edits', 0, 0, 13],
  ['analy5090', 'analyses', 'user_edits', 0, 0, 1],
  ['devlogcommit', 'devlog', 'user_edits', 0, 0, 1],
  ['frameFLAME', 'frame', 'user_edits', 0, 0, 10],
  ['gamemobil', 'game', 'user_edits', 0, 1, 0],
  ['imagedmg', 'image', 'user_edits', 0, 1, 0],
  ['lampwrite', 'lamp', 'user_edits', 0, 1, 0],
  ['main`Commit', 'main', 'user_edits', 0, 1, 0],
  ['nPowiększ', 'Powiększ', 'user_edits', 0, 0, 1],
  ['partscards', 'parts', 'user_edits', 0, 0, 6],
  ['portforge', 'port', 'user_edits', 0, 0, 1],
  ['rhymeRime', 'rhyme', 'user_edits', 0, 0, 1],
  ['rig6ht', 'right', 'user_edits', 0, 0, 1],
  ['righttraits', 'right', 'user_edits', 0, 0, 1],
  ['rozkmnin', 'rosnij', 'user_edits', 0, 0, 1],
  ['sata', 'sapa', 'user_edits', 0, 0, 4],
  ['screenpath', 'screen', 'user_edits', 0, 0, 1],
  ['sferis.pl', 'serwis', 'user_edits', 0, 0, 3],
  ['simulatorpayback', 'simulator', 'user_edits', 0, 0, 1],
  ['smart-commit', 'Comet', 'user_edits', 0, 0, 47],
  ['subtaskssubagent', 'subtasks', 'user_edits', 0, 0, 1],
  ['universalvercel', 'universal', 'user_edits', 0, 1, 0],
  ['variableFable', 'variable', 'user_edits', 0, 1, 0],
  ['videos30', 'videos', 'user_edits', 0, 0, 1],
  ['worktree', 'word', 'user_edits', 0, 0, 26],
];

const GLUED = new Set([
  'righttraits', 'Reddittiktok', 'subtaskssubagent', 'main`Commit', 'variableFable', 'analy5090', 'frameFLAME',
  'rig6ht', 'devlogcommit', 'partscards', '3charts', 'imagedmg', 'screenpath', 'nPowiększ', 'SzybietS', 'MordorBRO',
  'DosunaleAddit', 'Majameas', 'lampwrite', 'universalvercel', 'Majedmerge', 'rhymeRime', 'videos30',
  'simulatorpayback', 'portforge', 'gamemobil', 'FlowP',
]);

function toRow([phrase, observedSource, source, manualEntry, isDeleted, frequencyUsed]: Tuple, i: number): DictionaryRow {
  return {
    id: `row-${i}`, phrase, replacement: null, observedSource, source,
    manualEntry: manualEntry === 1, isDeleted: isDeleted === 1, frequencyUsed,
    createdAt: '2026-10-01 00:00:00.000 +00:00', modifiedAt: '2026-10-01 00:00:00.000 +00:00',
  };
}
const ROWS = SNAPSHOT.map(toRow);

test('every glued row in the real snapshot is flagged', () => {
  for (const r of ROWS.filter((r) => GLUED.has(r.phrase))) {
    const v = detectGlue(r);
    assert.equal(v.glued, true, `${r.phrase} ← ${r.observedSource} should be glued`);
    assert.ok(v.rule);
  }
});

test('no real correction or default/manual row is flagged', () => {
  for (const r of ROWS.filter((r) => !GLUED.has(r.phrase))) {
    assert.deepEqual(detectGlue(r), { glued: false, rule: null }, `${r.phrase} ← ${r.observedSource} must not be glued`);
  }
});

test('expected rules on representative rows', () => {
  const rule = (phrase: string) => detectGlue(ROWS.find((r) => r.phrase === phrase)!).rule;
  assert.equal(rule('righttraits'), 'prefix-junk');
  assert.equal(rule('FlowP'), 'camel-tail');
  assert.equal(rule('SzybietS'), 'camel-tail');
  assert.equal(rule('rig6ht'), 'digits-inside');
  assert.equal(rule('analy5090'), 'near-prefix-digits');
  assert.equal(rule('3charts'), 'digits-inside'); // digits-inside runs first; junk-head would also match
  assert.equal(rule('nPowiększ'), 'junk-head');
});

test('janitorTargets returns exactly the 19 live glued rows', () => {
  const targets = janitorTargets(ROWS);
  const expected = ROWS.filter((r) => GLUED.has(r.phrase) && !r.isDeleted).map((r) => r.phrase).sort();
  assert.equal(expected.length, 19);
  assert.deepEqual(targets.map((t) => t.phrase).sort(), expected);
  for (const t of targets) {
    const row = ROWS.find((r) => r.id === t.id)!;
    assert.equal(t.observedSource, row.observedSource);
    assert.equal(t.rule, detectGlue(row).rule);
  }
});

test('preconditions: frequency cap, manual entry, multi-word phrase', () => {
  const base = { phrase: 'righttraits', observedSource: 'right', source: 'user_edits', manualEntry: false, frequencyUsed: 1 };
  assert.equal(detectGlue(base).glued, true);
  assert.equal(JANITOR_MAX_FREQUENCY, 50);
  assert.equal(detectGlue({ ...base, frequencyUsed: 50 }).glued, false);
  assert.equal(detectGlue({ ...base, frequencyUsed: 49 }).glued, true);
  assert.equal(detectGlue({ ...base, manualEntry: true }).glued, false);
  assert.equal(detectGlue({ ...base, phrase: 'right traits' }).glued, false);
  assert.equal(detectGlue({ ...base, observedSource: null }).glued, false);
  assert.equal(detectGlue({ ...base, observedSource: '   ' }).glued, false);
  assert.equal(detectGlue({ ...base, source: 'default' }).glued, false);
});
