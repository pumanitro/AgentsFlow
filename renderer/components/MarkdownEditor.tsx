import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/ipc';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { markdownLivePreview } from '../lib/cm-markdown-live';

interface Props {
  filePath: string;
  baseDir?: string;
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

export default function MarkdownEditor({ filePath, baseDir }: Props) {
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ size: number } | null>(null);

  const extensions = useMemo(() => [
    markdown(),
    markdownLivePreview,
    EditorView.lineWrapping,
  ], []);

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
        setMeta({ size: res.size });
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

  return (
    <div className="h-full flex flex-col bg-bg">
      <header className="shrink-0 px-3 py-1.5 border-b border-border flex items-center gap-3 bg-panel/60">
        <span className="text-xs font-mono text-text/90 truncate flex-1" title={filePath}>
          {display}
          {dirty && <span className="ml-2 text-accent" title="Unsaved changes">●</span>}
        </span>
        {meta && !error && (
          <span className="text-[10px] text-muted shrink-0">{formatBytes(meta.size)}</span>
        )}
        {savedAt && !dirty && <span className="text-[10px] text-ok shrink-0">Saved</span>}
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
          <div className="absolute inset-0 overflow-y-auto">
            <CodeMirror
              value={draft}
              onChange={(v) => setDraft(v)}
              theme={oneDark}
              extensions={extensions}
              height="100%"
              basicSetup={{
                lineNumbers: false,
                foldGutter: false,
                highlightActiveLine: false,
                bracketMatching: true,
                autocompletion: false,
              }}
              className="h-full text-[14px]"
            />
          </div>
        )}
      </div>
    </div>
  );
}
