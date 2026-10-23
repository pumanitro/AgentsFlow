import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendAudit, readAudit } from './audit';

let dir = '';
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe('audit', () => {
  it('appends JSON lines, creating the directory', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-audit-'));
    const file = path.join(dir, 'nested', 'audit.jsonl');
    appendAudit(file, [{ at: 'a', action: 'insert', id: '1', phrase: 'Peers Flow', dryRun: false }]);
    appendAudit(file, [{ at: 'b', action: 'backup', dryRun: false }, { at: 'c', action: 'error', why: 'x', dryRun: false }]);
    appendAudit(file, []);
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 4);
    assert.deepEqual(readAudit(file).map((e) => e.action), ['insert', 'backup', 'error']);
  });
  it('tolerates a torn last line and a missing file', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-audit-'));
    const file = path.join(dir, 'audit.jsonl');
    assert.deepEqual(readAudit(file), []);
    appendAudit(file, [{ at: 'a', action: 'soft-delete', id: '1', dryRun: false }]);
    fs.appendFileSync(file, '{"at":"b","action":"ins');
    const got = readAudit(file);
    assert.equal(got.length, 1);
    assert.equal(got[0].action, 'soft-delete');
  });
});
