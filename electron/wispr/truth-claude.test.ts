import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseClaudeLine, createClaudeTruth } from './truth-claude';

const SID = '9cc56010-9dc0-4fee-ae2f-3480b15437a3';
const T0 = Date.parse('2026-10-23T08:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const human = (at: number, text: string, sessionId = SID): string =>
  JSON.stringify({ type: 'user', timestamp: iso(at), cwd: '/Users/demo/Desktop/App', sessionId, message: { role: 'user', content: text } });
const toolResult = (at: number): string =>
  JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'output' }] } });
const withReminder = (at: number, text: string): string =>
  JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text }] } });
const reminderOnly = (at: number): string =>
  JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] } });
const assistant = (at: number): string =>
  JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }] } });

describe('parseClaudeLine', () => {
  it('parses a plain human turn', () => {
    const line = '{"type":"user","timestamp":"2026-10-23T08:16:01.870Z","cwd":"/Users/demo/Desktop/App","sessionId":"9cc56010-9dc0-4fee-ae2f-3480b15437a3","message":{"role":"user","content":"Słuchaj, wydaje mi się, że Wispr Flow nie widzi moich zmian"}}';
    assert.deepEqual(parseClaudeLine(line, 'fallback'), {
      at: Date.parse('2026-10-23T08:16:01.870Z'),
      text: 'Słuchaj, wydaje mi się, że Wispr Flow nie widzi moich zmian',
      source: 'claude',
      sessionId: SID,
    });
  });
  it('rejects tool results, reminder-only turns, meta turns, assistant lines, bad JSON', () => {
    assert.equal(parseClaudeLine(toolResult(T0), 'f'), null);
    assert.equal(parseClaudeLine(reminderOnly(T0), 'f'), null);
    assert.equal(parseClaudeLine(JSON.stringify({ type: 'user', isMeta: true, timestamp: iso(T0), message: { content: 'Caveat: hi' } }), 'f'), null);
    assert.equal(parseClaudeLine(assistant(T0), 'f'), null);
    assert.equal(parseClaudeLine('{"type":"user", broken', 'f'), null);
    assert.equal(parseClaudeLine(JSON.stringify({ type: 'user', timestamp: 'nope', message: { content: 'hello' } }), 'f'), null);
  });
  it('rejects compaction summaries, peer-origin turns and teammate messages', () => {
    const base = { type: 'user', timestamp: iso(T0), sessionId: SID };
    assert.equal(parseClaudeLine(JSON.stringify({ ...base, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: 'This session is being continued from a previous conversation' } }), 'f'), null);
    assert.equal(parseClaudeLine(JSON.stringify({ ...base, origin: { kind: 'peer', name: 'stage b' }, message: { content: 'OWNER ASKS TO PAUSE run now' } }), 'f'), null);
    assert.equal(parseClaudeLine(JSON.stringify({ ...base, message: { content: 'Another Claude session sent a message:\n<teammate-message teammate_id="planner">x</teammate-message>' } }), 'f'), null);
    assert.equal(parseClaudeLine(JSON.stringify({ ...base, origin: { kind: 'human' }, message: { content: 'where are we?' } }), 'f')?.text, 'where are we?');
  });
  it('keeps the human text next to a reminder and falls back to the file session id', () => {
    const m = parseClaudeLine(withReminder(T0, 'continue with the plan'), 'from-file');
    assert.equal(m?.text, 'continue with the plan');
    assert.equal(m?.sessionId, 'from-file');
  });
});

describe('createClaudeTruth', () => {
  let root = '';
  let proj = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-truth-'));
    proj = path.join(root, '-Users-demo-Desktop-App');
    fs.mkdirSync(proj);
  });
  afterEach(() => {
    fs.rmSync(path.resolve(root), { recursive: true, force: true });
  });

  const write = (name: string, lines: string[], mtimeMs = Date.now()): string => {
    const f = path.join(proj, name);
    fs.writeFileSync(f, lines.map((l) => l + '\n').join(''));
    fs.utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
    return f;
  };

  it('returns human messages only, sorted, and ignores deeper dirs', async () => {
    write(`${SID}.jsonl`, [human(T0 + 2000, 'second'), toolResult(T0 + 2500), assistant(T0 + 2600), reminderOnly(T0 + 2700), withReminder(T0 + 1000, 'first')]);
    fs.mkdirSync(path.join(proj, SID, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(proj, SID, 'subagents', 'agent-1.jsonl'), human(T0 + 1500, 'from a subagent') + '\n');
    const src = createClaudeTruth({ projectsRoot: root });
    const out = await src.readMessages(T0, T0 + 10_000);
    assert.deepEqual(out.map((m) => m.text), ['first', 'second']);
    assert.equal(out[0].sessionId, SID);
  });

  it('second read returns old + new and reads only the appended bytes', async () => {
    const f = write(`${SID}.jsonl`, [human(T0 + 1000, 'one'), toolResult(T0 + 1100)]);
    const src = createClaudeTruth({ projectsRoot: root });
    assert.deepEqual((await src.readMessages(T0, T0 + 10_000)).map((m) => m.text), ['one']);
    const before = src.__stats().bytesRead;
    const added = human(T0 + 2000, 'two') + '\n';
    fs.appendFileSync(f, added);
    assert.deepEqual((await src.readMessages(T0, T0 + 10_000)).map((m) => m.text), ['one', 'two']);
    assert.equal(src.__stats().bytesRead - before, Buffer.byteLength(added));
    assert.equal(src.__stats().offsets[f], fs.statSync(f).size);
  });

  it('never opens a file whose mtime is older than from', async () => {
    const f = write('old.jsonl', [human(T0 - 5000, 'stale')], T0 - 60_000);
    const src = createClaudeTruth({ projectsRoot: root });
    assert.deepEqual(await src.readMessages(T0, T0 + 10_000), []);
    assert.equal(src.__stats().opened, 0);
    assert.equal(src.__stats().offsets[f], undefined);
  });

  it('re-reads a truncated/rewritten file from 0', async () => {
    const f = write(`${SID}.jsonl`, [human(T0 + 1000, 'one long original message'), human(T0 + 2000, 'two')]);
    const src = createClaudeTruth({ projectsRoot: root });
    assert.equal((await src.readMessages(T0, T0 + 10_000)).length, 2);
    fs.writeFileSync(f, human(T0 + 3000, 'rewritten') + '\n');
    const out = await src.readMessages(T0, T0 + 10_000);
    // Earlier turns stay buffered (still in the window); the rewrite is read whole.
    assert.deepEqual(out.map((m) => m.text), ['one long original message', 'two', 'rewritten']);
    assert.equal(src.__stats().offsets[f], fs.statSync(f).size);
  });

  it('carries a partial last line over to the next read', async () => {
    const f = path.join(proj, `${SID}.jsonl`);
    const line = human(T0 + 1000, 'half written');
    fs.writeFileSync(f, line.slice(0, 40));
    const src = createClaudeTruth({ projectsRoot: root });
    assert.deepEqual(await src.readMessages(T0, T0 + 10_000), []);
    fs.appendFileSync(f, line.slice(40) + '\n');
    assert.deepEqual((await src.readMessages(T0, T0 + 10_000)).map((m) => m.text), ['half written']);
  });

  it('filters by window and dedupes', async () => {
    write(`${SID}.jsonl`, [human(T0 - 1000, 'before'), human(T0 + 1000, 'inside'), human(T0 + 1000, 'inside'), human(T0 + 20_000, 'after')]);
    const src = createClaudeTruth({ projectsRoot: root });
    assert.deepEqual((await src.readMessages(T0, T0 + 10_000)).map((m) => m.text), ['inside']);
  });

  it('missing root yields nothing', async () => {
    const src = createClaudeTruth({ projectsRoot: path.join(root, 'nope') });
    assert.deepEqual(await src.readMessages(T0, T0 + 10_000), []);
  });
});
