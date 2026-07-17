// A custom xterm link provider that makes filesystem paths in terminal output
// clickable: click one and it is revealed in Finder (Explorer / the default
// file manager on other platforms). This complements the WebLinksAddon, which
// only handles http(s)/mailto URLs.
//
// Design notes:
//  - We match liberally with a path-ish character regex, then gate every
//    candidate on real filesystem existence via the `probe` callback (an IPC
//    round-trip to the main process). Only tokens that resolve to an actual
//    file or directory become links, so prose words like "revealed" — or a
//    typo'd path — never underline. This is what keeps false positives at zero
//    without a fragile "is this a path?" heuristic.
//  - Paths that wrapped across several terminal rows are stitched back into one
//    logical line before matching, mirroring how xterm's own WebLinksAddon
//    handles wrapping, so a long absolute path is still fully clickable.
//  - Probe results are cached (with a short TTL so the cache self-heals when a
//    path is later created/removed) because xterm calls provideLinks on every
//    mouse move over a row.
//
// Column mapping assumes single-width characters, which holds for filesystem
// paths (ASCII). A stray wide/combining char in a matched token could nudge the
// underline by a cell; harmless for reveal-on-click.

import type { Terminal, ILinkProvider, ILink } from 'xterm';

export interface PathLinkOptions {
  // The directory that relative tokens are resolved against (the terminal's
  // cwd). May change over the terminal's life, so it is read fresh per hover.
  getBaseDir: () => string | null;
  // Resolves a token to an absolute path and reports existence. Returns null
  // when the token cannot be resolved (relative token with no base dir, etc.).
  probe: (baseDir: string | null, token: string) => Promise<{ exists: boolean; absPath: string } | null>;
  // Reveals the resolved absolute path in the OS file browser.
  reveal: (absPath: string) => void;
}

// Runs of characters that can appear in the paths we want to catch. Slashes,
// dots, tilde (home), and the usual name characters. Whitespace, quotes and
// backticks terminate a token.
const PATH_TOKEN = /[A-Za-z0-9_./~@+\-]+/g;

// Sentence punctuation that commonly hugs a path in prose. Stripped from the
// ends of a candidate before probing (a trailing "/" is kept — it marks a
// directory — but "rail/." loses only the sentence period).
const TRAIL = new Set(['.', ',', ':', ';', '!', '?', ')', ']', '}', '>', "'", '"']);
const LEAD = new Set(['(', '[', '{', '<', "'", '"']);

const MAX_WINDOW_CHARS = 8192; // cap on a stitched logical line
const MAX_CANDIDATES = 24; // cap on probes per hovered row
const CACHE_TTL_MS = 20_000;
const CACHE_MAX = 4000;

interface Seg {
  y: number; // 0-based buffer line index
  text: string;
  start: number; // cumulative char offset of this segment within the logical line
}

interface Candidate {
  token: string;
  range: ILink['range'];
}

export function createPathLinkProvider(term: Terminal, opts: PathLinkOptions): ILinkProvider {
  const cache = new Map<string, { value: { exists: boolean; absPath: string } | null; ts: number }>();

  const probeCached = async (baseDir: string | null, token: string) => {
    const key = `${baseDir ?? ''}\0${token}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.ts < CACHE_TTL_MS) return hit.value;
    let value: { exists: boolean; absPath: string } | null = null;
    try {
      value = await opts.probe(baseDir, token);
    } catch {
      value = null;
    }
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { value, ts: now });
    return value;
  };

  // Reconstruct the full logical line (including wrapped continuation rows) that
  // contains the hovered buffer row, as an array of segments with cumulative
  // offsets so a global char index maps back to a (row, column) cell.
  const buildSegments = (bufferLineNumber: number): Seg[] => {
    const buf = term.buffer.active;
    let firstY = bufferLineNumber - 1; // provideLinks is 1-based; getLine is 0-based
    if (!buf.getLine(firstY)) return [];
    // Walk up to the first physical row of this logical line.
    while (firstY > 0 && buf.getLine(firstY)?.isWrapped) firstY--;
    const segs: Seg[] = [];
    let total = 0;
    let y = firstY;
    while (total < MAX_WINDOW_CHARS) {
      const line = buf.getLine(y);
      if (!line) break;
      const text = line.translateToString(false); // full width — index === column
      segs.push({ y, text, start: total });
      total += text.length;
      const next = buf.getLine(y + 1);
      if (next && next.isWrapped) y++;
      else break;
    }
    return segs;
  };

  // Map a global char offset within the logical line to a 1-based cell (x, y).
  const locate = (segs: Seg[], offset: number): { x: number; y: number } | null => {
    for (const seg of segs) {
      if (offset < seg.start + seg.text.length) {
        return { x: offset - seg.start + 1, y: seg.y + 1 };
      }
    }
    return null;
  };

  const findCandidates = (bufferLineNumber: number): Candidate[] => {
    const segs = buildSegments(bufferLineNumber);
    if (!segs.length) return [];
    const full = segs.map((s) => s.text).join('');
    const out: Candidate[] = [];
    PATH_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_TOKEN.exec(full)) && out.length < MAX_CANDIDATES) {
      let s = m.index;
      let e = m.index + m[0].length; // exclusive end
      while (e > s && LEAD.has(full[s])) s++;
      while (e > s && TRAIL.has(full[e - 1])) e--;
      if (e - s < 2) continue;
      const token = full.slice(s, e);
      if (!looksLikePath(token)) continue;
      const start = locate(segs, s);
      const end = locate(segs, e - 1); // inclusive last char, matching xterm ranges
      if (!start || !end) continue;
      out.push({ token, range: { start, end } });
    }
    return out;
  };

  return {
    provideLinks(bufferLineNumber, callback) {
      let candidates: Candidate[];
      try {
        candidates = findCandidates(bufferLineNumber);
      } catch {
        callback(undefined);
        return;
      }
      if (!candidates.length) {
        callback(undefined);
        return;
      }
      const baseDir = opts.getBaseDir();
      Promise.all(
        candidates.map(async (c): Promise<ILink | null> => {
          const res = await probeCached(baseDir, c.token);
          if (!res || !res.exists) return null;
          const absPath = res.absPath;
          return {
            range: c.range,
            text: c.token,
            decorations: { pointerCursor: true, underline: true },
            activate: () => opts.reveal(absPath),
          };
        }),
      )
        .then((links) => callback(links.filter((l): l is ILink => l !== null)))
        .catch(() => callback(undefined));
    },
  };
}

// Cheap pre-filter so we don't fire an existence probe at every prose word.
// A token is worth probing only if it structurally reads as a path.
function looksLikePath(token: string): boolean {
  return (
    token.includes('/') ||
    token.startsWith('~') ||
    token.startsWith('.') ||
    /\.[A-Za-z0-9]{1,8}$/.test(token) // a filename with an extension
  );
}
