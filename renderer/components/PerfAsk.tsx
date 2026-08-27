import { useEffect, useMemo, useRef, useState } from 'react';
import type { PerfReportResult, TrackedDirectory } from '../../shared/types';
import { api } from '../lib/ipc';
import { attachmentPromptLines, imageFilesFromPaste, savePastedImages, type PastedImage } from '../lib/paste-image';
import ImagePreviewModal from './ImagePreviewModal';

/**
 * "Ask about this" — the composer under the performance charts.
 *
 * Reading a spike is one thing; explaining it is another. This freezes exactly
 * what the charts are showing (the chosen window + the live snapshot) into two
 * files and spawns a normal Claude Code session whose first message already
 * carries them — so the answer comes from the numbers, not from a description
 * of them.
 */

const MODELS = ['opus', 'fable', 'sonnet', 'haiku'] as const;
type ModelAlias = (typeof MODELS)[number];
const MODEL_KEY = 'agentsflow:perf:askModel';
const DIR_KEY = 'agentsflow:perf:askDir';

// Kept outside the component so a closed-and-reopened monitor doesn't lose a
// half-typed question (the modal unmounts entirely on ✕ / Esc).
const draft: { prompt: string; images: PastedImage[] } = { prompt: '', images: [] };

interface Props {
  dirs: TrackedDirectory[];
  // Where the session spawns unless the user picks otherwise — normally the
  // peer selected in the sidebar.
  defaultDir: TrackedDirectory | null;
  rangeMin: number;
  rangeLabel: string;
  onSend: (prompt: string, attachments: string[], model: string, directoryId: string) => Promise<void>;
  // Called after a successful spawn so the monitor can get out of the way of
  // the chat it just started.
  onSpawned: () => void;
}

function buildPrompt(question: string, report: PerfReportResult, rangeLabel: string, imagePaths: string[]): string {
  const lines: string[] = [];
  if (question.trim()) lines.push(question.trim());
  lines.push(
    '',
    '---',
    `Attached: a performance report from Peers Flow covering the last ${rangeLabel} (${report.samples} samples). This is the data behind the Performance view I am looking at right now.`,
    '',
    'Read these two files before answering:',
    `- ${report.markdownPath} — digest: verdict, min/median/p95/max per series with sparklines, a downsampled timeline, which agents burned CPU, the exact commands behind the spikes, this app's own main-thread operations.`,
    `- ${report.jsonPath} — the raw samples (5 s apart) behind every table above, if you need to dig further.`,
    '',
    'Ground your answer in those numbers, quote the ones you rely on, and say so explicitly if they do not contain what is needed.',
  );
  lines.push(...attachmentPromptLines(imagePaths));
  return lines.join('\n');
}

export default function PerfAsk({ dirs, defaultDir, rangeMin, rangeLabel, onSend, onSpawned }: Props) {
  const [prompt, setPrompt] = useState(draft.prompt);
  const [images, setImages] = useState<PastedImage[]>(draft.images);
  const [previewing, setPreviewing] = useState<PastedImage | null>(null);
  const [busy, setBusy] = useState<null | 'report' | 'spawn'>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelAlias>('opus');
  const [dirId, setDirId] = useState<string | null>(defaultDir?.id ?? null);
  const [menu, setMenu] = useState<null | 'model' | 'dir'>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Restore the last picks after mount (localStorage during render breaks the
  // exported HTML's hydration — same reason as SpawnBar).
  useEffect(() => {
    try {
      const m = localStorage.getItem(MODEL_KEY);
      if (m && (MODELS as readonly string[]).includes(m)) setModel(m as ModelAlias);
      const d = localStorage.getItem(DIR_KEY);
      if (d) setDirId(d);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { draft.prompt = prompt; }, [prompt]);
  useEffect(() => { draft.images = images; }, [images]);

  // The remembered directory may have been untracked since; fall back to the
  // sidebar selection, then to the first tracked peer.
  const target = useMemo(
    () => dirs.find((d) => d.id === dirId) ?? defaultDir ?? dirs[0] ?? null,
    [dirs, dirId, defaultDir],
  );

  useEffect(() => {
    if (!menu) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menu]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [prompt]);

  const pickModel = (m: ModelAlias) => {
    setModel(m);
    setMenu(null);
    try { localStorage.setItem(MODEL_KEY, m); } catch { /* ignore */ }
  };
  const pickDir = (d: TrackedDirectory) => {
    setDirId(d.id);
    setMenu(null);
    try { localStorage.setItem(DIR_KEY, d.id); } catch { /* ignore */ }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFromPaste(e);
    if (files.length === 0) return;
    e.preventDefault();
    const { images: saved, error: err } = await savePastedImages(files);
    if (saved.length > 0) setImages((prev) => [...prev, ...saved]);
    setError(err);
  };

  const canSend = !!target && !busy;

  const submit = async () => {
    if (!canSend || !target) return;
    setError(null);
    try {
      setBusy('report');
      const save = api().savePerfReport;
      if (typeof save !== 'function') {
        setError('Attaching the perf data needs the latest preload — restart the app (kill electron, then `npm run dev`).');
        return;
      }
      const report = await save(rangeMin);
      setBusy('spawn');
      const imagePaths = images.filter((i) => !!i.savedPath).map((i) => i.savedPath);
      await onSend(
        buildPrompt(prompt, report, rangeLabel, imagePaths),
        [report.markdownPath, report.jsonPath, ...imagePaths],
        model,
        target.id,
      );
      setPrompt('');
      setImages([]);
      draft.prompt = '';
      draft.images = [];
      onSpawned();
    } catch (err) {
      setError(`Could not start the session: ${(err as Error)?.message ?? err}`);
    } finally {
      setBusy(null);
    }
  };

  const btn = 'inline-flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-panel2 border border-border text-[11px] text-text hover:border-accent/60 cursor-pointer';

  return (
    <>
      <div className="shrink-0 border-t border-border bg-panel2/50 px-3 py-2 flex flex-col gap-2">
        {error && (
          <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-err/60 bg-err/10 text-err text-[11px]">
            <span>⚠️</span>
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-err hover:text-text px-1">✕</button>
          </div>
        )}
        {images.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {images.map((img) => (
              <div key={img.id} className="relative">
                <button
                  onClick={() => setPreviewing(img)}
                  className="block w-12 h-12 rounded-md overflow-hidden border border-border bg-panel hover:border-accent"
                  title={img.savedPath}
                >
                  <img src={img.dataUrl} alt="pasted" className="w-full h-full object-cover" />
                </button>
                <button
                  onClick={() => setImages((prev) => prev.filter((i) => i.id !== img.id))}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-bg border border-border text-muted hover:text-err hover:border-err flex items-center justify-center text-[9px]"
                  title="Remove"
                >✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2" ref={menuRef}>
          <div className="shrink-0 relative">
            <button
              type="button"
              onClick={() => setMenu(menu === 'dir' ? null : 'dir')}
              className={`${btn} max-w-[11rem]`}
              title={target ? `The session opens in ${target.path}` : 'Track a directory first'}
              aria-haspopup="menu"
              aria-expanded={menu === 'dir'}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={target ? 'text-accent shrink-0' : 'text-muted shrink-0'}>
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <span className={`truncate ${target ? '' : 'text-muted italic'}`}>{target ? target.displayName : 'no directory'}</span>
              <span className="text-muted text-[9px]">▾</span>
            </button>
            {menu === 'dir' && (
              <div role="menu" className="absolute bottom-full left-0 mb-1 z-30 max-h-64 overflow-y-auto min-w-[13rem] rounded-md border border-border bg-panel2 shadow-lg shadow-black/40 py-1">
                {dirs.length === 0 && <div className="px-3 py-1.5 text-[11px] text-muted italic">No tracked directories.</div>}
                {dirs.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="menuitem"
                    onClick={() => pickDir(d)}
                    className={`w-full text-left pl-2 pr-4 py-1.5 text-[11px] flex items-center gap-1.5 ${d.id === target?.id ? 'bg-accent text-bg' : 'text-text hover:bg-panel'}`}
                  >
                    <span className="w-3 shrink-0 text-center">{d.id === target?.id ? '✓' : ''}</span>
                    <span className="truncate">{d.displayName}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="shrink-0 relative">
            <button
              type="button"
              onClick={() => setMenu(menu === 'model' ? null : 'model')}
              className={`${btn} capitalize font-medium`}
              title="Model the analysis session runs on (claude --model)"
              aria-haspopup="menu"
              aria-expanded={menu === 'model'}
            >
              <span>{model}</span>
              <span className="text-muted text-[9px]">▾</span>
            </button>
            {menu === 'model' && (
              <div role="menu" className="absolute bottom-full left-0 mb-1 z-30 min-w-full rounded-md border border-border bg-panel2 shadow-lg shadow-black/40 py-1">
                {MODELS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="menuitem"
                    onClick={() => pickModel(m)}
                    className={`w-full text-left pl-2 pr-4 py-1.5 text-[11px] capitalize flex items-center gap-1.5 ${m === model ? 'bg-accent text-bg' : 'text-text hover:bg-panel'}`}
                  >
                    <span className="w-3 shrink-0 text-center">{m === model ? '✓' : ''}</span>
                    <span>{m}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
              // The modal closes on Escape; don't let it while a menu is open.
              if (e.key === 'Escape' && menu) { e.stopPropagation(); setMenu(null); }
            }}
            rows={1}
            placeholder={`Ask about the last ${rangeLabel} — e.g. "what made the machine hit 100% at 15:07?" (paste a screenshot too)`}
            className="flex-1 resize-none bg-panel border border-border rounded-md px-3 py-2 text-[12px] text-text outline-none focus:border-accent placeholder:text-muted/70"
          />
          <button
            onClick={() => void submit()}
            disabled={!canSend}
            className="shrink-0 px-3.5 py-2 rounded-md bg-accent text-bg font-medium text-[12px] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent2"
          >
            {busy === 'report' ? 'Capturing…' : busy === 'spawn' ? 'Starting…' : 'Ask'}
          </button>
        </div>
        <div className="text-[10px] text-subtle leading-snug">
          Starts a Claude Code session in {target ? <span className="text-muted">{target.displayName}</span> : 'a tracked directory'} with the last {rangeLabel} of samples
          {' '}+ the live snapshot attached as a report it can read. Empty question ⇒ it explains what it sees.
        </div>
      </div>
      {previewing && (
        <ImagePreviewModal src={previewing.dataUrl} caption={previewing.savedPath} onClose={() => setPreviewing(null)} />
      )}
    </>
  );
}
