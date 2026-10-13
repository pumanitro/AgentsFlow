import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { busyChildren, parsePsRows } from './pty-busy';

// A real `ps -axo pid=,ppid=,comm=` slice from 2026-10-10: one resumed Claude
// chat (55037) mid-overnight-loop, one idle (97063), one with a zombie (82881).
const PS = `
55037 90497 claude
23714 55037 caffeinate
56384 55037 node
56385 55037 /Users/iij/Desktop/AgentsFlow/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
66491 55037 zsh
66502 66491 sleep
97063 90497 claude
97070 97063 node
97071 97063 Electron
82881 90497 claude
82890 82881 (bash)
82891 82881 Electron
82892 82881 node
`;

test('parsePsRows: reads pid, ppid and a command path, skips junk', () => {
  const rows = parsePsRows('  12 1 /bin/zsh\n\nnot a row\n13 12 sleep\n');
  assert.deepEqual(rows, [{ pid: 12, ppid: 1, comm: '/bin/zsh' }, { pid: 13, ppid: 12, comm: 'sleep' }]);
});

test('busyChildren: a chat with caffeinate or a background shell is working', () => {
  assert.deepEqual(busyChildren(parsePsRows(PS), 55037), ['caffeinate', 'zsh']);
});

test('busyChildren: MCP servers alone (node, Electron) are not work', () => {
  assert.deepEqual(busyChildren(parsePsRows(PS), 97063), []);
});

test('busyChildren: a zombie shell "(bash)" is not work', () => {
  assert.deepEqual(busyChildren(parsePsRows(PS), 82881), []);
});

test('busyChildren: only DIRECT children count, and a login-shell dash is tolerated', () => {
  const rows = parsePsRows('1 0 launchd\n2 1 claude\n3 2 -zsh\n4 3 sleep\n5 1 caffeinate\n');
  assert.deepEqual(busyChildren(rows, 2), ['-zsh']);
  assert.deepEqual(busyChildren(rows, 3), []);          // `sleep` itself is not a sign
  assert.deepEqual(busyChildren(rows, 0), []);
  assert.deepEqual(busyChildren(rows, NaN), []);
});
