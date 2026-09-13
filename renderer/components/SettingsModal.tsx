import { useEffect } from 'react';
import { useUIState } from '../lib/ui-state';

interface Props {
  onClose: () => void;
}

// One row of the settings list: a label with a one-line explanation, and a
// switch. Kept as a component so the next preference is one more line here.
function ToggleRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 px-5 py-3 border-b border-border last:border-b-0 cursor-pointer hover:bg-panel2/60">
      <span className="min-w-0">
        <span className="block text-sm text-text">{label}</span>
        <span className="block text-xs text-muted mt-0.5">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`shrink-0 relative w-9 h-5 rounded-full border transition-colors ${checked ? 'bg-accent border-accent' : 'bg-panel2 border-border'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-bg shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
      </button>
    </label>
  );
}

/**
 * App preferences that are purely about what the UI shows. Lives in the ☰ menu
 * beside the MCP server modal and follows its shape: a dimmed backdrop, Escape
 * or a click outside closes it, nothing here needs the main process.
 */
export default function SettingsModal({ onClose }: Props) {
  const [showProviderIcon, setShowProviderIcon] = useUIState('showProviderIcon');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-panel border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        <header className="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between">
          <div className="text-sm font-semibold text-text flex items-center gap-2">
            <span className="text-accent" aria-hidden>⚙</span>
            Settings
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text px-2 py-1 rounded hover:bg-panel2"
            aria-label="Close settings"
          >✕</button>
        </header>
        <div className="flex flex-col">
          <ToggleRow
            label="Show model icon per chat"
            hint="The Claude / Codex mark before the peer name on every conversation row."
            checked={showProviderIcon}
            onChange={setShowProviderIcon}
          />
        </div>
      </div>
    </div>
  );
}
