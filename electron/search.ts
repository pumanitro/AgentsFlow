import * as fs from 'fs';
import * as path from 'path';
import { listFiles } from './git';
import type { SearchFileResult, SearchMatchLine, SearchOptions, SearchResult } from '../shared/types';

// Caps keep an interactive search responsive even on large repos. They mirror
// the editor's own limits (2 MB / file) so we never scan something we couldn't
// open anyway, and bound total work so a broad query can't hang the UI.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_TOTAL_MATCHES = 2000;
const MAX_MATCHES_PER_FILE = 200;
const MAX_LINE_LENGTH = 500; // clip very long lines in the result payload

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMatcher(query: string, opts: SearchOptions): RegExp {
  const flags = opts.caseSensitive ? 'g' : 'gi';
  const pattern = opts.isRegex ? query : escapeRegExp(query);
  return new RegExp(pattern, flags);
}

// Collect all match ranges for `re` within a single line. We clip the stored
// text (and any ranges past the clip point) so a minified one-liner can't bloat
// the payload. Guards against zero-width regex matches looping forever.
function matchLine(line: string, re: RegExp): { text: string; ranges: [number, number][] } | null {
  re.lastIndex = 0;
  const ranges: [number, number][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (start < MAX_LINE_LENGTH) ranges.push([start, Math.min(end, MAX_LINE_LENGTH)]);
    if (m[0].length === 0) re.lastIndex++; // avoid infinite loop on empty matches
    if (ranges.length >= 1000) break;
  }
  if (ranges.length === 0) return null;
  const text = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '…' : line;
  return { text, ranges };
}

export async function searchInFiles(
  dirPath: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const empty: SearchResult = { files: [], totalMatches: 0, filesScanned: 0, truncated: false };
  if (!query) return empty;

  let re: RegExp;
  try {
    re = buildMatcher(query, opts);
  } catch (err) {
    return { ...empty, error: `Invalid pattern: ${(err as Error).message}` };
  }

  try {
    fs.accessSync(dirPath);
  } catch {
    return empty;
  }

  // Search the exact set the Files tree shows: tracked + untracked-but-not-ignored.
  const entries = (await listFiles(dirPath)).filter((e) => !e.isIgnored);

  const files: SearchFileResult[] = [];
  let totalMatches = 0;
  let filesScanned = 0;
  let truncated = false;

  for (const entry of entries) {
    if (filesScanned >= MAX_FILES || totalMatches >= MAX_TOTAL_MATCHES) {
      truncated = true;
      break;
    }
    const full = path.join(dirPath, entry.path);
    let buf: Buffer;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) continue;
      buf = await fs.promises.readFile(full);
    } catch {
      continue;
    }
    // Skip binaries the same way the editor sniffs them: a NUL in the head.
    const sniff = buf.subarray(0, Math.min(buf.length, 8192));
    if (sniff.includes(0)) continue;

    filesScanned++;
    const lines = buf.toString('utf8').split('\n');
    const matches: SearchMatchLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      const res = matchLine(lines[i], re);
      if (!res) continue;
      matches.push({ line: i + 1, text: res.text, ranges: res.ranges });
      totalMatches++;
      if (matches.length >= MAX_MATCHES_PER_FILE || totalMatches >= MAX_TOTAL_MATCHES) {
        truncated = true;
        break;
      }
    }
    if (matches.length > 0) files.push({ path: entry.path, matches });
  }

  return { files, totalMatches, filesScanned, truncated };
}
