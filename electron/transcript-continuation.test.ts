import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { continuedIn, latestContinuation, mungeCwd } from './transcript-path';

const CWD = '/Users/x/Desktop/abi';
const line = (o: object) => JSON.stringify(o);

function tree(files: Record<string, object[]>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cont-'));
  const dir = path.join(root, mungeCwd(CWD));
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, entries] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), entries.map(line).join('\n') + '\n');
  }
  return root;
}

test.describe('continued-in', () => {
  test('a marker after the last message points at the parked session, past trailing bookkeeping', () => {
    const root = tree({
      a: [{ type: 'user' }, { type: 'assistant' }, { type: 'continued-in', continuedInSessionId: 'b' }, { type: 'cost-state' }],
      b: [{ type: 'user' }],
    });
    assert.equal(continuedIn(path.join(root, mungeCwd(CWD), 'a.jsonl')), 'b');
    assert.equal(latestContinuation(root, CWD, 'a'), 'b');
  });

  test('a message after the marker means the old session was continued in place', () => {
    const root = tree({
      a: [{ type: 'continued-in', continuedInSessionId: 'b' }, { type: 'user' }],
      b: [{ type: 'user' }],
    });
    assert.equal(latestContinuation(root, CWD, 'a'), 'a');
  });

  test('follows a chain, and stops at a target with no transcript', () => {
    const root = tree({
      a: [{ type: 'continued-in', continuedInSessionId: 'b' }],
      b: [{ type: 'continued-in', continuedInSessionId: 'c' }],
      c: [{ type: 'continued-in', continuedInSessionId: 'gone' }],
    });
    assert.equal(latestContinuation(root, CWD, 'a'), 'c');
  });

  test('no marker, no transcript: the id is unchanged', () => {
    const root = tree({ a: [{ type: 'user' }] });
    assert.equal(latestContinuation(root, CWD, 'a'), 'a');
    assert.equal(latestContinuation(root, CWD, 'missing'), 'missing');
  });
});
