/**
 * Inline image markers for the composers.
 *
 * A pasted image used to be invisible in the prompt text: the composer only
 * appended "I attached N images … <paths>" at the very end, so the agent could
 * not tell WHICH image a sentence was talking about, or WHERE in the message it
 * belonged. Now every paste drops a `[Image #n]` marker at the caret (the same
 * placeholder Claude Code's own TUI shows for a pasted image), the thumbnail
 * strip shows the same number, and the trailing block maps each marker to its
 * file. `n` is the image's 1-based position in the composer's list, so removing
 * one renumbers the markers after it.
 */

export function imageMarker(n: number): string {
  return `[Image #${n}]`;
}

const MARKER_RE = /\[Image #(\d+)\]/g;

/**
 * Replace the selection [selStart, selEnd) with the given markers, padded so
 * they never glue onto neighbouring words. Returns the new text and where the
 * caret should land (right after the inserted run).
 */
export function insertImageMarkers(
  text: string,
  selStart: number,
  selEnd: number,
  numbers: number[],
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(selStart, text.length));
  const end = Math.max(start, Math.min(selEnd, text.length));
  if (numbers.length === 0) return { text, caret: end };
  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  // Always leave a space after, so typing continues naturally ("[Image #1] |").
  const suffix = /^\s/.test(after) ? '' : ' ';
  const run = prefix + numbers.map(imageMarker).join(' ') + suffix;
  return { text: before + run + after, caret: before.length + run.length };
}

/**
 * Drop every `[Image #n]` from the text (with one adjacent space, so no double
 * gap is left behind) and shift the markers above it down by one — the image
 * list they index into just lost an entry.
 */
export function removeImageMarker(text: string, n: number): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(MARKER_RE)) {
    const k = Number(m[1]);
    const at = m.index ?? 0;
    if (k === n) {
      let from = at;
      let to = at + m[0].length;
      if (text[to] === ' ') to += 1;
      else if (text[from - 1] === ' ') from -= 1;
      out += text.slice(last, from);
      last = to;
    } else if (k > n) {
      out += text.slice(last, at) + imageMarker(k - 1);
      last = at + m[0].length;
    }
  }
  return out + text.slice(last);
}

/** The marker numbers referenced anywhere in the text, in order of appearance. */
export function referencedImageNumbers(text: string): number[] {
  return Array.from(text.matchAll(MARKER_RE), (m) => Number(m[1]));
}
