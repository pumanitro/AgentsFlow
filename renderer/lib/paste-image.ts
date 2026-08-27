import { api } from './ipc';

/** An image pasted into a composer: shown from the data URL, sent as the path. */
export interface PastedImage {
  id: string;
  dataUrl: string;
  savedPath: string;
}

export function blobToBase64(blob: Blob): Promise<{ base64: string; dataUrl: string; mime: string }> {
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

/**
 * Write every pasted image into the app's attachment store and hand back the
 * absolute paths — the CLI reads images off disk, so a data URL is useless to
 * the spawned agent. Never throws: failures come back as `error`.
 */
export async function savePastedImages(files: File[]): Promise<{ images: PastedImage[]; error: string | null }> {
  const a = api();
  if (typeof a.saveImageFromPaste !== 'function') {
    return { images: [], error: 'Image paste needs the latest preload — restart the app (kill electron, then `npm run dev`).' };
  }
  const images: PastedImage[] = [];
  let error: string | null = null;
  for (const file of files) {
    try {
      const { base64, dataUrl, mime } = await blobToBase64(file);
      const res = await a.saveImageFromPaste(base64, mime);
      if (!res?.savedPath) {
        error = 'The app saved the image but no path came back. Restart and try again.';
        continue;
      }
      images.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, dataUrl, savedPath: res.savedPath });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[agentsflow] paste image failed', err);
      error = `Failed to save image: ${(err as Error)?.message ?? err}`;
    }
  }
  return { images, error };
}

/** Image files off a paste event (empty when the clipboard held only text). */
export function imageFilesFromPaste(e: React.ClipboardEvent): File[] {
  return Array.from(e.clipboardData?.items ?? [])
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
}

/**
 * The lines that tell the agent where the pasted images landed. Claude Code
 * reads them with its own Read tool, so the prompt carries paths, not bytes.
 */
export function attachmentPromptLines(paths: string[]): string[] {
  if (paths.length === 0) return [];
  return [
    '',
    paths.length === 1
      ? 'I attached one image. Use the Read tool on this absolute path to view it:'
      : `I attached ${paths.length} images. Use the Read tool on these absolute paths to view them:`,
    ...paths,
  ];
}
