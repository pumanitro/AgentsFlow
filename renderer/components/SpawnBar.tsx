import { useEffect, useRef, useState } from 'react';
import { TrackedDirectory } from '../../shared/types';
import { api } from '../lib/ipc';
import ImagePreviewModal from './ImagePreviewModal';

interface PastedImage {
  id: string;
  dataUrl: string;
  savedPath: string;
}

interface Props {
  targetDir: TrackedDirectory | null;
  onSend: (prompt: string, attachments: string[]) => Promise<void>;
}

// Survives navigation to /session and back. Cleared only after a successful send.
const draft: { prompt: string; images: PastedImage[] } = { prompt: '', images: [] };

function blobToBase64(blob: Blob): Promise<{ base64: string; dataUrl: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
      if (!m) return reject(new Error('unexpected dataURL format'));
      resolve({ mime: m[1], base64: m[2], dataUrl });
    };
    reader.readAsDataURL(blob);
  });
}

export default function SpawnBar({ targetDir, onSend }: Props) {
  const [prompt, setPrompt] = useState(draft.prompt);
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<PastedImage[]>(draft.images);
  const [previewing, setPreviewing] = useState<PastedImage | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
    const items = Array.from(e.clipboardData?.items ?? []);
    const imgItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (imgItems.length === 0) return;
    e.preventDefault();

    const a = api();
    if (typeof a.saveImageFromPaste !== 'function') {
      setPasteError('Image paste needs the latest preload — restart the app (kill electron, then `npm run dev`).');
      return;
    }

    for (const item of imgItems) {
      const file = item.getAsFile();
      if (!file) continue;
      try {
        const { base64, dataUrl, mime } = await blobToBase64(file);
        const res = await a.saveImageFromPaste(base64, mime);
        if (!res?.savedPath) {
          setPasteError('The app saved the image but no path came back. Restart and try again.');
          continue;
        }
        setPasteError(null);
        setImages((prev) => [
          ...prev,
          { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, dataUrl, savedPath: res.savedPath },
        ]);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[agentsflow] paste image failed', err);
        setPasteError(`Failed to save image: ${(err as Error)?.message ?? err}`);
      }
    }
  };

  const removeImage = (id: string) => setImages((prev) => prev.filter((i) => i.id !== id));

  const buildFullPrompt = () => {
    const lines: string[] = [];
    if (prompt.trim()) lines.push(prompt.trim());
    const valid = images.filter((img) => !!img.savedPath);
    if (valid.length > 0) {
      lines.push('');
      lines.push(
        valid.length === 1
          ? 'I attached one image. Use the Read tool on this absolute path to view it:'
          : `I attached ${valid.length} images. Use the Read tool on these absolute paths to view them:`,
      );
      for (const img of valid) {
        lines.push(img.savedPath);
      }
    }
    return lines.join('\n');
  };

  const submit = async () => {
    if (disabled || !targetDir) return;
    const finalPrompt = buildFullPrompt();
    if (!finalPrompt) return;
    const attachments = validImages.map((i) => i.savedPath);
    setBusy(true);
    try {
      await onSend(finalPrompt, attachments);
      setPrompt('');
      setImages([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="border-t border-border bg-panel/80 backdrop-blur px-4 py-3 flex flex-col gap-2">
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
        <div className="flex items-end gap-3">
          <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-md bg-panel2 border border-border text-xs">
            <span className="text-muted">Spawn in:</span>
            <span className={targetDir ? 'text-accent font-medium' : 'text-muted italic'}>
              {targetDir ? targetDir.displayName : 'select a directory'}
            </span>
          </div>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
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
