import { useState } from 'react';
import type { NotificationFile } from '../../../shared/notifications';

export const CHIP_BTN = 'px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded border border-border bg-panel text-muted hover:text-text hover:bg-panel2';

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface FileActions {
  openFile: (filePath: string) => Promise<{ status: 'success' | 'failure'; error?: string }>;
  reveal: (filePath: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/** The files an agent attached to a notice, each with Open / Reveal. */
export default function NotificationFiles({ files, actions }: { files: NotificationFile[]; actions: FileActions }) {
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);
  if (!files.length) return null;
  const open = (path: string, label: string) => {
    actions.openFile(path)
      .then((r) => setMsg(r.status === 'success' ? { text: `Opened ${label}`, err: false } : { text: r.error ?? `Could not open ${label}`, err: true }))
      .catch((e) => setMsg({ text: errText(e), err: true }));
  };
  const reveal = (path: string) => {
    actions.reveal(path)
      .then((r) => { if (!r.ok) setMsg({ text: r.error, err: true }); })
      .catch((e) => setMsg({ text: errText(e), err: true }));
  };
  return (
    <div className="flex flex-col gap-1.5">
      {files.map((f) => {
        const label = f.label ?? basename(f.path);
        return (
          <div key={f.path} className="flex items-center gap-2 rounded-md border border-border bg-panel px-2 py-1.5 text-[12px]" title={f.path}>
            <span aria-hidden="true">📄</span>
            <span className="truncate min-w-0 flex-1 text-text">{label}</span>
            <button type="button" className={CHIP_BTN} onClick={() => open(f.path, label)}>Open</button>
            <button type="button" className={CHIP_BTN} onClick={() => reveal(f.path)}>Reveal</button>
          </div>
        );
      })}
      {msg && <div className={`text-[11px] ${msg.err ? 'text-err' : 'text-subtle'}`}>{msg.text}</div>}
    </div>
  );
}
