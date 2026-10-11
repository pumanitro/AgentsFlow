import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { StatsRow } from './docker-inventory';
import * as os from 'node:os';
import { MIN_CHAT_DIR_SEGMENTS, YOUNG_MS, chatProtects, containerVerdict, isActive, pathWithin } from './use-ladder';
import type { ContainerFacts } from './use-ladder';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const MIN = 60_000;

/** An old, idle, unpinned compose container: a stop candidate unless a fact says otherwise. */
function facts(over: Partial<ContainerFacts> = {}): ContainerFacts {
  return {
    name: 'customer-ui', project: 'vitaminology', projectDir: '/Users/iij/IdeaProjects/nutrable/develop/.cache',
    autoRemove: false, running: true, startedAt: NOW - 5 * 60 * MIN, pinned: false, liveCwds: [],
    lastActiveAt: NOW - 133 * MIN, firstSeenAt: NOW - 5 * 60 * MIN, idleMinutes: 120, now: NOW, ...over,
  };
}
function stats(over: Partial<StatsRow> = {}): StatsRow {
  return { name: 'c', cpuPct: 0.1, memMB: 100, netRxBytes: 1000, netTxBytes: 500, ...over };
}

test('pathWithin: same dir, a child, and trailing slashes on either side', () => {
  assert.equal(pathWithin('/a/b', '/a/b'), true);
  assert.equal(pathWithin('/a/b/c', '/a/b'), true);
  assert.equal(pathWithin('/a/b/', '/a/b'), true);
  assert.equal(pathWithin('/a/b/c', '/a/b/'), true);
  assert.equal(pathWithin('/a/b/c/', '/a/b//'), true);
});

test('pathWithin: a sibling with a shared prefix, a parent, and relative or empty paths are outside', () => {
  assert.equal(pathWithin('/a/bc', '/a/b'), false);
  assert.equal(pathWithin('/a', '/a/b'), false);
  assert.equal(pathWithin('', '/a'), false);
  assert.equal(pathWithin('/a', ''), false);
  assert.equal(pathWithin('a/b', 'a'), false);
});

test('pathWithin: lexical only — dot segments resolve, nothing touches the disk', () => {
  assert.equal(pathWithin('/a/b/../c', '/a/b'), false);
  assert.equal(pathWithin('/a/x/../b/c', '/a/b'), true);
  assert.equal(pathWithin('/a/./b', '/a/b'), true);
  assert.equal(pathWithin('/definitely/not/on/this/disk/x', '/definitely/not/on/this/disk'), true);
});

test('isActive: cpu above 2 %', () => {
  assert.equal(isActive(null, stats({ cpuPct: 2.1 }), 0), true);
  assert.equal(isActive(null, stats({ cpuPct: 2 }), 0), false);
});

test('isActive: any network traffic since the previous reading', () => {
  assert.equal(isActive(stats(), stats({ netRxBytes: 1001 }), 0), true);
  assert.equal(isActive(stats(), stats({ netTxBytes: 501 }), 0), true);
  assert.equal(isActive(stats(), stats(), 0), false);
  assert.equal(isActive(null, stats(), 0), false);                      // no baseline, no delta
  assert.equal(isActive(stats(), stats({ netRxBytes: 0, netTxBytes: 0 }), 0), false);   // counters reset by a restart
});

test('isActive: an established connection on a published port', () => {
  assert.equal(isActive(null, null, 1), true);
  assert.equal(isActive(stats(), stats(), 3), true);
  assert.equal(isActive(null, null, 0), false);
});

test('verdict 1: pinned beats everything', () => {
  const v = containerVerdict(facts({ pinned: true, autoRemove: true, liveCwds: ['/Users/iij/IdeaProjects/nutrable/develop/.cache'], lastActiveAt: NOW, startedAt: NOW }));
  assert.equal(v.verdict, 'keep-pinned');
});

test('verdict 2: an auto-remove (--rm) container is kept — stopping it would delete it', () => {
  const v = containerVerdict(facts({ autoRemove: true, liveCwds: ['/Users/iij/IdeaProjects/nutrable/develop/.cache'], lastActiveAt: NOW }));
  assert.equal(v.verdict, 'keep-autoremove');
});

test('verdict 3: a live chat whose cwd is inside the project dir', () => {
  const dir = '/Users/iij/IdeaProjects/nutrable/develop/.cache';
  assert.equal(containerVerdict(facts({ liveCwds: ['/tmp', `${dir}/services/api/`], lastActiveAt: NOW })).verdict, 'keep-live-chat');
  assert.equal(containerVerdict(facts({ liveCwds: [dir] })).verdict, 'keep-live-chat');
  // a chat next door, or a container with no known project dir, is not protected by this rung
  assert.equal(containerVerdict(facts({ liveCwds: [`${dir}-old`] })).verdict, 'stop-candidate');
  assert.equal(containerVerdict(facts({ projectDir: null, liveCwds: ['/'] })).verdict, 'stop-candidate');
});

test('verdict 4: active within the idle window', () => {
  const v = containerVerdict(facts({ lastActiveAt: NOW - 119 * MIN }));
  assert.equal(v.verdict, 'keep-active');
  assert.equal(v.note, 'active 1h59m ago');
  assert.equal(containerVerdict(facts({ lastActiveAt: NOW - 120 * MIN })).verdict, 'stop-candidate');
  // a shorter window from the pins file
  assert.equal(containerVerdict(facts({ lastActiveAt: NOW - 40 * MIN, idleMinutes: 45 })).verdict, 'keep-active');
  assert.equal(containerVerdict(facts({ lastActiveAt: NOW - 50 * MIN, idleMinutes: 45 })).verdict, 'stop-candidate');
});

test('verdict 5: young — started less than max(30 min, idle window) ago', () => {
  assert.equal(YOUNG_MS, 30 * MIN);
  assert.equal(containerVerdict(facts({ lastActiveAt: null, startedAt: NOW - 119 * MIN })).verdict, 'keep-young');
  // with a 10-minute idle window the floor is still 30 minutes
  assert.equal(containerVerdict(facts({ lastActiveAt: null, startedAt: NOW - 29 * MIN, idleMinutes: 10 })).verdict, 'keep-young');
  assert.equal(containerVerdict(facts({ lastActiveAt: null, startedAt: NOW - 31 * MIN, idleMinutes: 10 })).verdict, 'stop-candidate');
});

test('verdict 5: young — this app has watched it for less than the window (restart resets the clock)', () => {
  const v = containerVerdict(facts({ lastActiveAt: null, firstSeenAt: NOW - 20 * MIN }));
  assert.equal(v.verdict, 'keep-young');
  assert.equal(v.note, 'watched for only 20m');
  assert.equal(containerVerdict(facts({ lastActiveAt: null, startedAt: null, firstSeenAt: NOW - 20 * MIN })).verdict, 'keep-young');
});

test('verdict 6: stop-candidate, with the idle time and project in the note', () => {
  assert.deepEqual(containerVerdict(facts()), { verdict: 'stop-candidate', note: 'idle 2h13m, project vitaminology' });
  assert.deepEqual(containerVerdict(facts({ name: 'redis', project: null, projectDir: null, lastActiveAt: null, firstSeenAt: NOW - 125 * MIN })), { verdict: 'stop-candidate', note: 'idle 2h05m, no project' });
});

test('verdict: size is not a fact — the ladder has no memory input at all', () => {
  assert.equal('memMB' in facts(), false);
});

test('verdict: a container that is not running is never a candidate', () => {
  assert.notEqual(containerVerdict(facts({ running: false })).verdict, 'stop-candidate');
});

const VITA = '/Users/iij/IdeaProjects/nutrable/develop/.cache';

test('live chat, both directions: the vitaminology pair — chat in the repo, compose dir in a subfolder', () => {
  assert.equal(chatProtects('/Users/iij/IdeaProjects/nutrable', VITA), true);
  assert.equal(chatProtects('/Users/iij/IdeaProjects/nutrable/', VITA), true);
  assert.equal(chatProtects(`${VITA}/services/api`, VITA), true);          // the original direction still holds
  const v = containerVerdict(facts({ liveCwds: ['/tmp/x/y', '/Users/iij/IdeaProjects/nutrable'] }));
  assert.deepEqual(v, { verdict: 'keep-live-chat', note: 'a live chat is working in /Users/iij/IdeaProjects/nutrable' });
});

test('live chat, both directions: a worktree or sibling repo does not protect someone else\'s project', () => {
  assert.equal(chatProtects('/Users/iij/IdeaProjects/nutrable-old', VITA), false);
  assert.equal(chatProtects('/Users/iij/IdeaProjects/arrow', VITA), false);
  assert.equal(containerVerdict(facts({ liveCwds: ['/Users/iij/IdeaProjects/arrow'] })).verdict, 'stop-candidate');
});

test('live chat: a chat in /, /Users, the home dir or anything under 3 segments protects nothing by containing it', () => {
  assert.equal(MIN_CHAT_DIR_SEGMENTS, 3);
  const home = os.homedir();
  const under = `${home}/IdeaProjects/nutrable/develop/.cache`;
  for (const chat of ['/', '/Users', '/Users/', '/Users/iij', home, `${home}/`, '/a/b', '', 'relative/dir/deep/enough']) {
    assert.equal(chatProtects(chat, under), false, chat);
    assert.equal(chatProtects(chat, VITA), false, chat);
  }
  assert.equal(containerVerdict(facts({ liveCwds: ['/', '/Users', '/Users/iij', home] })).verdict, 'stop-candidate');
  // three segments deep and not the home dir is enough
  assert.equal(chatProtects('/Users/iij/IdeaProjects', VITA), true);
  assert.equal(chatProtects(`${home}/IdeaProjects`, under), true);
});

test('live chat: a container with no project folder cannot be matched to any chat', () => {
  assert.equal(chatProtects('/Users/iij/Desktop/ai-factory/ai-factory-brain', null), false);
  const v = containerVerdict(facts({ name: 'supabase_db_shelly-monitor', project: 'shelly-monitor', projectDir: null, lastActiveAt: null, liveCwds: ['/Users/iij/Desktop/ai-factory/ai-factory-brain'] }));
  assert.deepEqual(v, { verdict: 'stop-candidate', note: 'idle 5h00m, project shelly-monitor (folder unknown)' });
});
