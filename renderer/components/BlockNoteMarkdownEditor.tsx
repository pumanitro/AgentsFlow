import { useCallback, useEffect, useRef, useState } from 'react';
import { BlockNoteEditor as BNEditorInstance, Block } from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/ariakit';
import { api } from '../lib/ipc';

interface Props {
  filePath: string;
  baseDir?: string;
  autoFocus?: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function relPath(filePath: string, baseDir?: string): string {
  if (!baseDir) return filePath;
  if (filePath === baseDir) return filePath;
  if (filePath.startsWith(baseDir + '/')) return filePath.slice(baseDir.length + 1);
  return filePath;
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function resolveImageRef(ref: string, mdAbsPath: string, baseDir?: string): string | null {
  if (!ref) return null;
  // Skip remote / data / protocol URLs.
  if (/^(https?:|data:|file:|blob:)/i.test(ref)) return null;
  // Strip optional surrounding angle brackets and any trailing " title".
  let r = ref.trim();
  if (r.startsWith('<') && r.endsWith('>')) r = r.slice(1, -1).trim();
  const spaceIdx = r.search(/\s/);
  if (spaceIdx >= 0) r = r.slice(0, spaceIdx);
  if (!r) return null;
  if (r.startsWith('/')) return r; // absolute filesystem path
  // Relative — resolve against the markdown file's directory, fall back to baseDir.
  const root = dirname(mdAbsPath) || baseDir || '';
  const parts = (root + '/' + r).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return '/' + out.join('/');
}

/**
 * Rewrite local image references in markdown to inline data URLs so the
 * BlockNote view can render them — the renderer sandbox can't fetch local
 * files directly. Skips remote/data/blob URLs and silently leaves unresolved
 * paths in place. Returns the rewritten markdown and a reverse map so the
 * save path can restore the original refs before writing back to disk.
 */
async function inlineLocalImages(
  markdown: string,
  filePath: string,
  baseDir?: string,
): Promise<{ markdown: string; restoreMap: Map<string, string> }> {
  // Match standard markdown images: ![alt](path "optional title")
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const matches: { full: string; alt: string; inside: string; absPath: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const abs = resolveImageRef(m[2], filePath, baseDir);
    if (!abs) continue;
    matches.push({ full: m[0], alt: m[1], inside: m[2], absPath: abs });
  }
  if (matches.length === 0) return { markdown, restoreMap: new Map() };

  const unique = Array.from(new Set(matches.map((x) => x.absPath)));
  const dataUrls = new Map<string, string>();
  await Promise.all(unique.map(async (abs) => {
    try {
      const res = await api().readBinaryFile(abs);
      if (res && res.dataUrl) dataUrls.set(abs, res.dataUrl);
    } catch {
      // ignore — leave the original path in the markdown
    }
  }));

  // Reverse map: dataUrl → original inside-parens ref. Used at save time to
  // swap inlined data URLs back to the on-disk reference. If multiple refs
  // share the same image content (and thus the same data URL), the first one
  // wins — duplicating an image block in the editor will collapse to that
  // single original path, which is harmless and rare.
  const restoreMap = new Map<string, string>();
  let out = markdown;
  for (const x of matches) {
    const dataUrl = dataUrls.get(x.absPath);
    if (!dataUrl) continue;
    if (!restoreMap.has(dataUrl)) restoreMap.set(dataUrl, x.inside);
    out = out.replace(x.full, `![${x.alt}](${dataUrl})`);
  }
  return { markdown: out, restoreMap };
}

/**
 * Reverse of inlineLocalImages — replaces inlined data URLs in serialized
 * markdown with the original on-disk refs so saves don't bloat the file.
 */
function restoreImageRefs(markdown: string, restoreMap: Map<string, string>): string {
  if (restoreMap.size === 0) return markdown;
  return markdown.replace(/!\[([^\]]*)\]\((data:[^)]+)\)/g, (full, alt: string, url: string) => {
    const original = restoreMap.get(url);
    return original ? `![${alt}](${original})` : full;
  });
}

/**
 * Inner editor — owns the BlockNote instance. Receives the parsed initial blocks
 * so `useCreateBlockNote` only runs once with a stable initialContent.
 */
function Inner({
  filePath,
  baseDir,
  initialBlocks,
  initialMarkdown,
  size,
  restoreMap,
  autoFocus,
}: {
  filePath: string;
  baseDir?: string;
  initialBlocks: Block[];
  initialMarkdown: string;
  size: number;
  restoreMap: Map<string, string>;
  autoFocus?: boolean;
}) {
  const editor = useCreateBlockNote({ initialContent: initialBlocks });

  useEffect(() => {
    if (!autoFocus) return;
    try { editor.focus(); } catch {}
  }, [autoFocus, editor]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSavedMd = useRef<string>(initialMarkdown);
  const restoreRef = useRef(restoreMap);
  restoreRef.current = restoreMap;

  // Track dirtiness by serializing on every change and comparing to the last-saved markdown.
  useEffect(() => {
    const off = editor.onChange(async () => {
      try {
        const md = restoreImageRefs(
          await editor.blocksToMarkdownLossy(editor.document),
          restoreRef.current,
        );
        setDirty(md !== lastSavedMd.current);
      } catch {
        // ignore — keep last known state
      }
    });
    return () => { off?.(); };
  }, [editor]);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const md = restoreImageRefs(
        await editor.blocksToMarkdownLossy(editor.document),
        restoreRef.current,
      );
      await api().writeTextFile(filePath, md);
      lastSavedMd.current = md;
      setDirty(false);
      setSavedAt(Date.now());
    } catch (err) {
      setError(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [editor, filePath, saving]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const display = relPath(filePath, baseDir);

  return (
    <div className="h-full flex flex-col bg-bg">
      <header className="shrink-0 px-3 py-1.5 border-b border-border flex items-center gap-3 bg-panel/60">
        <span className="text-xs font-mono text-text/90 truncate flex-1" title={filePath}>
          {display}
          {dirty && <span className="ml-2 text-accent" title="Unsaved changes">●</span>}
        </span>
        <span className="text-[10px] text-muted shrink-0">{formatBytes(size)} · BlockNote</span>
        {savedAt && !dirty && <span className="text-[10px] text-ok shrink-0">Saved</span>}
        {error && <span className="text-[10px] text-err shrink-0 truncate max-w-[40%]" title={error}>{error}</span>}
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="text-xs px-3 py-1 rounded-md bg-accent text-bg font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:bg-accent2"
          title="Save (⌘S)"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto blocknote-host">
        <BlockNoteView editor={editor} theme="dark" />
      </div>
    </div>
  );
}

export default function BlockNoteMarkdownEditor({ filePath, baseDir, autoFocus }: Props) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; blocks: Block[]; markdown: string; size: number; restoreMap: Map<string, string> }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      try {
        const res = await api().readTextFile(filePath);
        if (cancelled) return;
        if (res.error) { setState({ kind: 'error', message: res.error }); return; }
        if (res.binary) { setState({ kind: 'error', message: 'Binary file — preview not supported' }); return; }
        if (res.truncated) { setState({ kind: 'error', message: `File too large (${formatBytes(res.size)})` }); return; }

        const { markdown: inlined, restoreMap } = await inlineLocalImages(res.content, filePath, baseDir);
        if (cancelled) return;
        // Spin up a throwaway editor just to use the markdown parser.
        const parser = BNEditorInstance.create();
        const blocks = (await parser.tryParseMarkdownToBlocks(inlined)) as Block[];
        if (cancelled) return;
        setState({ kind: 'ready', blocks, markdown: res.content, size: res.size, restoreMap });
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', message: (err as Error).message });
      }
    })();
    return () => { cancelled = true; };
  }, [filePath, baseDir]);

  if (state.kind === 'loading') {
    return <div className="h-full flex items-center justify-center text-muted text-sm">Loading…</div>;
  }
  if (state.kind === 'error') {
    return <div className="h-full flex items-center justify-center text-muted text-sm text-center px-6">{state.message}</div>;
  }
  return (
    <Inner
      key={filePath /* force fresh editor when the file path changes */}
      filePath={filePath}
      baseDir={baseDir}
      initialBlocks={state.blocks}
      initialMarkdown={state.markdown}
      size={state.size}
      restoreMap={state.restoreMap}
      autoFocus={autoFocus}
    />
  );
}
