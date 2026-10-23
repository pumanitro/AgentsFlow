import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TruthSource, UserMessage } from './types';
import { cleanUserText, createIncrementalTruth, readAllMessages } from './truth-sources';

const msg = (at: number, text: string, source: UserMessage['source'] = 'claude'): UserMessage => ({ at, text, source, sessionId: 's' });

describe('cleanUserText', () => {
  it('rejects empty, tag-led and interrupt markers', () => {
    assert.equal(cleanUserText('   '), null);
    assert.equal(cleanUserText('<command-name>/clear</command-name>'), null);
    assert.equal(cleanUserText('  <local-command-stdout>x</local-command-stdout>'), null);
    assert.equal(cleanUserText('[Request interrupted by user]'), null);
  });
  it('strips system reminders and image markers, collapses whitespace', () => {
    assert.equal(cleanUserText('fix it <system-reminder>\nignore\n</system-reminder>  now\n\tplease'), 'fix it now please');
    assert.equal(cleanUserText('[Image #1] look at [Image #12] this'), 'look at this');
  });
  it('drops pasted blocks and leftover tags, keeps the dictated words', () => {
    assert.equal(
      cleanUserText('look at this <pasted_content id="a1b2">npm ERR! code_foo\nstack</pasted_content> and fix it'),
      'look at this and fix it',
    );
    assert.equal(cleanUserText('see <task-notification> above</task-notification> please'), 'see above please');
  });

  it('cuts the attachment footer', () => {
    assert.equal(
      cleanUserText('[Image #1] mógłbyś przygotować drafty?\n\nI attached 1 image; each [Image #n] marker…\n[Image #1] /Users/demo/x.png'),
      'mógłbyś przygotować drafty?',
    );
  });
  it('rejects results shorter than 2 chars', () => {
    assert.equal(cleanUserText('[Image #1] k'), null);
    assert.equal(cleanUserText('ok'), 'ok');
  });
});

describe('readAllMessages', () => {
  it('merges and sorts, surviving a throwing source', async () => {
    const a: TruthSource = { name: 'claude', readMessages: async () => [msg(30, 'c'), msg(10, 'a')] };
    const b: TruthSource = { name: 'codex', readMessages: async () => [msg(20, 'b', 'codex')] };
    const bad: TruthSource = { name: 'codex', readMessages: async () => { throw new Error('boom'); } };
    const realWarn = console.warn;
    const warns: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warns.push(args); };
    try {
      const out = await readAllMessages([a, bad, b], 0, 100);
      assert.deepEqual(out.map((m) => m.text), ['a', 'b', 'c']);
      assert.equal(warns.length, 1);
    } finally {
      console.warn = realWarn;
    }
  });
});

describe('createIncrementalTruth', () => {
  let root = '';
  afterEach(() => {
    if (root) fs.rmSync(path.resolve(root), { recursive: true, force: true });
    root = '';
  });

  it('keeps multi-byte characters intact across a partial-line carry', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-truth-'));
    const file = path.join(root, 'a.txt');
    const full = Buffer.from('1|Słuchaj łódź\n', 'utf8');
    // Cut inside the 2-byte "ł" of "łódź".
    const cut = full.indexOf(Buffer.from('ł', 'utf8'), 10) + 1;
    fs.writeFileSync(file, full.subarray(0, cut));
    const src = createIncrementalTruth({
      name: 'claude',
      listFiles: async () => [file],
      parseLine: (line) => { const [at, text] = line.split('|'); return msg(Number(at), text); },
    });
    assert.deepEqual(await src.readMessages(0, 10), []);
    fs.appendFileSync(file, full.subarray(cut));
    assert.deepEqual((await src.readMessages(0, 10)).map((m) => m.text), ['Słuchaj łódź']);
  });

  it('prunes buffered messages older than from - retainMs', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-truth-'));
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, '1000|old\n5000|new\n');
    const src = createIncrementalTruth({
      name: 'claude',
      retainMs: 1000,
      listFiles: async () => [file],
      parseLine: (line) => { const [at, text] = line.split('|'); return msg(Number(at), text); },
    });
    assert.equal((await src.readMessages(0, 10_000)).length, 2);
    assert.equal(src.__stats().buffered, 2);
    await src.readMessages(4000, 10_000);
    assert.equal(src.__stats().buffered, 1);
  });
});
