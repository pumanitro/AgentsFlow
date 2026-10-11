import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTerminalCopy, type CopyRow } from '../shared/terminal-copy';

const COLS = 84;
// A hard-newline row as Claude Code prints it; `from` is where the drag began.
const row = (full: string, from = 0): CopyRow => ({ selected: full.slice(from), width: full.trimEnd().length, wrapped: false });
const soft = (full: string): CopyRow => ({ ...row(full), wrapped: true });

test('quoted reply: gutter, indent and the TUI wrap all disappear', () => {
  const rows = [
    row('  ▎ Dzień dobry!', 2),
    row('  ▎ Dziękujemy za rozebranie większości płotu! Zostały jeszcze słupki.'),
    row('  ▎ Pytam, bo zamówiłem już części do nowego ogrodzenia (dostawa do 2 tygodni), a'),
    row('  ▎ nasz wykonawca ma wkrótce operację kolana.'),
    row('  ▎ Płyty nadal czekają na was do zabrania. Kiedy wam pasuje? 😊'),
  ];
  assert.equal(
    cleanTerminalCopy(rows, COLS),
    'Dzień dobry!\n' +
      'Dziękujemy za rozebranie większości płotu! Zostały jeszcze słupki.\n' +
      'Pytam, bo zamówiłem już części do nowego ogrodzenia (dostawa do 2 tygodni), a nasz wykonawca ma wkrótce operację kolana.\n' +
      'Płyty nadal czekają na was do zabrania. Kiedy wam pasuje? 😊',
  );
});

test('wrapped continuation row without a gutter is rejoined too', () => {
  const rows = [
    row('  ▎ Pytam, bo zamówiłem już części do nowego ogrodzenia. Chcielibyśmy więc skończyć', 2),
    row('  wszystko do 19 października.'),
  ];
  assert.equal(
    cleanTerminalCopy(rows, COLS),
    'Pytam, bo zamówiłem już części do nowego ogrodzenia. Chcielibyśmy więc skończyć wszystko do 19 października.',
  );
});

test('plain reply drops the bullet and margin, keeps short lines apart', () => {
  const rows = [
    row('● Trzy wersje do wyboru.'),
    row(''),
    row('  1 · Ciepła'),
    row('  2 · Średnia'),
  ];
  assert.equal(cleanTerminalCopy(rows, COLS), 'Trzy wersje do wyboru.\n\n1 · Ciepła\n2 · Średnia');
});

test('code keeps its relative indentation and line breaks', () => {
  const rows = [
    row('  function f() {'),
    row('    return 1;'),
    row('  }'),
  ];
  assert.equal(cleanTerminalCopy(rows, COLS), 'function f() {\n  return 1;\n}');
});

test('list items after a full row stay on their own lines', () => {
  const full = '  ' + 'x'.repeat(COLS - 3);
  assert.equal(cleanTerminalCopy([row(full), row('  - next item')], COLS), 'x'.repeat(COLS - 3) + '\n- next item');
});

test('tables are left alone', () => {
  const rows = [row('  │ a │ b │'), row('  │ c │ d │')];
  assert.equal(cleanTerminalCopy(rows, COLS), '│ a │ b │\n│ c │ d │');
});

test('xterm soft wraps join with no separator and keep their leading cells', () => {
  const rows = [row('  abc', 0), soft('  def')];
  assert.equal(cleanTerminalCopy(rows, COLS), '  abc  def');
});

test('a single-row selection is just trimmed', () => {
  assert.equal(cleanTerminalCopy([row('hello world   ')], COLS), 'hello world');
});
