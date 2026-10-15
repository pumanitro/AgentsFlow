import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyAnswer,
  applyTodo,
  buildNotificationFromArgs,
  buildRunWarning,
  describeForTool,
  dismissNotification,
  formatAnswersMessage,
  markRead,
  shouldShowSystemNotification,
  type NotifyContext,
} from './notifications-mcp';
import { createNotificationsStore } from './notifications-store';
import { canDismiss, countsOf, missingForDismiss, type UserNotification } from '../shared/notifications';
import type { Routine, RoutineRun } from '../shared/routines';

const NOW = '2026-10-15T09:00:00.000Z';
const LATER = '2026-10-15T10:00:00.000Z';
const HOME = '/Users/demo';
const PEER_DIR = '/Users/demo/Desktop/LISA';

const ctx: NotifyContext = {
  id: 'n-1',
  now: NOW,
  source: { kind: 'routine', conversationId: 'conv-1', conversationTitle: 'Abilitie timesheet · 15 Oct 09:00', peerName: 'LISA', routineName: 'Abilitie timesheet' },
  resolvePath: (p) => (p.startsWith('~/') ? path.join(HOME, p.slice(2)) : path.isAbsolute(p) ? path.normalize(p) : path.join(PEER_DIR, p)),
};

// The C2 example the LISA routine sends, verbatim.
const LISA = {
  title: 'Abilitie timesheet (1–15 Oct) is ready — needs you',
  level: 'action',
  body: "I prepared the timesheet PDF from this month's commits. Check it, answer the questions below, then send the email to Abilitie yourself.",
  files: [{ path: '~/Desktop/LISA/timesheets/2026-10-abilitie-timesheet.pdf', label: 'October timesheet (PDF)' }],
  questions: [
    { id: 'dayoffs', text: 'Any days off between 1 and 15 October that I should take out?', kind: 'yesno', hint: 'I found none in your calendar.' },
    { id: 'delegated', text: 'Did you hand any of this work to someone else?', kind: 'yesno' },
    { id: 'vacation', text: 'I marked 3 Oct and 10 Oct as vacation — is that right?', kind: 'choice', choices: ['Yes, both', 'Only 3 Oct', 'Only 10 Oct', 'Neither'] },
    { id: 'edits', text: 'Any changes to descriptions or hours before I finalize?', kind: 'text' },
  ],
  todos: [{ text: 'Send the timesheet email to Abilitie yourself — the agent never sends email' }],
};

const lisa = () => buildNotificationFromArgs(LISA, ctx);
const err = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return null; };

describe('buildNotificationFromArgs', () => {
  it('builds the LISA timesheet notice: 4 questions with their ids, 1 to-do, the file resolved from ~', () => {
    const n = lisa();
    assert.equal(n.id, 'n-1');
    assert.equal(n.level, 'action');
    assert.equal(n.title, LISA.title);
    assert.equal(n.body, LISA.body);
    assert.equal(n.createdAt, NOW);
    assert.deepEqual(n.source, ctx.source);
    assert.deepEqual(n.files, [{ path: '/Users/demo/Desktop/LISA/timesheets/2026-10-abilitie-timesheet.pdf', label: 'October timesheet (PDF)' }]);
    assert.deepEqual(n.questions.map((q) => [q.id, q.kind]), [['dayoffs', 'yesno'], ['delegated', 'yesno'], ['vacation', 'choice'], ['edits', 'text']]);
    assert.equal(n.questions[0].hint, 'I found none in your calendar.');
    assert.deepEqual(n.questions[2].choices, ['Yes, both', 'Only 3 Oct', 'Only 10 Oct', 'Neither']);
    assert.deepEqual(n.todos, [{ id: 't1', text: LISA.todos[0].text, done: false }]);
    assert.equal(n.readAt, undefined);
    assert.equal(n.dismissedAt, undefined);
  });

  it('defaults ids to q1..qN, de-duplicates given ids, trims strings, resolves relative paths against the peer', () => {
    const n = buildNotificationFromArgs({
      title: '  Hello  ', level: 'action',
      files: [{ path: 'out/report.pdf' }, { path: '/tmp/../tmp/x.txt' }],
      questions: [{ text: ' A ', kind: 'text' }, { id: 'x', text: 'B', kind: 'yesno' }, { id: 'x', text: 'C', kind: 'yesno' }, { text: 'D', kind: 'text' }],
      todos: [{ text: 'one' }, { text: ' two ' }],
    }, ctx);
    assert.equal(n.title, 'Hello');
    assert.equal(n.body, undefined);
    assert.deepEqual(n.files, [{ path: '/Users/demo/Desktop/LISA/out/report.pdf' }, { path: '/tmp/x.txt' }]);
    assert.deepEqual(n.questions.map((q) => [q.id, q.text]), [['q1', 'A'], ['x', 'B'], ['x-2', 'C'], ['q4', 'D']]);
    assert.deepEqual(n.todos.map((t) => [t.id, t.text]), [['t1', 'one'], ['t2', 'two']]);
  });

  it('rejects bad arguments with one human line', () => {
    assert.equal(err(() => buildNotificationFromArgs({ level: 'warn' }, ctx)), '`title` is required');
    assert.equal(err(() => buildNotificationFromArgs({ title: '   ', level: 'warn' }, ctx)), '`title` is required');
    assert.equal(err(() => buildNotificationFromArgs({ title: 't', level: 'info' }, ctx)), 'level must be "warn" or "action"');
    assert.equal(err(() => buildNotificationFromArgs({ title: 't' }, ctx)), 'level must be "warn" or "action"');
    assert.equal(err(() => buildNotificationFromArgs({ title: 'x'.repeat(300), level: 'warn' }, ctx)), '`title` is longer than 200 characters');
    assert.equal(err(() => buildNotificationFromArgs({ title: 't', level: 'action', questions: [{ text: 'a', kind: 'yesno' }, { text: 'b', kind: 'yesno' }, { text: 'Which?', kind: 'choice', choices: ['only'] }] }, ctx)), 'question 3: kind "choice" needs 2 to 12 choices');
    assert.equal(err(() => buildNotificationFromArgs({ title: 't', level: 'action', questions: Array.from({ length: 21 }, () => ({ text: 'q', kind: 'text' })) }, ctx)), 'at most 20 questions');
    assert.equal(err(() => buildNotificationFromArgs({ title: 't', level: 'action', questions: [{ text: 'q', kind: 'slider' }] }, ctx)), 'question 1: kind must be "yesno", "choice" or "text"');
    assert.equal(err(() => buildNotificationFromArgs({ title: 't', level: 'action', files: [{ label: 'x' }] }, ctx)), 'file 1: `path` is required');
    assert.equal(err(() => buildNotificationFromArgs({ title: 't', level: 'action', todos: Array.from({ length: 21 }, () => ({ text: 'x' })) }, ctx)), 'at most 20 todos');
    assert.equal(err(() => buildNotificationFromArgs({ title: 't', level: 'warn', questions: [{ text: 'q', kind: 'text' }] }, ctx)), 'questions and to-dos need level "action"');
    assert.equal(err(() => buildNotificationFromArgs('nope', ctx)), 'notify needs an object of arguments');
  });

  it('describeForTool is the C2 success envelope', () => {
    assert.deepEqual(describeForTool(lisa()), {
      status: 'success', id: 'n-1', level: 'action', title: LISA.title, questions: 4, todos: 1, files: 1,
      note: 'The user will see this in the bell. Answers arrive in this chat as a new message — end your turn now.',
    });
  });
});

describe('applyAnswer', () => {
  it('yesno: case-insensitive, stored lower-case', () => {
    const n = applyAnswer(lisa(), 'dayoffs', ' YES ', LATER);
    assert.equal(n.questions[0].answer, 'yes');
    assert.equal(n.questions[0].answeredAt, LATER);
    assert.equal(applyAnswer(n, 'dayoffs', 'No', LATER).questions[0].answer, 'no');
    assert.equal(err(() => applyAnswer(n, 'dayoffs', 'maybe', LATER)), 'answer "yes" or "no"');
  });

  it('choice: must be one of the choices', () => {
    assert.equal(applyAnswer(lisa(), 'vacation', 'Only 10 Oct', LATER).questions[2].answer, 'Only 10 Oct');
    assert.equal(err(() => applyAnswer(lisa(), 'vacation', 'Only 11 Oct', LATER)), 'pick one of: Yes, both, Only 3 Oct, Only 10 Oct, Neither');
  });

  it('text: trimmed, 1..4000 characters', () => {
    assert.equal(applyAnswer(lisa(), 'edits', '  none  ', LATER).questions[3].answer, 'none');
    assert.equal(err(() => applyAnswer(lisa(), 'edits', '   ', LATER)), 'the answer is empty');
    assert.equal(err(() => applyAnswer(lisa(), 'edits', 'x'.repeat(4001), LATER)), 'the answer is longer than 4000 characters');
    assert.equal(applyAnswer(lisa(), 'edits', 'x'.repeat(4000), LATER).questions[3].answer?.length, 4000);
  });

  it('an unknown question id throws', () => {
    assert.equal(err(() => applyAnswer(lisa(), 'nope', 'yes', LATER)), 'question "nope" not found');
  });

  it('never mutates the notice it was given', () => {
    const n = lisa();
    applyAnswer(n, 'dayoffs', 'yes', LATER);
    assert.equal(n.questions[0].answer, undefined);
  });
});

describe('to-dos, read, dismiss', () => {
  it('applyTodo ticks and unticks with doneAt; unknown id throws', () => {
    const on = applyTodo(lisa(), 't1', true, LATER);
    assert.deepEqual(on.todos[0], { id: 't1', text: LISA.todos[0].text, done: true, doneAt: LATER });
    assert.deepEqual(applyTodo(on, 't1', false, LATER).todos[0], { id: 't1', text: LISA.todos[0].text, done: false });
    assert.equal(err(() => applyTodo(lisa(), 't9', true, LATER)), 'to-do "t9" not found');
  });

  it('markRead sets readAt once', () => {
    const r = markRead(lisa(), NOW);
    assert.equal(markRead(r, LATER).readAt, NOW);
  });

  it('Dismiss unlocks only after every question is answered, every to-do ticked and the answers were sent', () => {
    let n = lisa();
    assert.deepEqual(missingForDismiss(n), ['4 questions unanswered', '1 to-do not ticked']);
    assert.equal(err(() => dismissNotification(n, LATER)), '4 questions unanswered, 1 to-do not ticked');
    n = applyAnswer(n, 'dayoffs', 'no', LATER);
    n = applyAnswer(n, 'delegated', 'no', LATER);
    n = applyAnswer(n, 'vacation', 'Only 10 Oct', LATER);
    assert.deepEqual(missingForDismiss(n), ['1 question unanswered', '1 to-do not ticked']);
    n = applyAnswer(n, 'edits', 'none', LATER);
    assert.deepEqual(missingForDismiss(n), ['1 to-do not ticked', 'answers not sent to the agent yet']);
    n = applyTodo(n, 't1', true, LATER);
    assert.deepEqual(missingForDismiss(n), ['answers not sent to the agent yet']);
    assert.equal(canDismiss(n), false);
    // A failed delivery the user has seen still unlocks Dismiss.
    const failed = { ...n, answersDelivery: { at: LATER, ok: false, error: 'the chat no longer exists' } };
    assert.equal(canDismiss(failed), true);
    const sent = { ...n, answersDelivery: { at: LATER, ok: true, via: 'open-chat' as const } };
    assert.deepEqual(missingForDismiss(sent), []);
    const gone = dismissNotification(sent, LATER);
    assert.equal(gone.dismissedAt, LATER);
    assert.equal(dismissNotification(gone, '2027-01-01T00:00:00.000Z').dismissedAt, LATER);
  });

  it('a warning and an action with only to-dos need no "send"', () => {
    const warn = buildNotificationFromArgs({ title: 'Disk almost full', level: 'warn' }, ctx);
    assert.equal(canDismiss(warn), true);
    const todoOnly = buildNotificationFromArgs({ title: 'Pay', level: 'action', todos: [{ text: 'Pay the invoice' }] }, ctx);
    assert.deepEqual(missingForDismiss(todoOnly), ['1 to-do not ticked']);
    assert.equal(canDismiss(applyTodo(todoOnly, 't1', true, LATER)), true);
  });

  it('the whole path through a real store: answer, tick, send, dismiss → gone from the snapshot', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notif-mcp-')), 'notifications.json');
    const store = createNotificationsStore(file, { now: () => Date.parse(NOW) });
    store.add(lisa());
    store.add(buildNotificationFromArgs({ title: 'Crash sweep did not finish', level: 'warn' }, { ...ctx, id: 'w-1', now: LATER }));
    assert.deepEqual(countsOf(store.list()), { action: 1, warn: 1 });
    const step = (fn: (n: UserNotification) => UserNotification) => store.update('n-1', fn(store.get('n-1')!))!;
    step((n) => applyAnswer(n, 'dayoffs', 'no', LATER));
    step((n) => applyAnswer(n, 'delegated', 'no', LATER));
    step((n) => applyAnswer(n, 'vacation', 'Neither', LATER));
    step((n) => applyAnswer(n, 'edits', 'none', LATER));
    step((n) => applyTodo(n, 't1', true, LATER));
    assert.throws(() => dismissNotification(store.get('n-1')!, LATER), /answers not sent/);
    store.update('n-1', { answersDelivery: { at: LATER, ok: true, via: 'headless' } });
    step((n) => dismissNotification(n, LATER));
    assert.deepEqual(store.snapshot(Date.parse(LATER)).notifications.map((n) => n.id), ['w-1']);
    assert.deepEqual(countsOf(store.list()), { action: 0, warn: 1 });
  });
});

describe('formatAnswersMessage', () => {
  it('equals the C5 text for the LISA example', () => {
    let n = lisa();
    n = applyAnswer(n, 'dayoffs', 'no', LATER);
    n = applyAnswer(n, 'delegated', 'NO', LATER);
    n = applyAnswer(n, 'vacation', 'Only 10 Oct', LATER);
    n = applyAnswer(n, 'edits', "Rename 'misc fixes' on 7 Oct to 'Arrow lint clean-up'.", LATER);
    assert.equal(formatAnswersMessage(n), [
      '[Peers Flow] The user answered your notification "Abilitie timesheet (1–15 Oct) is ready — needs you":',
      '1. Any days off between 1 and 15 October that I should take out? — No',
      '2. Did you hand any of this work to someone else? — No',
      '3. I marked 3 Oct and 10 Oct as vacation — is that right? — Only 10 Oct',
      "4. Any changes to descriptions or hours before I finalize? — Rename 'misc fixes' on 7 Oct to 'Arrow lint clean-up'.",
      'To-dos the user keeps for themselves: Send the timesheet email to Abilitie yourself — the agent never sends email (not done yet).',
      "Continue the work with these answers. Do not do the user's to-dos.",
    ].join('\n'));
  });

  it('prints Yes, marks ticked to-dos "(done)", omits the to-do line when there are none', () => {
    const withTodo = applyTodo(applyAnswer(lisa(), 'dayoffs', 'yes', LATER), 't1', true, LATER);
    const text = formatAnswersMessage(withTodo);
    assert.match(text, /\n1\. .* — Yes\n/);
    assert.match(text, /never sends email \(done\)\.\n/);
    const noTodos = applyAnswer(buildNotificationFromArgs({ title: 'Q', level: 'action', questions: [{ text: 'Go?', kind: 'yesno' }] }, ctx), 'q1', 'yes', LATER);
    assert.equal(formatAnswersMessage(noTodos), [
      '[Peers Flow] The user answered your notification "Q":',
      '1. Go? — Yes',
      "Continue the work with these answers. Do not do the user's to-dos.",
    ].join('\n'));
  });
});

describe('buildRunWarning', () => {
  const routine = { id: 'r1', name: 'Crash sweep', directoryId: 'dir-1' } as Routine;
  const slot = (iso: string) => `slot(${iso})`;
  const base: RoutineRun = { id: 'run-1', routineId: 'r1', slotAt: '2026-10-15T06:00:00.000Z', trigger: 'schedule', status: 'failed', startedAt: '2026-10-15T06:00:00.000Z' };

  it('failed run → "did not finish" warn with the error and the source filled in', () => {
    const n = buildRunWarning({ ...base, error: 'exit 1 ×3', conversationId: 'conv-7' }, routine, 'LISA', 'w-1', NOW, slot);
    assert.deepEqual(n, {
      id: 'w-1', level: 'warn', title: 'Crash sweep did not finish',
      body: 'exit 1 ×3 · Run of slot(2026-10-15T06:00:00.000Z). Open the chat to see why, or use Run now in the Routines tab.',
      source: { kind: 'routine', routineId: 'r1', routineName: 'Crash sweep', runId: 'run-1', conversationId: 'conv-7', directoryId: 'dir-1', peerName: 'LISA', auto: true },
      createdAt: NOW, files: [], questions: [], todos: [],
    });
  });

  it('failed with no error and an unknown routine falls back to plain words', () => {
    const n = buildRunWarning(base, null, null, 'w-2', NOW, slot);
    assert.equal(n.title, 'A routine did not finish');
    assert.match(n.body!, /^The chat ended with an error\. · Run of /);
    assert.deepEqual(n.source, { kind: 'routine', routineId: 'r1', runId: 'run-1', auto: true });
  });

  it('missed run → "was missed" warn', () => {
    const n = buildRunWarning({ ...base, status: 'missed' }, routine, 'LISA', 'w-3', NOW, slot);
    assert.equal(n.title, 'Crash sweep was missed');
    assert.equal(n.body, 'Its slot(2026-10-15T06:00:00.000Z) run never started (the app was off, or the slot was too old to catch up). Use Run now in the Routines tab to run it by hand.');
    assert.equal(n.level, 'warn');
    assert.equal(canDismiss(n), true);
  });
});

describe('shouldShowSystemNotification', () => {
  it('only an action notice, only while the window is not focused', () => {
    const action = lisa();
    const warn = buildNotificationFromArgs({ title: 'w', level: 'warn' }, ctx);
    assert.equal(shouldShowSystemNotification(action, false), true);
    assert.equal(shouldShowSystemNotification(action, true), false);
    assert.equal(shouldShowSystemNotification(warn, false), false);
    assert.equal(shouldShowSystemNotification(warn, true), false);
  });
});
