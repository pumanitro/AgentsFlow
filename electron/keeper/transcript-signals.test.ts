import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { transcriptPath } from '../transcript-path';
import { __resetTranscriptSignalsForTests, isDeclaredDone, parseTranscriptSignals, readTranscriptSignals } from './transcript-signals';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
// Real entry shapes, lifted from transcripts under ~/.claude/projects with the
// text redacted and the bookkeeping keys (uuid, parentUuid, cwd, version …)
// trimmed: an assistant entry is one content block per line, a slash command is
// a `user` entry whose content is a string of <command-…> tags, a tool result
// is a `user` entry whose content is a list.

function assistantText(ts: string, text: string): string {
  return JSON.stringify({
    parentUuid: 'p', isSidechain: false, type: 'assistant', timestamp: ts, sessionId: 's',
    message: { model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function toolUse(ts: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    parentUuid: 'p', isSidechain: false, type: 'assistant', timestamp: ts, sessionId: 's',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01Toy7p49ZMfcpw4Y1tf1sN7', name, input }] },
  });
}

function thinking(ts: string): string {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x' }] } });
}

function userPrompt(ts: string, content: string): string {
  return JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', timestamp: ts, promptSource: 'typed', message: { role: 'user', content } });
}

function toolResult(ts: string, content: string): string {
  return JSON.stringify({
    type: 'user', timestamp: ts, sourceToolAssistantUUID: 'a',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_01Toy7p49ZMfcpw4Y1tf1sN7', type: 'tool_result', content }] },
  });
}

const CRON_CREATE = toolUse('2026-09-27T20:20:38.646Z', 'CronCreate', { cron: '13 * * * *', prompt: 'hourly round (redacted)', recurring: true });
const LOOP_COMMAND = userPrompt('2026-10-02T11:47:43.182Z', '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>10m check the deploy</command-args>');
const OTHER_COMMAND = userPrompt('2026-10-02T11:47:43.182Z', '<command-message>smart-commit</command-message>\n<command-name>/smart-commit</command-name>\n<command-args>and push</command-args>');
const QUEUE_OP = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-10T20:59:39.286Z', sessionId: 's', content: '<command-name>/loop</command-name> typed but only queued' });
// The tool catalogue rides along as an attachment — CronCreate and TaskCreate
// are named in it in every single chat.
const ATTACHMENT = JSON.stringify({
  parentUuid: 'p', isSidechain: false, type: 'attachment',
  attachment: { type: 'deferred_tools_record', entries: [{ name: 'CronCreate', description: 'Schedule a prompt' }, { name: 'TaskCreate', description: 'Create a task' }] },
});

function taskCreate(ts: string, subject: string): string {
  return toolUse(ts, 'TaskCreate', { subject, description: '(redacted)', activeForm: 'Working' });
}

function tail(...lines: string[]): string {
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// parseTranscriptSignals
// ---------------------------------------------------------------------------

test('an empty tail says nothing', () => {
  assert.deepEqual(parseTranscriptSignals(''), {
    lastAssistantText: null, lastAssistantAt: 0, declaredDone: false, hasCron: false, hasLoopCommand: false, openTasks: 0,
  });
});

test('the last assistant text and its time are reported; a trailing tool call does not hide it', () => {
  const s = parseTranscriptSignals(tail(
    userPrompt('2026-10-10T20:59:40.011Z', 'do the thing'),
    assistantText('2026-10-10T21:08:10.000Z', 'on it'),
    thinking('2026-10-10T21:08:52.019Z'),
    assistantText('2026-10-10T21:08:54.657Z', 'step 1 done.'),
    toolUse('2026-10-10T21:08:55.000Z', 'Read', { file_path: '/x' }),
    toolResult('2026-10-10T21:08:56.000Z', '1\tx'),
  ));
  assert.equal(s.lastAssistantText, 'step 1 done.');
  assert.equal(s.lastAssistantAt, Date.parse('2026-10-10T21:08:54.657Z'));
  assert.equal(s.declaredDone, false);
});

test('CronCreate ⇒ hasCron', () => {
  const s = parseTranscriptSignals(tail(userPrompt('2026-09-27T20:20:00.000Z', 'set it up'), CRON_CREATE, assistantText('2026-09-27T20:21:00.000Z', 'Scheduled.')));
  assert.equal(s.hasCron, true);
  assert.equal(s.hasLoopCommand, false);
});

test('/loop ⇒ hasLoopCommand', () => {
  const s = parseTranscriptSignals(tail(LOOP_COMMAND, assistantText('2026-10-02T11:48:00.000Z', 'Looping every 10 minutes.')));
  assert.equal(s.hasLoopCommand, true);
  assert.equal(s.hasCron, false);
});

test('/loop as a list of text parts also counts', () => {
  const entry = JSON.stringify({ type: 'user', timestamp: '2026-10-02T11:47:43.182Z', message: { role: 'user', content: [{ type: 'text', text: '<command-name>/loop</command-name>' }] } });
  assert.equal(parseTranscriptSignals(entry).hasLoopCommand, true);
});

test('another slash command is not a loop', () => {
  assert.equal(parseTranscriptSignals(tail(OTHER_COMMAND)).hasLoopCommand, false);
});

test('a tool result that merely quotes /loop or CronCreate arms nothing', () => {
  const s = parseTranscriptSignals(tail(
    toolResult('2026-10-11T09:00:00.000Z', 'PLAN.md: inferred from <command-name>/loop</command-name> or "name":"CronCreate"'),
    assistantText('2026-10-11T09:00:05.000Z', 'The plan mentions CronCreate and <command-name>/loop.'),
  ));
  assert.equal(s.hasLoopCommand, false);
  assert.equal(s.hasCron, false);
});

test('queue-operation and attachment entries are skipped', () => {
  const s = parseTranscriptSignals(tail(QUEUE_OP, ATTACHMENT, assistantText('2026-10-11T09:00:05.000Z', 'hello')));
  assert.equal(s.hasLoopCommand, false);
  assert.equal(s.hasCron, false);
  assert.equal(s.openTasks, 0);
  assert.equal(s.lastAssistantText, 'hello');
});

test('3 TaskCreate + 1 completed ⇒ openTasks 2', () => {
  const s = parseTranscriptSignals(tail(
    taskCreate('2026-10-11T09:00:00.000Z', 'Capture the broken state'),
    taskCreate('2026-10-11T09:00:01.000Z', 'Write the regression test'),
    taskCreate('2026-10-11T09:00:02.000Z', 'Remove the probe'),
    toolUse('2026-10-11T09:01:00.000Z', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
    toolUse('2026-10-11T09:05:00.000Z', 'TaskUpdate', { taskId: '1', status: 'completed' }),
  ));
  assert.equal(s.openTasks, 2);
});

test('openTasks never goes below zero (creations scrolled out of the tail)', () => {
  const s = parseTranscriptSignals(tail(
    toolUse('2026-10-11T09:05:00.000Z', 'TaskUpdate', { taskId: '7', status: 'completed' }),
    toolUse('2026-10-11T09:06:00.000Z', 'TaskUpdate', { taskId: '8', status: 'completed' }),
  ));
  assert.equal(s.openTasks, 0);
});

test('declaredDone true: the last words read as finished', () => {
  for (const text of [
    'All tasks are done.',
    'Summary of the work.\n\nAll steps complete',
    'Everything is committed. Task complete.',
    'I checked the list again — nothing left to do.',
    'Finished everything',
    'DONE.',
    '**All items are completed!**',
  ]) {
    assert.equal(parseTranscriptSignals(assistantText('2026-10-11T09:00:00.000Z', text)).declaredDone, true, text);
  }
});

test('declaredDone false: an interim report, or "done" in the middle', () => {
  for (const text of [
    'step 1 done. Moving on to step 2 next',
    'All tasks are done except the migration, which I will do now',
    'I finished the first half',
    'on it',
  ]) {
    assert.equal(parseTranscriptSignals(assistantText('2026-10-11T09:00:00.000Z', text)).declaredDone, false, text);
  }
});

test('declaredDone false with a trailing \'?\': a question is never a finish line', () => {
  assert.equal(isDeclaredDone('All tasks are done. Want me to open a PR?'), false);
  assert.equal(isDeclaredDone('Is the task complete?'), false);
  assert.equal(isDeclaredDone('All tasks are done. Let me know if you want a PR.\nDONE.'), false);
  assert.equal(isDeclaredDone(null), false);
});

test('only the NEWEST assistant text decides declaredDone', () => {
  const s = parseTranscriptSignals(tail(
    assistantText('2026-10-11T09:00:00.000Z', 'All tasks are done.'),
    userPrompt('2026-10-11T09:10:00.000Z', 'one more thing'),
    assistantText('2026-10-11T09:11:00.000Z', 'Looking into it now'),
  ));
  assert.equal(s.declaredDone, false);
  assert.equal(s.lastAssistantText, 'Looking into it now');
});

test('a half-written last line is skipped, not fatal', () => {
  const s = parseTranscriptSignals(tail(assistantText('2026-10-11T09:00:00.000Z', 'step 1 done.'), '{"type":"assistant","timestamp":"2026-10-11T09:0'));
  assert.equal(s.lastAssistantText, 'step 1 done.');
});

// ---------------------------------------------------------------------------
// readTranscriptSignals (the thin fs reader)
// ---------------------------------------------------------------------------

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-signals-'));
}

const CONV = { id: 'c1', directoryPath: '/Users/demo/proj', sessionId: 'abc12345-0000-4000-8000-000000000001' };

function writeTranscript(root: string, text: string): string {
  const file = transcriptPath(root, CONV.directoryPath, CONV.sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('readTranscriptSignals: null when there is no transcript', () => {
  __resetTranscriptSignalsForTests();
  const root = tmpRoot();
  assert.equal(readTranscriptSignals(CONV, root), null);
  assert.equal(readTranscriptSignals({ ...CONV, sessionId: '' }, root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('readTranscriptSignals: a short transcript is read whole — line 0 is a real entry', () => {
  __resetTranscriptSignalsForTests();
  const root = tmpRoot();
  writeTranscript(root, tail(LOOP_COMMAND, assistantText('2026-10-02T11:48:00.000Z', 'Looping.')) + '\n');
  const s = readTranscriptSignals(CONV, root);
  assert.equal(s?.hasLoopCommand, true);
  assert.equal(s?.lastAssistantText, 'Looping.');
  fs.rmSync(root, { recursive: true, force: true });
});

test('readTranscriptSignals: a long transcript is read from its tail, leading fragment dropped', () => {
  __resetTranscriptSignalsForTests();
  const root = tmpRoot();
  const filler = Array.from({ length: 400 }, (_, i) => assistantText('2026-10-11T08:00:00.000Z', `chunk ${i} ` + 'x'.repeat(400))).join('\n');
  writeTranscript(root, tail(taskCreate('2026-10-11T07:00:00.000Z', 'far behind the tail'), filler, assistantText('2026-10-11T09:00:00.000Z', 'All tasks are done.')) + '\n');
  const s = readTranscriptSignals(CONV, root);
  assert.equal(s?.declaredDone, true);
  assert.equal(s?.openTasks, 0); // the TaskCreate is beyond the 96 KB window
  fs.rmSync(root, { recursive: true, force: true });
});

test('readTranscriptSignals: cached on mtime+size, re-read when the file grows', () => {
  __resetTranscriptSignalsForTests();
  const root = tmpRoot();
  const file = writeTranscript(root, assistantText('2026-10-11T09:00:00.000Z', 'step 1 done.') + '\n');
  const first = readTranscriptSignals(CONV, root);
  assert.equal(first?.lastAssistantText, 'step 1 done.');
  assert.equal(readTranscriptSignals(CONV, root), first, 'unchanged file ⇒ the very same cached object');
  fs.appendFileSync(file, assistantText('2026-10-11T09:05:00.000Z', 'Which one do you want?') + '\n');
  const second = readTranscriptSignals(CONV, root);
  assert.equal(second?.lastAssistantText, 'Which one do you want?');
  fs.rmSync(root, { recursive: true, force: true });
});

test('readTranscriptSignals: a cron stays armed after it scrolls out of the tail', () => {
  __resetTranscriptSignalsForTests();
  const root = tmpRoot();
  const file = writeTranscript(root, tail(CRON_CREATE, assistantText('2026-09-27T20:21:00.000Z', 'Scheduled.')) + '\n');
  assert.equal(readTranscriptSignals(CONV, root)?.hasCron, true);
  const filler = Array.from({ length: 400 }, (_, i) => assistantText('2026-09-27T21:00:00.000Z', `round ${i} ` + 'x'.repeat(400))).join('\n');
  fs.appendFileSync(file, filler + '\n');
  const later = readTranscriptSignals(CONV, root);
  assert.equal(parseTranscriptSignals(filler).hasCron, false, 'the tail alone no longer shows it');
  assert.equal(later?.hasCron, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('readTranscriptSignals: a cron set megabytes before the tail is found on first sight', () => {
  __resetTranscriptSignalsForTests();
  const root = tmpRoot();
  // > 2 MB of turns after the CronCreate, so the needle sits in an early chunk
  // and the tail (96 KB) is nowhere near it.
  const filler = Array.from({ length: 2600 }, (_, i) => assistantText('2026-09-27T21:00:00.000Z', `round ${i} ` + 'x'.repeat(900))).join('\n');
  writeTranscript(root, tail(ATTACHMENT, CRON_CREATE, filler) + '\n');
  assert.equal(readTranscriptSignals(CONV, root)?.hasCron, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('readTranscriptSignals: a long transcript that only NAMES CronCreate (catalogue, quoted text) has no cron', () => {
  __resetTranscriptSignalsForTests();
  const root = tmpRoot();
  const quoted = toolResult('2026-09-27T20:00:00.000Z', '{"type":"tool_use","id":"t","name":"CronCreate","input":{"cron":"* * * * *"}}');
  const filler = Array.from({ length: 300 }, (_, i) => assistantText('2026-09-27T21:00:00.000Z', `round ${i} ` + 'x'.repeat(900))).join('\n');
  writeTranscript(root, tail(ATTACHMENT, quoted, filler) + '\n');
  assert.equal(readTranscriptSignals(CONV, root)?.hasCron, false);
  fs.rmSync(root, { recursive: true, force: true });
});
