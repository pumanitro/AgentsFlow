import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/ipc';
import CodeMirror, { Extension } from '@uiw/react-codemirror';
import BlockNoteMarkdownEditor from './BlockNoteMarkdownEditor';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { oneDark } from '@codemirror/theme-one-dark';

interface Props {
  filePath: string;
  baseDir?: string;
  autoFocus?: boolean;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const SVG_EXT = 'svg';
const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
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

function languageFor(ext: string): Extension[] {
  switch (ext) {
    case 'ts':
    case 'tsx': return [javascript({ jsx: true, typescript: true })];
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs': return [javascript({ jsx: true })];
    case 'py':
    case 'pyw': return [python()];
    case 'json':
    case 'jsonc': return [json()];
    case 'md':
    case 'mdx':
    case 'markdown': return [markdown()];
    case 'css':
    case 'scss':
    case 'sass':
    case 'less': return [css()];
    case 'html':
    case 'htm': return [html()];
    case 'xml':
    case 'svg':
    case 'plist':
    case 'xib': return [xml()];
    default: return [];
  }
}

function ImageView({ filePath, baseDir }: Props) {
  const [state, setState] = useState<{ dataUrl?: string; size?: number; truncated?: boolean; error?: string } | null>(null);
  const ext = fileExt(filePath);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    api().readBinaryFile(filePath).then((r) => {
      if (cancelled) return;
      if (r.error) setState({ error: r.error });
      else if (r.truncated) setState({ error: `Image too large to preview (${formatBytes(r.size)}). The viewer caps at 8 MB.` });
      else setState({ dataUrl: r.dataUrl, size: r.size });
    });
    return () => { cancelled = true; };
  }, [filePath]);

  const display = relPath(filePath, baseDir);

  return (
    <div className="h-full flex flex-col bg-bg">
      <header className="shrink-0 px-3 py-1.5 border-b border-border flex items-center gap-3 bg-panel/60">
        <span className="text-xs font-mono text-text/90 truncate flex-1" title={filePath}>{display}</span>
        <span className="text-[10px] text-muted shrink-0 uppercase">{ext}</span>
        {state?.size != null && <span className="text-[10px] text-muted shrink-0">{formatBytes(state.size)}</span>}
      </header>
      <div className="flex-1 relative min-h-0 flex items-center justify-center p-6 overflow-hidden bg-[repeating-linear-gradient(45deg,#161922_0,#161922_10px,#1c2030_10px,#1c2030_20px)]/[.0]">
        {!state ? (
          <div className="text-muted text-sm">Loading…</div>
        ) : state.error ? (
          <div className="text-muted text-sm text-center">{state.error}</div>
        ) : (
          <img
            src={state.dataUrl}
            alt={display}
            className="max-w-full max-h-full object-contain rounded shadow-2xl"
            style={{ imageRendering: 'pixelated' }}
          />
        )}
      </div>
    </div>
  );
}

function TextEditor({ filePath, baseDir, autoFocus }: Props) {
  const [content, setContent] = useState<string>('');
  const [draft, setDraft] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ size: number; binary: boolean; truncated: boolean } | null>(null);

  const ext = fileExt(filePath);
  const extensions = useMemo(() => languageFor(ext), [ext]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSavedAt(null);
    api()
      .readTextFile(filePath)
      .then((res) => {
        if (cancelled) return;
        if (res.error) setError(res.error);
        else if (res.binary) setError('Binary file — preview not supported');
        else if (res.truncated) setError(`File too large to open (${formatBytes(res.size)}). The editor caps at 2 MB.`);
        else { setContent(res.content); setDraft(res.content); }
        setMeta({ size: res.size, binary: res.binary, truncated: res.truncated });
      })
      .catch((err) => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filePath]);

  const dirty = !loading && !error && draft !== content;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await api().writeTextFile(filePath, draft);
      setContent(draft);
      setSavedAt(Date.now());
    } catch (err) {
      setError(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, draft, content, saving]);

  const display = relPath(filePath, baseDir);
  const lines = draft ? draft.split('\n').length : 0;

  return (
    <div className="h-full flex flex-col bg-bg">
      <header className="shrink-0 px-3 py-1.5 border-b border-border flex items-center gap-3 bg-panel/60">
        <span className="text-xs font-mono text-text/90 truncate flex-1" title={filePath}>
          {display}
          {dirty && <span className="ml-2 text-accent" title="Unsaved changes">●</span>}
        </span>
        {meta && !error && (
          <span className="text-[10px] text-muted shrink-0">
            {formatBytes(meta.size)} · {lines.toLocaleString()} {lines === 1 ? 'line' : 'lines'}
          </span>
        )}
        {savedAt && !dirty && (
          <span className="text-[10px] text-ok shrink-0">Saved</span>
        )}
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="text-xs px-3 py-1 rounded-md bg-accent text-bg font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:bg-accent2"
          title="Save (⌘S)"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>

      <div className="flex-1 relative min-h-0 overflow-hidden">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">Loading…</div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted text-sm text-center px-6">{error}</div>
        ) : (
          <CodeMirror
            value={draft}
            onChange={(v) => setDraft(v)}
            theme={oneDark}
            extensions={extensions}
            height="100%"
            autoFocus={autoFocus}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
              bracketMatching: true,
              autocompletion: false,
              indentOnInput: true,
            }}
            className="h-full text-[13px]"
          />
        )}
      </div>
    </div>
  );
}

export default function FileEditor({ filePath, baseDir, autoFocus }: Props) {
  const ext = fileExt(filePath);
  // SVG is also text, but we preview it visually rather than as XML markup.
  if (IMAGE_EXTS.has(ext) || ext === SVG_EXT) {
    return <ImageView filePath={filePath} baseDir={baseDir} />;
  }
  if (MARKDOWN_EXTS.has(ext)) {
    return <BlockNoteMarkdownEditor filePath={filePath} baseDir={baseDir} autoFocus={autoFocus} />;
  }
  return <TextEditor filePath={filePath} baseDir={baseDir} autoFocus={autoFocus} />;
}
