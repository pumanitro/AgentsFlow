import { strict as assert } from 'node:assert';
import { after, describe, test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Conversation } from '../../shared/types';
import type { ConversationSummary, FeedItem, JobSlice } from '../../shared/mobile';
import { createFeedStore, createOutcomeWatcher, extractOutcome } from './outcomes';
import { entriesFromJsonl } from './transcript-tailer';

const FIXTURES = path.resolve(__dirname, '../../../../electron/mobile/fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wp11-outcomes-'));
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('extractOutcome', () => {
  test('fixture last message: spoken + needs', () => {
    const entries = entriesFromJsonl(fs.readFileSync(path.join(FIXTURES, 'transcript-sample.jsonl'), 'utf8').split('\n'));
    const last = entries[entries.length - 1];
    assert.deepEqual(extractOutcome(last.text), {
      spoken: 'Faktury za wrzesień poszły do księgowej, trzy z nich czekają na podpis.',
      needs: 'podpisz 3 faktury w KSeF',
    });
  });
  test('spoken newlines flattened, capped at 600, no needs key', () => {
    const r = extractOutcome('x <spoken>\n line one\nline two \n</spoken>');
    assert.deepEqual(r, { spoken: 'line one line two' });
    assert.ok(extractOutcome(`<spoken>${'a'.repeat(900)}</spoken>`).spoken.length <= 600);
  });
  test('tag-less two-paragraph text: two sentences without the path', () => {
    const text = 'I fixed the **parser** in /Users/x/Desktop/app/src/parser.ts. All 40 tests pass now!\n\n'
      + 'See https://example.com/run/1 for the log. Next I would refactor the reader.\n\n```ts\nconst x = 1;\n```';
    const r = extractOutcome(text);
    assert.equal(r.spoken, 'I fixed the parser in. All 40 tests pass now!');
    assert.equal(r.needs, undefined);
    assert.ok(!r.spoken.includes('/Users'));
  });
  test('fallback capped at 300 and handles text without punctuation', () => {
    assert.ok(extractOutcome('word '.repeat(200)).spoken.length <= 300);
    assert.equal(extractOutcome('just a note').spoken, 'just a note');
  });
});

describe('createFeedStore', () => {
  test('seq continues after reload; trims to max; after() ascending', () => {
    const file = path.join(TMP, 'feed.json');
    const a = createFeedStore(file, 3);
    for (let i = 0; i < 5; i++) {
      a.append({ kind: 'outcome', conversationId: 'c', title: 't', peerName: 'p', at: 'x', spoken: 's' + i, messageId: 'm' + i } as Omit<FeedItem, 'seq'>);
    }
    assert.equal(a.latestSeq(), 5);
    assert.deepEqual(a.after(0).map((i) => i.seq), [3, 4, 5]);
    assert.deepEqual(a.after(4).map((i) => i.seq), [5]);
    a.flushSync();
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.version, 1);
    assert.equal(disk.seq, 5);
    const b = createFeedStore(file, 3);
    assert.equal(b.latestSeq(), 5);
    assert.equal(b.append({ kind: 'outcome', conversationId: 'c', title: 't', peerName: 'p', at: 'x', spoken: 'n', messageId: 'mn' } as Omit<FeedItem, 'seq'>).seq, 6);
    b.flushSync();
    assert.equal(createFeedStore(file).latestSeq(), 6);
  });
  test('corrupt file starts empty', () => {
    const file = path.join(TMP, 'bad.json');
    fs.writeFileSync(file, 'nope');
    const s = createFeedStore(file);
    assert.equal(s.latestSeq(), 0);
    assert.deepEqual(s.after(0), []);
  });
});

function sum(id: string, state: ConversationSummary['state']): ConversationSummary {
  return {
    id, peerId: 'd1', peerName: 'LISA', title: 'Invoices', detail: '', state, rawState: state, needsYou: state === 'blocked',
    pinned: true, provider: 'claude', chatKind: 'chat', createdAt: '2026-10-28T09:00:00.000Z', updatedAt: '2026-10-28T09:00:00.000Z', hasSession: true,
  };
}
const CONVS = [{ id: 'c1' }, { id: 'c2' }] as Conversation[];
const SLICE: JobSlice = {
  state: 'blocked', rawState: 'working', detail: 'Which option?', needs: 'Which option?', suggestedReply: 'commit and push it',
  questions: [{ id: 'q0', question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }] }],
  inFlight: { tasks: 0, queued: 0, kinds: [] }, timeline: [],
};

function watcher(last: { text: string; at: string; uuid: string } | null) {
  const feed = createFeedStore(path.join(TMP, `w-${Math.random()}.json`));
  const items: FeedItem[] = [];
  const reads: string[] = [];
  const w = createOutcomeWatcher({
    feed, onItem: (i) => items.push(i), log: () => {},
    readLastAssistant: (c) => { reads.push(c.id); return last; },
  });
  return { w, items, reads, feed };
}

describe('createOutcomeWatcher', () => {
  test('working → working → done emits one outcome; a second done tick emits nothing', () => {
    const { w, items } = watcher({ text: '<spoken>Gotowe.</spoken><needs>sprawdź</needs>', at: '2026-10-28T10:00:00.000Z', uuid: 'a9' });
    const none = () => null;
    w.tick([sum('c1', 'working')], CONVS, none);
    w.tick([sum('c1', 'working')], CONVS, none);
    assert.equal(items.length, 0);
    w.tick([sum('c1', 'done')], CONVS, none);
    assert.equal(items.length, 1);
    const it = items[0];
    assert.equal(it.kind, 'outcome');
    if (it.kind !== 'outcome') return;
    assert.equal(it.spoken, 'Gotowe.');
    assert.equal(it.needs, 'sprawdź');
    assert.equal(it.messageId, 'a9');
    assert.equal(it.conversationId, 'c1');
    assert.equal(it.at, '2026-10-28T10:00:00.000Z');
    assert.equal(it.seq, 1);
    w.tick([sum('c1', 'done')], CONVS, none);
    assert.equal(items.length, 1);
    // A new turn ending on the SAME last message is not announced twice.
    w.tick([sum('c1', 'working')], CONVS, none);
    w.tick([sum('c1', 'done')], CONVS, none);
    assert.equal(items.length, 1);
  });
  test('first tick only seeds', () => {
    const { w, items, reads } = watcher({ text: 'x', at: '', uuid: 'u' });
    w.tick([sum('c1', 'done'), sum('c2', 'blocked')], CONVS, () => SLICE);
    assert.equal(items.length, 0);
    assert.equal(reads.length, 0);
    w.tick([sum('c1', 'done'), sum('c2', 'blocked')], CONVS, () => SLICE);
    assert.equal(items.length, 0);
  });
  test('blocked transition emits one needs-you; same question again emits nothing; new question emits', () => {
    const { w, items } = watcher(null);
    w.tick([sum('c2', 'working')], CONVS, () => null);
    w.tick([sum('c2', 'blocked')], CONVS, () => SLICE);
    assert.equal(items.length, 1);
    const it = items[0];
    assert.equal(it.kind, 'needs-you');
    if (it.kind !== 'needs-you') return;
    assert.equal(it.questions.length, 1);
    assert.equal(it.suggestedReply, 'commit and push it');
    assert.equal(it.needs, 'Which option?');
    w.tick([sum('c2', 'blocked')], CONVS, () => SLICE);
    assert.equal(items.length, 1);
    w.tick([sum('c2', 'blocked')], CONVS, () => ({ ...SLICE, questions: [{ id: 'q0', question: 'Ship it?', options: [] }] }));
    assert.equal(items.length, 2);
  });
  test('blocked → done also emits an outcome; vanished rows are forgotten', () => {
    const { w, items } = watcher({ text: 'Zrobione. Wszystko działa.', at: '', uuid: 'z1' });
    w.tick([sum('c1', 'blocked')], CONVS, () => SLICE);
    w.tick([sum('c1', 'done')], CONVS, () => null);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind === 'outcome' && items[0].spoken, 'Zrobione. Wszystko działa.');
    assert.ok(items[0].at.length > 0);
    w.tick([], CONVS, () => null);
    // c1 reappears blocked after being forgotten: treated as a fresh transition.
    w.tick([sum('c1', 'blocked')], CONVS, () => SLICE);
    assert.equal(items.length, 2);
    assert.equal(items[1].kind, 'needs-you');
  });
});
