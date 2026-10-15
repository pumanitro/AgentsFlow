import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createNotificationsStore } from './notifications-store';
import type { UserNotification } from '../shared/notifications';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-15T09:00:00.000Z');
const isoOf = (ms: number) => new Date(ms).toISOString();
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notif-store-')), 'notifications.json');

const notice = (id: string, extra: Partial<UserNotification> = {}): UserNotification => ({
  id, level: 'action', title: `Notice ${id}`, source: { kind: 'chat', conversationId: 'c1' },
  createdAt: isoOf(T0), files: [], ...extra,
});

describe('notifications store', () => {
  it('round-trips through the file (flushSync, then a fresh store)', () => {
    const file = tmpFile();
    const a = createNotificationsStore(file, { now: () => T0 });
    const full = notice('n1', {
      body: 'Check the PDF',
      files: [{ path: '/Users/demo/a.pdf', label: 'A' }],
      readAt: isoOf(T0),
    });
    a.add(full);
    a.add(notice('n2', { level: 'warn', createdAt: isoOf(T0 + 1000), source: { kind: 'routine', routineId: 'r1', runId: 'run1', auto: true } }));
    a.flushSync();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.notifications.length, 2);
    const b = createNotificationsStore(file, { now: () => T0 });
    assert.deepEqual(b.get('n1'), full);
    assert.deepEqual(b.list().map((n) => n.id), ['n2', 'n1']);
  });

  it('sanitize drops records with an unknown level or no id / title / createdAt, and fills missing arrays', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      notifications: [
        { id: 'ok', level: 'warn', title: 'fine', createdAt: isoOf(T0), source: { kind: 'app' } },
        { id: 'info', level: 'info', title: 'no info level', createdAt: isoOf(T0) },
        { level: 'warn', title: 'no id', createdAt: isoOf(T0) },
        { id: 'notitle', level: 'warn', createdAt: isoOf(T0) },
        { id: 'nodate', level: 'warn', title: 't' },
        'garbage',
      ],
    }));
    const errors = mock.method(console, 'error', () => undefined);
    try {
      const s = createNotificationsStore(file, { now: () => T0 });
      assert.deepEqual(s.list(), [{ id: 'ok', level: 'warn', title: 'fine', createdAt: isoOf(T0), source: { kind: 'app' }, files: [] }]);
      assert.equal(errors.mock.callCount(), 1);
      assert.match(String(errors.mock.calls[0].arguments[0]), /dropped 5/);
    } finally {
      errors.mock.restore();
    }
  });

  it('a missing or corrupt file starts empty', () => {
    const file = tmpFile();
    assert.deepEqual(createNotificationsStore(file).list(), []);
    fs.writeFileSync(file, '{not json');
    const errors = mock.method(console, 'error', () => undefined);
    try {
      assert.deepEqual(createNotificationsStore(file).list(), []);
    } finally {
      errors.mock.restore();
    }
  });

  it('prunes dismissed notices older than 30 days and open ones older than 180 on load', () => {
    const file = tmpFile();
    const now = T0 + 200 * DAY;
    const a = createNotificationsStore(file, { now: () => T0 });
    a.add(notice('dismissed-old', { createdAt: isoOf(now - 40 * DAY), dismissedAt: isoOf(now - 31 * DAY) }));
    a.add(notice('dismissed-new', { createdAt: isoOf(now - 40 * DAY), dismissedAt: isoOf(now - 29 * DAY) }));
    a.add(notice('open-old', { createdAt: isoOf(now - 181 * DAY) }));
    a.add(notice('open-new', { createdAt: isoOf(now - 179 * DAY) }));
    a.flushSync();
    const b = createNotificationsStore(file, { now: () => now });
    assert.deepEqual(b.list({ includeDismissed: true }).map((n) => n.id).sort(), ['dismissed-new', 'open-new']);
    b.flushSync();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).notifications.length, 2);
  });

  it('snapshot lists open notices only, newest first, with main\'s clock', () => {
    const s = createNotificationsStore(tmpFile(), { now: () => T0 });
    s.add(notice('old', { createdAt: isoOf(T0 - 2000) }));
    s.add(notice('gone', { createdAt: isoOf(T0 - 1000), dismissedAt: isoOf(T0) }));
    s.add(notice('new', { createdAt: isoOf(T0) }));
    const snap = s.snapshot(T0 + 5);
    assert.deepEqual(snap.notifications.map((n) => n.id), ['new', 'old']);
    assert.equal(snap.now, isoOf(T0 + 5));
    assert.deepEqual(s.list({ includeDismissed: true }).map((n) => n.id), ['new', 'gone', 'old']);
    assert.deepEqual(Object.keys(snap).sort(), ['notifications', 'now']);
  });

  it('a notice saved by the retired in-app answering UI (questions / todos / answersDelivery) loads fine, without those fields', () => {
    const file = tmpFile();
    const legacy = {
      id: 'legacy', level: 'action', title: 'Timesheet needs you', body: 'Check it', createdAt: isoOf(T0),
      source: { kind: 'chat', conversationId: 'c1' },
      files: [{ path: '/Users/demo/a.pdf', label: 'A' }],
      questions: [
        { id: 'dayoffs', text: 'Days off?', kind: 'yesno', answer: 'no', answeredAt: isoOf(T0) },
        { id: 'odd', text: 'x', kind: 'slider' },
      ],
      todos: [{ id: 't1', text: 'Send it', done: false }],
      answersDelivery: { at: isoOf(T0), ok: false, via: 'resume', error: 'gone' },
    };
    fs.writeFileSync(file, JSON.stringify({ version: 1, notifications: [legacy] }));
    const errors = mock.method(console, 'error', () => undefined);
    try {
      const s = createNotificationsStore(file, { now: () => T0 });
      assert.equal(errors.mock.callCount(), 0, 'nothing dropped');
      assert.deepEqual(s.get('legacy'), {
        id: 'legacy', level: 'action', title: 'Timesheet needs you', body: 'Check it', createdAt: isoOf(T0),
        source: { kind: 'chat', conversationId: 'c1' }, files: [{ path: '/Users/demo/a.pdf', label: 'A' }],
      });
      assert.deepEqual(s.snapshot(T0).notifications.map((n) => n.id), ['legacy']);
      s.update('legacy', { readAt: isoOf(T0) });
      s.flushSync();
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')).notifications[0];
      for (const k of ['questions', 'todos', 'answersDelivery']) assert.equal(k in saved, false, `${k} is not written back`);
    } finally {
      errors.mock.restore();
    }
  });

  it('update merges a patch, never changes the id, and returns null for an unknown one', () => {
    const s = createNotificationsStore(tmpFile(), { now: () => T0 });
    s.add(notice('n1'));
    const next = s.update('n1', { id: 'hijack', readAt: isoOf(T0) } as Partial<UserNotification>)!;
    assert.equal(next.id, 'n1');
    assert.equal(next.readAt, isoOf(T0));
    assert.equal(s.get('hijack'), null);
    assert.equal(s.update('nope', { readAt: isoOf(T0) }), null);
  });

  it('findOpen skips dismissed notices', () => {
    const s = createNotificationsStore(tmpFile(), { now: () => T0 });
    s.add(notice('a', { level: 'warn', source: { kind: 'routine', runId: 'run1', auto: true }, dismissedAt: isoOf(T0) }));
    assert.equal(s.findOpen((n) => n.source.runId === 'run1'), null);
    s.add(notice('b', { level: 'warn', source: { kind: 'routine', runId: 'run1', auto: true } }));
    assert.equal(s.findOpen((n) => n.source.runId === 'run1')?.id, 'b');
  });

  it('saves on its own after the debounce', async () => {
    const file = tmpFile();
    const s = createNotificationsStore(file, { now: () => T0 });
    s.add(notice('n1'));
    assert.equal(fs.existsSync(file), false);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).notifications[0].id, 'n1');
  });
});
