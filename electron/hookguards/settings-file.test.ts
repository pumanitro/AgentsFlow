// Reading settings.json (missing / malformed / not an object) and writing it
// with a backup first, 2-space JSON, atomically.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSettingsJson, writeSettingsJsonWithBackup } from './settings-file';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hg-settings-'));
}

describe('settings-file', () => {
  test('missing → {} existed:false; malformed and non-object → error', () => {
    const dir = tmp();
    const p = path.join(dir, 'settings.json');
    assert.deepEqual(readSettingsJson(p), { ok: true, json: {}, existed: false });
    fs.writeFileSync(p, '{ nope');
    const bad = readSettingsJson(p);
    assert.equal(bad.ok, false);
    fs.writeFileSync(p, '[1]');
    assert.equal(readSettingsJson(p).ok, false);
    fs.writeFileSync(p, '{"a":1}');
    assert.deepEqual(readSettingsJson(p), { ok: true, json: { a: 1 }, existed: true });
  });

  test('write backs up the old file first and writes 2-space JSON + newline', () => {
    const dir = tmp();
    const p = path.join(dir, 'settings.json');
    const backups = path.join(dir, 'backups');
    fs.writeFileSync(p, '{"old":true}');
    const r = writeSettingsJsonWithBackup(p, backups, { a: { b: 1 } }, 42);
    assert.equal(r.backup, path.join(backups, 'settings.json.backup.42'));
    assert.equal(fs.readFileSync(r.backup!, 'utf8'), '{"old":true}');
    assert.equal(fs.readFileSync(p, 'utf8'), '{\n  "a": {\n    "b": 1\n  }\n}\n');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['backups', 'settings.json']);
  });

  test('a new file gets no backup', () => {
    const dir = tmp();
    const r = writeSettingsJsonWithBackup(path.join(dir, 'sub', 'settings.json'), path.join(dir, 'backups'), {}, 1);
    assert.equal(r.backup, null);
    assert.ok(!fs.existsSync(path.join(dir, 'backups')));
  });
});
