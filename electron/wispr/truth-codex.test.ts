import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseCodexLine, createCodexTruth, codexDayDirs, codexSessionId } from './truth-codex';

const UUID = '0199a2b3-4c5d-7e6f-8a9b-0c1d2e3f4a5b';

const userLine = (at: number, text: string): string =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), ordinal: 8, type: 'response_item', payload: { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text }] } });

// Local-time midnight of a calendar day — day dirs are local dates.
const localDay = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime();
const pad = (n: number): string => String(n).padStart(2, '0');

describe('parseCodexLine', () => {
  it('parses the real shape and strips the attachment footer', () => {
    const line = '{"timestamp":"2026-10-02T13:56:20.470Z","ordinal":8,"type":"response_item","payload":{"type":"message","id":"msg_1","role":"user","content":[{"type":"input_text","text":"[Image #1] mógłbyś przygotować drafty?\\n\\nI attached 1 image; each [Image #n] marker in the text above shows where that image belongs. The images are available at these absolute paths:\\n[Image #1] /Users/demo/x.png"}]}}';
    assert.deepEqual(parseCodexLine(line, UUID), {
      at: Date.parse('2026-10-02T13:56:20.470Z'),
      text: 'mógłbyś przygotować drafty?',
      source: 'codex',
      sessionId: UUID,
    });
  });
  it('rejects injected tag-led content, assistant role, other item types, bad JSON', () => {
    assert.equal(parseCodexLine('{"timestamp":"2026-10-02T13:56:20.470Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<recommended_plugins>x</recommended_plugins>"}]}}', UUID), null);
    assert.equal(parseCodexLine(JSON.stringify({ timestamp: '2026-10-02T13:56:20.470Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] } }), UUID), null);
    assert.equal(parseCodexLine(JSON.stringify({ timestamp: '2026-10-02T13:56:20.470Z', type: 'event_msg', payload: { type: 'user_message', role: 'user', message: 'hi there' } }), UUID), null);
    assert.equal(parseCodexLine('{"role":"user", nope', UUID), null);
  });
  it('session id comes from the rollout file name', () => {
    assert.equal(codexSessionId(`/x/rollout-2026-10-02T13-56-20-${UUID}.jsonl`), UUID);
  });
});

describe('codexDayDirs', () => {
  it('covers day(from) - 1 through day(to) in local dates', () => {
    const dirs = codexDayDirs('/r', localDay(2026, 3, 1, 9), localDay(2026, 3, 2, 18));
    assert.deepEqual(dirs, [path.join('/r', '2026', '02', '28'), path.join('/r', '2026', '03', '01'), path.join('/r', '2026', '03', '02')]);
  });
});

describe('createCodexTruth', () => {
  let root = '';
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-truth-')); });
  afterEach(() => { fs.rmSync(path.resolve(root), { recursive: true, force: true }); });

  const seed = (y: number, m: number, d: number, uuid: string, lines: string[]): string => {
    const dir = path.join(root, String(y), pad(m), pad(d));
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `rollout-${y}-${pad(m)}-${pad(d)}T10-00-00-${uuid}.jsonl`);
    fs.writeFileSync(f, lines.map((l) => l + '\n').join(''));
    return f;
  };

  it('reads only the day dirs of the window (plus the day before)', async () => {
    const from = localDay(2026, 10, 22, 0);
    const to = localDay(2026, 10, 22, 23);
    const inWin = localDay(2026, 10, 22, 10);
    // Started yesterday, still being written into today's window.
    seed(2026, 10, 21, '11111111-1111-1111-1111-111111111111', [userLine(inWin, 'from yesterday dir')]);
    seed(2026, 10, 22, UUID, [userLine(inWin + 1000, 'today')]);
    // Two days back: outside the dir window even though its content is in range.
    const far = seed(2026, 10, 20, '22222222-2222-2222-2222-222222222222', [userLine(inWin + 2000, 'too far')]);
    const src = createCodexTruth({ sessionsRoot: root });
    const out = await src.readMessages(from, to);
    assert.deepEqual(out.map((m) => m.text), ['from yesterday dir', 'today']);
    assert.equal(out[1].sessionId, UUID);
    assert.equal(src.__stats().offsets[far], undefined);
  });

  it('reads appended lines incrementally', async () => {
    const at = Date.now();
    const d = new Date(at);
    const f = seed(d.getFullYear(), d.getMonth() + 1, d.getDate(), UUID, [userLine(at - 1000, 'one')]);
    const src = createCodexTruth({ sessionsRoot: root });
    assert.equal((await src.readMessages(at - 60_000, at + 60_000)).length, 1);
    const before = src.__stats().bytesRead;
    const added = userLine(at, 'two') + '\n';
    fs.appendFileSync(f, added);
    assert.deepEqual((await src.readMessages(at - 60_000, at + 60_000)).map((m) => m.text), ['one', 'two']);
    assert.equal(src.__stats().bytesRead - before, Buffer.byteLength(added));
  });

  it('missing root yields nothing', async () => {
    const src = createCodexTruth({ sessionsRoot: path.join(root, 'no-codex') });
    assert.deepEqual(await src.readMessages(Date.now() - 1000, Date.now()), []);
  });
});
