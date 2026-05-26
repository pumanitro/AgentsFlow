import { useEffect } from 'react';

interface Props {
  src: string;
  caption?: string;
  onClose: () => void;
}

export default function ImagePreviewModal({ src, caption, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center p-8"
      onClick={onClose}
    >
      <div
        className="relative max-w-[90vw] max-h-[80vh] flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        <img src={src} alt={caption || 'preview'} className="max-w-full max-h-[80vh] rounded-lg shadow-2xl object-contain" />
        <button
          onClick={onClose}
          className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-panel border border-border text-text hover:bg-panel2 flex items-center justify-center"
          title="Close"
        >✕</button>
      </div>
      {caption && <div className="mt-3 text-xs text-muted font-mono truncate max-w-[80vw]">{caption}</div>}
    </div>
  );
}
