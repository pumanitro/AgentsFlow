import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { Range } from '@codemirror/state';

/**
 * Obsidian-style Live Preview for CodeMirror 6.
 *
 * - Inline decorations style headings, bold, italic, inline code, strikethrough, links
 *   and blockquotes (via line classes + mark classes you can style in CSS).
 * - Markdown syntax markers (`#`, `**`, `_`, backticks, `[]()`, `>`, `~~`, …) are *hidden*
 *   when the cursor is not on that line, and *revealed* when it is — so the file stays
 *   plain-text editable without ever leaving "live" mode.
 *
 * Pair with the CSS rules under `.cm-md-*` in globals.css.
 */

const HEADING_NAMES = ['ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6'];

const MARKER_NAMES = new Set([
  'HeaderMark',        // `#`-prefix on headings
  'EmphasisMark',      // `*`, `_`
  'CodeMark',          // backtick (inline)
  'LinkMark',          // `[`, `]`, `(`, `)`
  'StrikethroughMark', // `~~`
  'QuoteMark',         // `>` at line start
]);

function buildDecorations(view: EditorView): DecorationSet {
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const marks: Range<Decoration>[] = [];
  const lines: Range<Decoration>[] = [];
  const replaces: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const type = node.name;
        const startLine = view.state.doc.lineAt(node.from).number;
        const endLine = view.state.doc.lineAt(Math.min(node.to, view.state.doc.length)).number;
        const onCursorLine = cursorLine >= startLine && cursorLine <= endLine;

        // Heading line classes (renders the whole line bigger/bolder via CSS)
        const hIdx = HEADING_NAMES.indexOf(type);
        if (hIdx >= 0) {
          lines.push(Decoration.line({ class: `cm-md-h${hIdx + 1}` }).range(view.state.doc.lineAt(node.from).from));
        }

        // Inline mark classes
        if (type === 'StrongEmphasis') marks.push(Decoration.mark({ class: 'cm-md-strong' }).range(node.from, node.to));
        else if (type === 'Emphasis') marks.push(Decoration.mark({ class: 'cm-md-em' }).range(node.from, node.to));
        else if (type === 'Strikethrough') marks.push(Decoration.mark({ class: 'cm-md-strike' }).range(node.from, node.to));
        else if (type === 'InlineCode') marks.push(Decoration.mark({ class: 'cm-md-code' }).range(node.from, node.to));
        else if (type === 'Link') marks.push(Decoration.mark({ class: 'cm-md-link' }).range(node.from, node.to));

        // Blockquote line class
        if (type === 'Blockquote') {
          let lineNo = startLine;
          while (lineNo <= endLine) {
            const ln = view.state.doc.line(lineNo);
            lines.push(Decoration.line({ class: 'cm-md-quote' }).range(ln.from));
            lineNo++;
          }
        }

        // Hide markers on lines that don't currently have the cursor.
        if (MARKER_NAMES.has(type) && !onCursorLine) {
          replaces.push(Decoration.replace({}).range(node.from, node.to));
        }
        // Hide URL part of links when cursor isn't on the line (keeps the link text visible)
        if (type === 'URL' && !onCursorLine) {
          replaces.push(Decoration.replace({}).range(node.from, node.to));
        }
      },
    });
  }

  // RangeSet requires ranges sorted; collected each bucket in order but combine + sort to be safe.
  const all = [...lines, ...replaces, ...marks].sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(all, true);
}

export const markdownLivePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);
