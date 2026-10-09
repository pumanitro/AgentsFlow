// Turns a terminal selection back into the text the agent actually wrote.
//
// xterm copies cells, not prose. Claude Code draws its output with UI chrome
// baked into the cells and wraps long lines itself with hard newlines, so a raw
// copy of a quoted reply comes out as
//
//   ▎ Dzień dobry!
//     ▎ Pytam, bo zamówiłem już części … Chcielibyśmy więc skończyć
//     wszystko do 19 października.
//
// — a quote gutter on every line, the reply's 2-column indent, and a sentence
// split wherever the terminal happened to be narrow. cleanTerminalCopy strips
// the gutter and the shared indent and rejoins rows that were only wrapped.

export interface CopyRow {
  /** The selected part of this row (already sliced to the selection columns). */
  selected: string;
  /** Cells this row occupies, trailing blanks excluded — measures how full it is. */
  width: number;
  /** xterm's own soft-wrap flag: this row continues the previous one. */
  wrapped: boolean;
}

// Claude Code's blockquote gutter. Not │ — that is also a table border.
const GUTTER = /^[ \t]*[▎▍▌┃](?: |$)/;
// The marker Claude Code puts before a reply's first line.
const BULLET = /^[ \t]*[●⏺] /;
const LIST_ITEM = /^(?:[-*•+]|\d+[.)]) /;
const BOX = /[─━│┃┌┐└┘├┤┬┴┼╭╮╯╰]/;
// A TUI wraps a little short of the last column, so a row this close to the
// edge counts as full.
const EDGE_SLACK = 2;

const indentOf = (s: string) => s.length - s.trimStart().length;

export function cleanTerminalCopy(rows: CopyRow[], cols: number): string {
  if (rows.length === 0) return '';
  const lines = rows.map((r, i) => {
    let s = r.selected.replace(/\s+$/, '');
    // A soft-wrapped row is mid-line: its leading cells are text, not chrome.
    if (r.wrapped && i > 0) return s;
    if (i === 0) s = s.replace(BULLET, '');
    const g = s.match(GUTTER);
    if (g) s = s.slice(0, indentOf(s)) + s.slice(g[0].length);
    return s;
  });

  // Drop the indent every line shares (the reply's own margin), keeping any
  // deeper, meaningful indentation such as code. The first row usually starts
  // mid-row where the drag began, so it doesn't set the margin.
  const body = lines.slice(1).filter((s, i) => s.trim() !== '' && !(rows[i + 1].wrapped));
  const margin = body.length ? Math.min(...body.map(indentOf)) : 0;
  const dedented = lines.map((s, i) => {
    if (i > 0 && rows[i].wrapped) return s;
    return s.slice(Math.min(margin, indentOf(s)));
  });

  let out = dedented[0];
  for (let i = 1; i < dedented.length; i++) {
    const prev = dedented[i - 1];
    const next = dedented[i];
    if (rows[i].wrapped) { out += next; continue; }
    out += isHardWrap(rows[i - 1].width, prev, next, cols) ? ' ' + next.trimStart() : '\n' + next;
  }
  return out;
}

// A row ends with a hard newline both when a paragraph ends and when the TUI
// wrapped it. It was a wrap when the next row's first word could not have fit
// on this one.
function isHardWrap(prevWidth: number, prev: string, next: string, cols: number): boolean {
  if (prev.trim() === '' || next.trim() === '') return false;
  const word = next.trimStart();
  if (LIST_ITEM.test(word) || BOX.test(prev) || BOX.test(next)) return false;
  const firstWord = word.split(/\s/, 1)[0];
  return prevWidth + 1 + firstWord.length > cols - EDGE_SLACK;
}
