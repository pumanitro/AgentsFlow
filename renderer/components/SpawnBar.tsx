import { useEffect, useMemo, useRef, useState } from 'react';
import { SlashCommand, TrackedDirectory } from '../../shared/types';
import { api } from '../lib/ipc';
import { attachmentPromptLines, imageFilesFromPaste, savePastedImages, type PastedImage } from '../lib/paste-image';
import ImagePreviewModal from './ImagePreviewModal';

interface Props {
  targetDir: TrackedDirectory | null;
  onSend: (prompt: string, attachments: string[], model: string) => Promise<void>;
}

// Short model aliases passed straight to `claude --model`. The CLI resolves each
// to the latest model in that family, so these stay correct as models roll over.
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
type ModelAlias = (typeof MODELS)[number];
const MODEL_STORAGE_KEY = 'agentsflow.spawnModel';

function loadModel(): ModelAlias {
  try {
    const saved = window.localStorage.getItem(MODEL_STORAGE_KEY);
    if (saved && (MODELS as readonly string[]).includes(saved)) return saved as ModelAlias;
  } catch {
    /* localStorage unavailable — fall through to default */
  }
  return 'fable';
}

// Survives navigation to /session and back. Cleared only after a successful send.
const draft: { prompt: string; images: PastedImage[] } = { prompt: '', images: [] };

export default function SpawnBar({ targetDir, onSend }: Props) {
  const [prompt, setPrompt] = useState(draft.prompt);
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<PastedImage[]>(draft.images);
  const [previewing, setPreviewing] = useState<PastedImage | null>(null);
  // Start from the deterministic default so the first client render matches the
  // SSR/exported HTML; the persisted pick is loaded after mount (below).
  const [model, setModel] = useState<ModelAlias>('fable');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const skipFirstModelPersist = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Load the saved model after mount. Reading localStorage during render (the
  // previous useState initializer) mismatched the server-rendered HTML — which
  // always emits the 'fable' default — and threw a React hydration error.
  useEffect(() => { setModel(loadModel()); }, []);

  // Remember the picked model across sends and app restarts. Skip the first run
  // so the mount-time default doesn't clobber a stored value before the hydrate
  // effect above has swapped it in.
  useEffect(() => {
    if (skipFirstModelPersist.current) { skipFirstModelPersist.current = false; return; }
    try { window.localStorage.setItem(MODEL_STORAGE_KEY, model); } catch { /* ignore */ }
  }, [model]);

  // Close the model menu on outside-click / Escape.
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) setModelMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModelMenuOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [modelMenuOpen]);

  // --- Slash command / skill autocomplete --------------------------------
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  // Caret position in the textarea — lets the slash menu trigger on the token
  // being typed at the cursor, anywhere in the prompt (not just at the start).
  const [caret, setCaret] = useState(draft.prompt.length);
  // Signature ("start:query") of the slash token the user dismissed via Esc.
  // The menu stays hidden until that token changes, so Esc actually closes it.
  const [dismissedSig, setDismissedSig] = useState<string | null>(null);

  // (Re)load the available commands whenever the spawn target changes. Project
  // (.claude in the target dir) shadows user-level (~/.claude) entries.
  useEffect(() => {
    let alive = true;
    api()
      .listSlashCommands(targetDir?.path ?? null)
      .then((cmds) => { if (alive) setSlashCommands(cmds); })
      .catch(() => { if (alive) setSlashCommands([]); });
    return () => { alive = false; };
  }, [targetDir?.path]);

  // Find a "/token" at the caret: the word being typed just before the cursor
  // that starts with "/". This works ANYWHERE in the prompt, so a command/skill
  // can be dropped mid-message and several can be stacked — the spawned agent
  // invokes each one it sees (via its Skill tool) regardless of position. A "/"
  // preceded by a non-space (e.g. "src/file") is ignored so paths don't trigger.
  const slashCtx = useMemo(() => {
    const before = prompt.slice(0, caret);
    const m = /(?:^|\s)\/([^\s]*)$/.exec(before);
    if (!m) return null;
    const query = m[1];
    return { query, start: caret - query.length - 1 };
  }, [prompt, caret]);
  const slashQuery = slashCtx?.query ?? null;
  const slashSig = slashCtx ? `${slashCtx.start}:${slashCtx.query}` : null;

  const filtered = useMemo(() => {
    if (slashQuery === null) return [] as SlashCommand[];
    const q = slashQuery.toLowerCase();
    return slashCommands
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.name.localeCompare(b.name);
      });
  }, [slashCommands, slashQuery]);

  const menuOpen = slashCtx !== null && slashSig !== dismissedSig && filtered.length > 0;

  // Keep the highlighted row valid as the filtered set shrinks/grows.
  useEffect(() => { setMenuIndex(0); }, [slashQuery]);
  useEffect(() => {
    if (menuIndex > filtered.length - 1) setMenuIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, menuIndex]);

  // Every "/name" token that resolves to a known command/skill, surfaced as a
  // chip so the user sees which ones their prompt will run (now possibly many).
  const activeCommands = useMemo(() => {
    const out: SlashCommand[] = [];
    const re = /(?:^|\s)\/([^\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prompt)) !== null) {
      const cmd = slashCommands.find((c) => c.name === m![1]);
      if (cmd && !out.includes(cmd)) out.push(cmd);
    }
    return out;
  }, [prompt, slashCommands]);

  const chooseCommand = (cmd: SlashCommand) => {
    // Replace only the "/token" at the caret with the invocation + a space, so
    // surrounding text is preserved and the user can keep typing (or add more).
    if (!slashCtx) return;
    const before = prompt.slice(0, slashCtx.start);
    const after = prompt.slice(caret);
    const insert = `${cmd.invocation} `;
    const pos = before.length + insert.length;
    setPrompt(before + insert + after);
    setCaret(pos);
    setDismissedSig(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  useEffect(() => { draft.prompt = prompt; }, [prompt]);
  useEffect(() => { draft.images = images; }, [images]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + 'px';
    }
  }, [prompt]);

  const validImages = images.filter((i) => !!i.savedPath);
  const disabled = !targetDir || busy || (!prompt.trim() && validImages.length === 0);

  const [pasteError, setPasteError] = useState<string | null>(null);

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFromPaste(e);
    if (files.length === 0) return;
    e.preventDefault();
    const { images: saved, error } = await savePastedImages(files);
    if (saved.length > 0) setImages((prev) => [...prev, ...saved]);
    setPasteError(error);
  };

  const removeImage = (id: string) => setImages((prev) => prev.filter((i) => i.id !== id));

  const buildFullPrompt = () => {
    const lines: string[] = [];
    if (prompt.trim()) lines.push(prompt.trim());
    lines.push(...attachmentPromptLines(images.filter((img) => !!img.savedPath).map((img) => img.savedPath)));
    return lines.join('\n');
  };

  const submit = async () => {
    if (disabled || !targetDir) return;
    const finalPrompt = buildFullPrompt();
    if (!finalPrompt) return;
    const attachments = validImages.map((i) => i.savedPath);
    setBusy(true);
    try {
      await onSend(finalPrompt, attachments, model);
      setPrompt('');
      setCaret(0);
      setImages([]);
      // Release keyboard focus from the textarea so the global Shift+↑/↓ reorder
      // handler (which ignores keys while an input/textarea is focused) works
      // immediately on the just-spawned chat — otherwise the cursor stays trapped
      // here and moving items silently does nothing until the user clicks away.
      textareaRef.current?.blur();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="relative border-t border-border bg-panel/80 backdrop-blur px-4 py-3 flex flex-col gap-2">
        {menuOpen && (
          <div className="absolute bottom-full left-4 right-4 mb-2 z-30 rounded-lg border border-accent/60 bg-bg shadow-xl shadow-black/40 overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted border-b border-border bg-panel2/60">
              Slash commands{slashQuery ? ` · /${slashQuery}` : ''}
            </div>
            <ul className="max-h-64 overflow-y-auto py-1">
              {filtered.map((cmd, i) => {
                const selected = i === menuIndex;
                return (
                  <li key={`${cmd.scope}:${cmd.name}`}>
                    <button
                      type="button"
                      onMouseEnter={() => setMenuIndex(i)}
                      onMouseDown={(e) => { e.preventDefault(); chooseCommand(cmd); }}
                      className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 ${
                        selected ? 'bg-accent text-bg' : 'text-text hover:bg-panel2'
                      }`}
                    >
                      <span className="font-medium shrink-0">{cmd.invocation}</span>
                      <span
                        className={`text-[10px] px-1.5 py-px rounded-full shrink-0 ${
                          selected
                            ? 'bg-bg/20 text-bg'
                            : cmd.scope === 'project'
                              ? 'bg-accent/20 text-accent'
                              : 'bg-panel2 text-muted'
                        }`}
                      >
                        {cmd.kind === 'skill' ? 'skill' : cmd.scope}
                      </span>
                      <span className={`text-xs truncate ${selected ? 'text-bg/80' : 'text-muted'}`}>
                        {cmd.description}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="px-3 py-1 text-[10px] text-muted border-t border-border bg-panel2/60">
              ↑↓ to navigate · ↵ / Tab to select · Esc to dismiss
            </div>
          </div>
        )}
        {activeCommands.length > 0 && !menuOpen && (
          <div className="flex items-center gap-2 text-xs flex-wrap">
            {activeCommands.map((cmd) => (
              <span
                key={`${cmd.scope}:${cmd.name}`}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-accent/15 border border-accent/50 text-accent font-medium"
                title={cmd.description}
              >
                <span>⚡</span>
                <span>{cmd.invocation}</span>
              </span>
            ))}
          </div>
        )}
        {pasteError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-err/60 bg-err/10 text-err text-xs">
            <span>⚠️</span>
            <span className="flex-1">{pasteError}</span>
            <button onClick={() => setPasteError(null)} className="text-err hover:text-text px-1.5">✕</button>
          </div>
        )}
        {images.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {images.map((img) => (
              <div key={img.id} className="relative group">
                <button
                  onClick={() => setPreviewing(img)}
                  className="block w-16 h-16 rounded-md overflow-hidden border border-border bg-panel hover:border-accent"
                  title={img.savedPath || 'preview image'}
                >
                  <img src={img.dataUrl} alt="pasted" className="w-full h-full object-cover" />
                </button>
                <button
                  onClick={() => removeImage(img.id)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-bg border border-border text-muted hover:text-err hover:border-err flex items-center justify-center text-[10px]"
                  title="Remove"
                >✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <div
            className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-panel2 border border-border text-xs max-w-[10rem]"
            title={targetDir ? `Spawn in ${targetDir.displayName}` : 'Select a directory to spawn in'}
          >
            <svg
              width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              className={`shrink-0 ${targetDir ? 'text-accent' : 'text-muted'}`}
            >
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span className={`truncate ${targetDir ? 'text-text font-medium' : 'text-muted italic'}`}>
              {targetDir ? targetDir.displayName : 'select a directory'}
            </span>
          </div>
          <div className="shrink-0 relative" ref={modelMenuRef}>
            <button
              type="button"
              onClick={() => setModelMenuOpen((v) => !v)}
              title="Model the spawned agent runs on (claude --model)"
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen}
              className="inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 rounded-md bg-panel2 border border-border text-xs font-medium text-text capitalize outline-none cursor-pointer hover:border-accent/60 focus:border-accent"
            >
              <span>{model}</span>
              <span className="text-muted text-[10px]">▾</span>
            </button>
            {modelMenuOpen && (
              <div
                role="menu"
                className="absolute bottom-full left-0 mb-1 z-30 min-w-full rounded-md border border-border bg-panel2 shadow-lg shadow-black/40 py-1"
              >
                {MODELS.map((m) => {
                  const active = m === model;
                  return (
                    <button
                      key={m}
                      type="button"
                      role="menuitem"
                      onClick={() => { setModel(m); setModelMenuOpen(false); }}
                      className={`w-full text-left pl-2 pr-4 py-1.5 text-xs capitalize flex items-center gap-1.5 ${
                        active ? 'bg-accent text-bg' : 'text-text hover:bg-panel'
                      }`}
                    >
                      <span className="w-3 shrink-0 text-center">{active ? '✓' : ''}</span>
                      <span>{m}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => { setPrompt(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (menuOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMenuIndex((i) => (i + 1) % filtered.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMenuIndex((i) => (i - 1 + filtered.length) % filtered.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  const pick = filtered[menuIndex];
                  if (pick) chooseCommand(pick);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setDismissedSig(slashSig);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={targetDir ? 'Type a prompt or paste images and press Enter…' : 'Paste images now, then click a directory to send…'}
            rows={1}
            className="flex-1 resize-none bg-panel border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent placeholder:text-muted/70"
          />
          <button
            onClick={submit}
            disabled={disabled}
            className="shrink-0 px-4 py-2 rounded-md bg-accent text-bg font-medium text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent2"
          >
            {busy ? 'Spawning…' : 'Send'}
          </button>
        </div>
      </div>
      {previewing && (
        <ImagePreviewModal
          src={previewing.dataUrl}
          caption={previewing.savedPath}
          onClose={() => setPreviewing(null)}
        />
      )}
    </>
  );
}
