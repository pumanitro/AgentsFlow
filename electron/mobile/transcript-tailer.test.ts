import { strict as assert } from 'node:assert';
import { after, describe, test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createTailer, entriesFromJsonl, hasUserTextAfter, normaliseText, readAppended, readMessagesPage, toolSummary,
} from './transcript-tailer';
import type { MessageEntry } from '../../shared/mobile';

const FIXTURES = path.resolve(__dirname, '../../../../electron/mobile/fixtures');
const SAMPLE = path.join(FIXTURES, 'transcript-sample.jsonl');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wp11-tailer-'));
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const EXPECTED_KINDS = [
  'user.text', 'thinking', 'assistant.text', 'tool_use', 'tool_result',
  'tool_use', 'tool_result', 'subagent', 'user.text', 'assistant.text',
];

function sampleLines(): string[] {
  return fs.readFileSync(SAMPLE, 'utf8').split('\n');
}

/** Temp copy holding only the fixture's complete lines (ends with '\n'). */
function completeCopy(name: string): string {
  const text = fs.readFileSync(SAMPLE, 'utf8');
  const file = path.join(TMP, name);
  fs.writeFileSync(file, text.slice(0, text.lastIndexOf('\n') + 1));
  return file;
}

const line = (o: object): string => JSON.stringify(o) + '\n';

describe('toolSummary', () => {
  test('known tools', () => {
    assert.equal(toolSummary('Bash', { command: 'npm test', description: 'Run the test suite' }), 'Bash: Run the test suite');
    assert.equal(toolSummary('Bash', { command: 'ls -la' }), 'Bash: ls -la');
    assert.equal(toolSummary('Read', { file_path: '/a/b/sept.csv' }), 'Read: sept.csv');
    assert.equal(toolSummary('NotebookEdit', { notebook_path: '/a/n.ipynb' }), 'NotebookEdit: n.ipynb');
    assert.equal(toolSummary('Agent', { description: 'scan repo' }), 'Agent: scan repo');
    assert.equal(toolSummary('Task', { prompt: 'x'.repeat(200) }), 'Agent: ' + 'x'.repeat(80));
    assert.equal(toolSummary('Grep', { pattern: 'foo' }), 'Grep: foo');
    assert.equal(toolSummary('WebSearch', { query: 'kseF' }), 'WebSearch: kseF');
    assert.equal(toolSummary('WebFetch', { url: 'https://x.y' }), 'WebFetch: https://x.y');
  });
  test('unknown tools, single line, ≤ 120 chars', () => {
    assert.equal(toolSummary('Mystery', {}), 'Mystery');
    assert.equal(toolSummary('Mystery', { n: 3, msg: 'hello\nworld' }), 'Mystery: hello world');
    const long = toolSummary('Bash', { command: 'a\n'.repeat(300) });
    assert.ok(long.length <= 120);
    assert.ok(!long.includes('\n'));
  });
});

describe('entriesFromJsonl', () => {
  const entries = entriesFromJsonl(sampleLines());
  test('fixture parses to the expected kinds in order', () => {
    assert.deepEqual(entries.map((e) => e.kind), EXPECTED_KINDS);
  });
  test('fields of each entry', () => {
    assert.equal(entries[0].text, 'check the invoices for September');
    assert.equal(entries[0].id, 'u1:0');
    assert.equal(entries[0].at, '2026-10-28T09:14:00.000Z');
    assert.ok(entries[1].text.startsWith('Plan: open KSeF'));
    assert.equal(entries[3].text, 'Bash: Run the test suite');
    assert.equal(entries[3].toolName, 'Bash');
    assert.equal(entries[3].toolUseId, 'toolu_1');
    assert.equal(entries[4].toolUseId, 'toolu_1');
    assert.equal(entries[4].text, 'ok — 12 tests passed');
    assert.equal(entries[4].truncated, undefined);
    assert.equal(entries[5].text, 'Read: sept.csv');
    assert.equal(entries[6].truncated, true);
    assert.equal(entries[6].text.length, 2048);
    assert.equal(entries[7].id, 's1:0');
    assert.equal(entries[7].sidechain, true);
    assert.equal(entries[7].text, 'Subagent: comparing totals');
    assert.equal(entries[8].text, 'yes, option B');
    assert.ok(entries[9].text.includes('<spoken>'));
  });
  test('meta entries hidden, ids unique', () => {
    assert.ok(!entries.some((e) => e.text.includes('Base directory for this skill')));
    assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
  });
  test('sources tag matching user text', () => {
    const tagged = entriesFromJsonl(sampleLines(), new Map([[normaliseText('yes,  option B '), 'voice' as const]]));
    assert.equal(tagged[8].source, 'voice');
    assert.equal(tagged[0].source, undefined);
  });
  test('missing uuid, image parts, whitespace text, sidechain without text', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image' }, { type: 'text', text: 'cap' }] }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: '   ' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'b', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } }),
      'not json',
    ];
    const e = entriesFromJsonl(lines);
    assert.deepEqual(e.map((x) => [x.id, x.kind, x.text]), [
      ['noid-0:0', 'tool_result', '[image]\ncap'],
      ['b:0', 'subagent', 'subagent working'],
    ]);
  });
});

describe('readMessagesPage', () => {
  test('one page holds everything when limit is large', () => {
    const p = readMessagesPage(SAMPLE, { limit: 50 });
    assert.deepEqual(p.entries.map((e) => e.kind), EXPECTED_KINDS);
    assert.equal(p.hasMore, false);
    assert.equal(p.cursor, 0);
    const text = fs.readFileSync(SAMPLE);
    assert.equal(p.end, text.lastIndexOf(0x0a) + 1);   // the trailing partial line is not counted
    assert.ok(p.end < text.length);
  });
  test('limit=3 paging with before=cursor reproduces the full list', () => {
    const all = entriesFromJsonl(sampleLines());
    const pages: MessageEntry[][] = [];
    let before: number | undefined;
    let last;
    for (let guard = 0; guard < 20; guard++) {
      last = readMessagesPage(SAMPLE, { limit: 3, before });
      assert.ok(last.entries.length <= 3);
      pages.unshift(last.entries);
      if (!last.hasMore) break;
      assert.ok(before === undefined || last.cursor < before);
      before = last.cursor;
    }
    assert.equal(last!.hasMore, false);
    const flat = pages.flat();
    assert.deepEqual(flat.map((e) => e.id), all.map((e) => e.id));
    assert.equal(new Set(flat.map((e) => e.id)).size, flat.length);
  });
  test('small chunks: a big file pages across chunk boundaries', () => {
    const file = path.join(TMP, 'big.jsonl');
    const ids: string[] = [];
    let body = '';
    for (let i = 0; i < 400; i++) {
      ids.push(`m${i}:0`);
      body += line({ type: 'assistant', uuid: `m${i}`, message: { content: [{ type: 'text', text: `msg ${i} ` + 'z'.repeat(1500) }] } });
    }
    fs.writeFileSync(file, body);
    const got: string[] = [];
    let before: number | undefined;
    for (;;) {
      const p = readMessagesPage(file, { limit: 50, before });
      got.unshift(...p.entries.map((e) => e.id));
      if (!p.hasMore) break;
      before = p.cursor;
    }
    assert.deepEqual(got, ids);
  });
  test('multi-part line is never split across pages', () => {
    const file = path.join(TMP, 'multi.jsonl');
    fs.writeFileSync(file,
      line({ type: 'user', uuid: 'u', message: { content: 'hi' } })
      + line({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] } })
      + line({ type: 'assistant', uuid: 'b', message: { content: [{ type: 'text', text: 'three' }] } }));
    const p1 = readMessagesPage(file, { limit: 2 });
    assert.deepEqual(p1.entries.map((e) => e.id), ['b:0']);
    const p2 = readMessagesPage(file, { limit: 2, before: p1.cursor });
    assert.deepEqual(p2.entries.map((e) => e.id), ['a:0', 'a:1']);
    const p3 = readMessagesPage(file, { limit: 2, before: p2.cursor });
    assert.deepEqual(p3.entries.map((e) => e.id), ['u:0']);
    assert.equal(p3.hasMore, false);
  });
  test('missing file gives an empty page', () => {
    assert.deepEqual(readMessagesPage(path.join(TMP, 'nope.jsonl'), { limit: 5 }), { entries: [], hasMore: false, cursor: 0, end: 0 });
  });
});

describe('readAppended / hasUserTextAfter', () => {
  test('returns exactly the two appended entries, end = file size', () => {
    const file = completeCopy('append.jsonl');
    const from = fs.statSync(file).size;
    fs.appendFileSync(file,
      line({ type: 'user', uuid: 'n1', timestamp: 't1', message: { content: 'next please' } })
      + line({ type: 'assistant', uuid: 'n2', timestamp: 't2', message: { content: [{ type: 'text', text: 'on it' }] } }));
    const r = readAppended(file, from);
    assert.deepEqual(r.entries.map((e) => e.id), ['n1:0', 'n2:0']);
    assert.equal(r.end, fs.statSync(file).size);
  });
  test('a partial appended line is not returned and end stays before it', () => {
    const file = completeCopy('partial.jsonl');
    const from = fs.statSync(file).size;
    fs.appendFileSync(file, line({ type: 'user', uuid: 'n1', message: { content: 'done line' } }));
    const mid = fs.statSync(file).size;
    fs.appendFileSync(file, '{"type":"assistant","uuid":"n2","mess');
    const r = readAppended(file, from);
    assert.deepEqual(r.entries.map((e) => e.id), ['n1:0']);
    assert.equal(r.end, mid);
    const again = readAppended(file, r.end);
    assert.deepEqual(again, { entries: [], end: mid });
  });
  test('a truncated file is read from 0', () => {
    const file = path.join(TMP, 'trunc.jsonl');
    fs.writeFileSync(file, line({ type: 'user', uuid: 'x', message: { content: 'fresh' } }));
    const r = readAppended(file, 999999);
    assert.deepEqual(r.entries.map((e) => e.id), ['x:0']);
  });
  test('hasUserTextAfter', () => {
    const text = fs.readFileSync(SAMPLE, 'utf8');
    const before = Buffer.byteLength(text.slice(0, text.indexOf('"uuid":"u9"')).slice(0, text.slice(0, text.indexOf('"uuid":"u9"')).lastIndexOf('\n') + 1));
    const afterIt = Buffer.byteLength(text.slice(0, text.indexOf('\n', text.indexOf('"uuid":"u9"')) + 1));
    assert.equal(hasUserTextAfter(SAMPLE, before, 'yes, option B'), true);
    assert.equal(hasUserTextAfter(SAMPLE, before, '  yes,   option B '), true);
    assert.equal(hasUserTextAfter(SAMPLE, afterIt, 'yes, option B'), false);
    assert.equal(hasUserTextAfter(SAMPLE, 0, '12 tests passed'), true);   // tool_result content
    assert.equal(hasUserTextAfter(SAMPLE, 0, 'not in the file'), false);
  });
});

describe('createTailer', () => {
  test('delivers appended entries and advances end; stop clears', async () => {
    const file = completeCopy('tail.jsonl');
    const from = fs.statSync(file).size;
    const tailer = createTailer({ intervalMs: 20, log: () => {} });
    const got = new Promise<{ entries: MessageEntry[]; end: number }>((resolve) => {
      tailer.subscribe('c1', file, from, (entries, end) => resolve({ entries, end }));
    });
    fs.appendFileSync(file, line({ type: 'user', uuid: 'live', message: { content: 'live msg' } }));
    const r = await Promise.race([got, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
    assert.deepEqual(r.entries.map((e) => e.id), ['live:0']);
    assert.equal(r.end, fs.statSync(file).size);
    tailer.stop();
  });
  test('missing file logs once and keeps waiting; resubscribe replaces', async () => {
    const logs: string[] = [];
    const file = path.join(TMP, 'later.jsonl');
    const tailer = createTailer({ intervalMs: 15, log: (m) => logs.push(m) });
    let first = 0;
    tailer.subscribe('c2', file, 0, () => { first++; });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(logs.length, 1);
    const got = new Promise<string[]>((resolve) => tailer.subscribe('c2', file, 0, (e) => resolve(e.map((x) => x.id))));
    fs.writeFileSync(file, line({ type: 'user', uuid: 'late', message: { content: 'late' } }));
    assert.deepEqual(await got, ['late:0']);
    assert.equal(first, 0);
    tailer.unsubscribe('c2');
    tailer.stop();
  });
});


test('a slash command shows as the user typed it, not as CLI markup', () => {
  const { readableUserText } = require('./transcript-tailer');
  const raw = '<command-message>voice-task</command-message>\n<command-name>/voice-task</command-name>\n<command-args>sprawdź faktury\n\nspokenAt: 2026-10-28T10:00:00Z</command-args>';
  assert.equal(readableUserText(raw), '/voice-task sprawdź faktury');
  assert.equal(readableUserText('plain words'), 'plain words');
  const line = JSON.stringify({ type: 'user', uuid: 'u1', timestamp: 't', message: { role: 'user', content: raw } });
  const entries = entriesFromJsonl([line]);
  assert.equal(entries[0].text.startsWith('/voice-task sprawdź'), true);
});
