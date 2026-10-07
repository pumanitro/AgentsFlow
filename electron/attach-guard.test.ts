import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { allowReattach, disableLeftArrowAgents, findChatExit, MAX_REATTACHES, REATTACH_WINDOW_MS } from './attach-guard';

const ENTER = '\x1b[?1049h';
const LEAVE = '\x1b[?1049l';

test.describe('findChatExit', () => {
  test('ignores a leave before the chat ever drew', () => {
    const w = { inChat: false };
    assert.equal(findChatExit(w, `${LEAVE}Attaching…`), -1);
    assert.equal(w.inChat, false);
  });

  test('flags the leave that ← / Ctrl+Z emit once the chat is up', () => {
    const w = { inChat: false };
    assert.equal(findChatExit(w, `${ENTER}chat`), -1);
    assert.equal(w.inChat, true);
    const chunk = `\x1b[?1000l${LEAVE}agents list`;
    assert.equal(findChatExit(w, chunk), chunk.indexOf(LEAVE));
  });

  test('catches enter and leave in the same chunk', () => {
    const w = { inChat: false };
    const chunk = `${ENTER}chat${LEAVE}list`;
    assert.equal(findChatExit(w, chunk), chunk.indexOf(LEAVE));
  });

  test('treats leave-then-enter in one chunk as a redraw', () => {
    const w = { inChat: true };
    assert.equal(findChatExit(w, `${LEAVE}${ENTER}chat`), -1);
    assert.equal(w.inChat, true);
  });
});

test.describe('allowReattach', () => {
  test('caps re-attaches inside the window and forgets old ones', () => {
    const h: number[] = [];
    for (let i = 0; i < MAX_REATTACHES; i++) {
      assert.equal(allowReattach(h, 1000 + i), true);
      h.push(1000 + i);
    }
    assert.equal(allowReattach(h, 2000), false);
    assert.equal(allowReattach(h, 1000 + REATTACH_WINDOW_MS + MAX_REATTACHES), true);
  });
});

test.describe('disableLeftArrowAgents', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'af-guard-')), '.claude.json');

  test('writes the flag and keeps every other key', () => {
    const p = tmp();
    fs.writeFileSync(p, JSON.stringify({ numStartups: 3, projects: { a: 1 } }));
    assert.equal(disableLeftArrowAgents(p), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { numStartups: 3, projects: { a: 1 }, leftArrowOpensAgents: false });
  });

  test('leaves the file alone when already off, missing, or unparsable', () => {
    const p = tmp();
    fs.writeFileSync(p, JSON.stringify({ leftArrowOpensAgents: false }));
    const before = fs.statSync(p).mtimeMs;
    assert.equal(disableLeftArrowAgents(p), false);
    assert.equal(fs.statSync(p).mtimeMs, before);
    assert.equal(disableLeftArrowAgents(path.join(path.dirname(p), 'nope.json')), false);
    fs.writeFileSync(p, '{ half');
    assert.equal(disableLeftArrowAgents(p), false);
    assert.equal(fs.readFileSync(p, 'utf8'), '{ half');
  });
});
