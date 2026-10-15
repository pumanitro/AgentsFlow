import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildNotificationFromArgs,
  buildRunWarning,
  describeForTool,
  dismissNotification,
  markRead,
  shouldShowSystemNotification,
  type NotifyContext,
} from './notifications-mcp';
import { createNotificationsStore } from './notifications-store';
import { TOOL_DEFS } from './registry';
import { countsOf, isOpen, type UserNotification } from '../shared/notifications';
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

// The LISA routine's notice: its questions are plain text in its chat reply;
// the notice only points there.
const LISA = {
  title: 'Abilitie timesheet (1–15 Oct) is ready — needs you',
  level: 'action',
  body: "The timesheet PDF is ready. I asked 4 questions in the chat — answer them there, then send the email to Abilitie yourself.",
  files: [{ path: '~/Desktop/LISA/timesheets/2026-10-abilitie-timesheet.pdf', label: 'October timesheet (PDF)' }],
};

const lisa = () => buildNotificationFromArgs(LISA, ctx);
const err = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return null; };

describe('notify tool schema', () => {
  const notify = TOOL_DEFS.find((t) => t.name === 'notify')!;

  it('takes title, level, body, files — no questions, no todos', () => {
    const props = Object.keys((notify.inputSchema as { properties: Record<string, unknown> }).properties).sort();
    assert.deepEqual(props, ['body', 'files', 'level', 'title']);
    assert.deepEqual([...(notify.inputSchema as unknown as { required: readonly string[] }).required], ['title', 'level']);
    assert.equal(notify.usage, 'notify({ title, level, body?, files? })');
  });

  it('tells the agent to ask in its chat reply and that notify never collects answers', () => {
    assert.match(notify.description, /plain text in your own chat reply/);
    assert.match(notify.description, /never collects answers/);
    assert.doesNotMatch(notify.description, /Send answers|card/);
  });
});

describe('buildNotificationFromArgs', () => {
  it('builds the LISA timesheet notice: a pointer with its file resolved from ~', () => {
    const n = lisa();
    assert.deepEqual(n, {
      id: 'n-1', level: 'action', title: LISA.title, body: LISA.body, source: ctx.source, createdAt: NOW,
      files: [{ path: '/Users/demo/Desktop/LISA/timesheets/2026-10-abilitie-timesheet.pdf', label: 'October timesheet (PDF)' }],
    });
  });

  it('trims strings, resolves relative paths against the peer', () => {
    const n = buildNotificationFromArgs({ title: '  Hello  ', level: 'action', files: [{ path: 'out/report.pdf' }, { path: '/tmp/../tmp/x.txt' }] }, ctx);
    assert.equal(n.title, 'Hello');
    assert.equal(n.body, undefined);
    assert.deepEqual(n.files, [{ path: '/Users/demo/Desktop/LISA/out/report.pdf' }, { path: '/tmp/x.txt' }]);
  });

  it('rejects bad arguments with one human line', () => {
    assert.equal(err(() => buildNotificationFromArgs({ level: 'warn' }, ctx)), '`title` is required');
    assert.equal(err(() => buildNotificationFromArgs({ title: '   ', level: 'warn' }, ctx)), '`title` is required');
    assert.equal(err(() => buildNotificationFromArgs({ title: 't', level: 'info' }, ctx)), 'level must be "warn" or "action"');
    assert.equal(err(() => buildNotificationFromArgs({ title: 't' }, ctx)), 'level must be "warn" or "action"');
    assert.equal(err(() => buildNotificationFromArgs({ title: 'x'.repeat(300), level: 'warn' }, ctx)), '`title` is longer than 200 characters');
    assert.equal(err(() => buildNotificationFromArgs({ title: 't', level: 'action', files: [{ label: 'x' }] }, ctx)), 'file 1: `path` is required');
    assert.equal(err(() => buildNotificationFromArgs({ title: 't', level: 'action', files: Array.from({ length: 21 }, () => ({ path: '/a' })) }, ctx)), 'at most 20 files');
    assert.equal(err(() => buildNotificationFromArgs('nope', ctx)), 'notify needs an object of arguments');
  });

  it('an agent still sending questions / todos is told to put them in its chat reply', () => {
    const hint = 'notify takes no `questions` or `todos`: write them as plain text in your chat reply, then call notify with a short pointer `body`';
    assert.equal(err(() => buildNotificationFromArgs({ ...LISA, questions: [{ text: 'Days off?', kind: 'yesno' }] }, ctx)), hint);
    assert.equal(err(() => buildNotificationFromArgs({ ...LISA, todos: [{ text: 'Send it' }] }, ctx)), hint);
  });

  it('describeForTool is the success envelope', () => {
    assert.deepEqual(describeForTool(lisa()), {
      status: 'success', id: 'n-1', level: 'action', title: LISA.title, files: 1,
      note: 'The bell points the user to this chat. They read your questions / to-dos in your chat reply and answer by typing in this chat — end your turn now.',
    });
    assert.equal(describeForTool(buildNotificationFromArgs({ title: 'w', level: 'warn' }, ctx)).note, 'The user will see this in the bell.');
  });
});

describe('read, dismiss', () => {
  it('markRead sets readAt once', () => {
    const r = markRead(lisa(), NOW);
    assert.equal(markRead(r, LATER).readAt, NOW);
  });

  it('Dismiss is always allowed, once', () => {
    const gone = dismissNotification(lisa(), LATER);
    assert.equal(gone.dismissedAt, LATER);
    assert.equal(dismissNotification(gone, '2027-01-01T00:00:00.000Z').dismissedAt, LATER);
    const warn = buildNotificationFromArgs({ title: 'Disk almost full', level: 'warn' }, ctx);
    assert.equal(dismissNotification(warn, LATER).dismissedAt, LATER);
  });

  it('the whole path through a real store: dismiss takes the notice off the snapshot', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notif-mcp-')), 'notifications.json');
    const store = createNotificationsStore(file, { now: () => Date.parse(NOW) });
    store.add(lisa());
    store.add(buildNotificationFromArgs({ title: 'Crash sweep did not finish', level: 'warn' }, { ...ctx, id: 'w-1', now: LATER }));
    assert.deepEqual(countsOf(store.list()), { action: 1, warn: 1 });
    store.update('n-1', dismissNotification(store.get('n-1')!, LATER));
    const snap = store.snapshot(Date.parse(LATER));
    assert.deepEqual(snap.notifications.map((n: UserNotification) => n.id), ['w-1']);
    assert.equal(isOpen(store.get('n-1')!), false);
    assert.deepEqual(Object.keys(snap).sort(), ['notifications', 'now']);
    assert.deepEqual(countsOf(store.list()), { action: 0, warn: 1 });
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
      createdAt: NOW, files: [],
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
