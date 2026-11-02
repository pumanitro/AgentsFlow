import { strict as assert } from 'node:assert';
import { after, describe, test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeState, readJobSlice, readTimelineTail, sliceFromJobState } from './job-state';

const FIXTURES = path.resolve(__dirname, '../../../../electron/mobile/fixtures');
const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'wp11-jobs-'));
after(() => { fs.rmSync(JOBS, { recursive: true, force: true }); });

function job(short: string, stateFixture: string, withTimeline = false): void {
  fs.mkdirSync(path.join(JOBS, short), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, stateFixture), path.join(JOBS, short, 'state.json'));
  if (withTimeline) fs.copyFileSync(path.join(FIXTURES, 'timeline.jsonl'), path.join(JOBS, short, 'timeline.jsonl'));
}
job('blocked1', 'state-blocked.json');
job('working1', 'state-working.json', true);
job('done0001', 'state-done.json');

describe('normalizeState', () => {
  test('maps raw words', () => {
    assert.equal(normalizeState('working', true), 'blocked');
    assert.equal(normalizeState('active', false), 'working');
    assert.equal(normalizeState('Working', false), 'working');
    assert.equal(normalizeState('completed', false), 'done');
    assert.equal(normalizeState('error', false), 'failed');
    assert.equal(normalizeState('starting', false), 'starting');
    assert.equal(normalizeState('needs-input', false), 'blocked');
    assert.equal(normalizeState(undefined, false), 'idle');
    assert.equal(normalizeState('weird', false), 'idle');
  });
});

describe('readJobSlice', () => {
  test('blocked fixture', () => {
    const s = readJobSlice(JOBS, 'blocked1')!;
    assert.equal(s.state, 'blocked');
    assert.equal(s.rawState, 'working');
    assert.equal(s.detail, 'Which option?');
    assert.equal(s.suggestedReply, 'commit and push it');
    assert.equal(s.needs, 'Which option?');
    assert.equal(s.tempo, 'blocked');
    assert.equal(s.questions.length, 1);
    assert.deepEqual(s.questions[0], {
      id: 'q0', question: 'Which option?',
      options: [{ label: 'A: keep', description: 'keep the file' }, { label: 'B: drop' }],
    });
    assert.deepEqual(s.timeline, []);
  });
  test('working fixture', () => {
    const s = readJobSlice(JOBS, 'working1')!;
    assert.equal(s.state, 'working');
    assert.equal(s.inFlight.tasks, 2);
    assert.deepEqual(s.inFlight.kinds, ['agent', 'shell']);
    assert.equal(s.detail, 'Reading diff…');
    assert.equal(s.updatedAt, '2026-10-28T09:15:00.000Z');
    assert.deepEqual(s.questions, []);
    assert.equal(s.timeline.length, 20);
  });
  test('done fixture', () => {
    const s = readJobSlice(JOBS, 'done0001')!;
    assert.equal(s.state, 'done');
    assert.equal(s.detail, 'All tasks are complete.');
  });
  test('missing or corrupt state gives null', () => {
    assert.equal(readJobSlice(JOBS, 'nope'), null);
    fs.mkdirSync(path.join(JOBS, 'corrupt1'), { recursive: true });
    fs.writeFileSync(path.join(JOBS, 'corrupt1', 'state.json'), '{"state":');
    assert.equal(readJobSlice(JOBS, 'corrupt1'), null);
    assert.equal(readJobSlice(JOBS, ''), null);
  });
});

describe('sliceFromJobState', () => {
  test('defaults for a bare job', () => {
    const s = sliceFromJobState({}, []);
    assert.equal(s.state, 'idle');
    assert.equal(s.rawState, '');
    assert.deepEqual(s.inFlight, { tasks: 0, queued: 0, kinds: [] });
    assert.equal(s.detail, 'idle');
  });
});

describe('readTimelineTail', () => {
  test('last 20 of 25, ending with the last fixture line', () => {
    const t = readTimelineTail(JOBS, 'working1');
    assert.equal(t.length, 20);
    const lines = fs.readFileSync(path.join(FIXTURES, 'timeline.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 25);
    const last = JSON.parse(lines[24]);
    assert.deepEqual(t[19], { at: last.at, state: last.state, detail: last.detail });
    assert.equal(t[19].detail, 'Waiting for review');
    assert.equal(t[18].detail, 'Writing the summary report');
    assert.equal(t[0].at, JSON.parse(lines[5]).at);
  });
  test('custom n and missing file', () => {
    assert.equal(readTimelineTail(JOBS, 'working1', 3).length, 3);
    assert.deepEqual(readTimelineTail(JOBS, 'nope'), []);
  });
});
