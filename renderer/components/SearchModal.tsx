import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/ipc';
import { SearchResult } from '../../shared/types';

interface Props {
  dirPath: string;
  // Opens a file in the editor pane, optionally jumping to a 1-based line.
  onOpen: (absPath: string, line?: number) => void;
  onClose: () => void;
}

// Render a line of text with the matched ranges highlighted.
function HighlightedLine({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (start > cursor) parts.push(<span key={`p${i}`}>{text.slice(cursor, start)}</span>);
    parts.push(
      <span key={`m${i}`} className="bg-accent/30 text-accent2 rounded-sm">
        {text.slice(start, end)}
      </span>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>);
  return <>{parts}</>;
}

export default function SearchModal({ dirPath, onOpen, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Flat index over all match rows, for keyboard navigation.
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Flatten matches into a single addressable list so ↑/↓ + Enter can walk them.
  const flat = useMemo(() => {
    const rows: { path: string; line: number }[] = [];
    for (const f of result?.files ?? []) {
      for (const m of f.matches) rows.push({ path: f.path, line: m.line });
    }
    return rows;
  }, [result]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Debounced search whenever the query or options change.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResult(null); setLoading(false); return; }
    const a = api();
    if (typeof a.searchFiles !== 'function') {
      setLoading(false);
      setResult({ files: [], totalMatches: 0, filesScanned: 0, truncated: false, error: 'Restart the app to enable search (preload needs to refresh after pulling new code).' });
      return;
    }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(() => {
      a
        .searchFiles(dirPath, q, { caseSensitive, isRegex })
        .then((r) => { if (!cancelled) { setResult(r); setSelected(0); } })
        .catch((err) => { if (!cancelled) setResult({ files: [], totalMatches: 0, filesScanned: 0, truncated: false, error: `Search failed: ${(err as Error)?.message ?? String(err)}` }); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, caseSensitive, isRegex, dirPath]);

  const openRow = (idx: number) => {
    const row = flat[idx];
    if (!row) return;
    onOpen(`${dirPath}/${row.path}`, row.line);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(0, flat.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openRow(selected);
    }
  };

  // Keep the selected row scrolled into view as the user navigates.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-row="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const summary = result
    ? result.error
      ? result.error
      : `${result.totalMatches} match${result.totalMatches === 1 ? '' : 'es'} in ${result.files.length} file${result.files.length === 1 ? '' : 's'}${result.truncated ? ' (truncated)' : ''}`
    : '';

  let rowIdx = -1; // running flat index assigned as we render match rows

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-bg/70 backdrop-blur-sm pt-[8vh]"
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      <div
        className="bg-panel border border-border rounded-lg shadow-2xl w-[760px] max-w-[92vw] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search bar */}
        <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-muted shrink-0">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 L14 14" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find in files…"
            spellCheck={false}
            className="flex-1 bg-transparent outline-none text-sm text-text placeholder:text-subtle"
          />
          <button
            onClick={() => setCaseSensitive((v) => !v)}
            title="Match case"
            className={`px-1.5 py-0.5 rounded text-[12px] font-mono border ${caseSensitive ? 'bg-accent text-bg border-accent font-semibold' : 'text-muted border-border hover:text-text hover:bg-panel2'}`}
          >Aa</button>
          <button
            onClick={() => setIsRegex((v) => !v)}
            title="Use regular expression"
            className={`px-1.5 py-0.5 rounded text-[12px] font-mono border ${isRegex ? 'bg-accent text-bg border-accent font-semibold' : 'text-muted border-border hover:text-text hover:bg-panel2'}`}
          >.*</button>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="px-1.5 py-0.5 rounded text-muted hover:text-text hover:bg-panel2"
          >✕</button>
        </div>

        {/* Summary */}
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-muted border-b border-border flex items-center gap-2">
          {loading ? 'Searching…' : query.trim() ? summary || 'No matches.' : 'Type to search the files in this directory.'}
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto text-[13px]">
          {result && !result.error && result.files.map((f) => (
            <div key={f.path}>
              <div className="sticky top-0 z-10 bg-panel2 px-3 py-1 text-[12px] text-text/90 font-mono border-b border-border flex items-center gap-2">
                <span className="truncate">{f.path}</span>
                <span className="ml-auto text-[10px] text-muted shrink-0">{f.matches.length}</span>
              </div>
              {f.matches.map((m) => {
                rowIdx++;
                const idx = rowIdx;
                const active = idx === selected;
                return (
                  <div
                    key={`${f.path}:${m.line}`}
                    data-row={idx}
                    onClick={() => openRow(idx)}
                    onMouseEnter={() => setSelected(idx)}
                    className={`flex gap-3 px-3 py-0.5 cursor-pointer font-mono ${active ? 'bg-panel2 border-l-2 border-l-accent' : 'border-l-2 border-l-transparent hover:bg-panel2/60'}`}
                  >
                    <span className="text-muted text-right w-10 shrink-0 select-none tabular-nums">{m.line}</span>
                    <span className="whitespace-pre truncate text-text/85">
                      <HighlightedLine text={m.text} ranges={m.ranges} />
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
