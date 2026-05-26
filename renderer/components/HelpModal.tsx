import { useEffect } from 'react';
import pkg from '../../package.json';

interface Props {
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  desc: string;
}

const SHORTCUTS: { section: string; items: Shortcut[] }[] = [
  {
    section: 'Home view',
    items: [
      { keys: ['↑', '↓'], desc: 'Move focus between pinned conversations' },
      { keys: ['⌘', '→'], desc: 'Open the focused conversation (attach terminal)' },
      { keys: ['Enter'], desc: 'Send prompt (when input is focused)' },
      { keys: ['Shift', 'Enter'], desc: 'Newline in the spawn prompt' },
    ],
  },
  {
    section: 'Terminal view',
    items: [
      { keys: ['⌘', '←'], desc: 'Detach and return to the home view' },
      { keys: ['Shift', 'Esc'], desc: 'Same as ⌘+← — return to home' },
      { keys: ['←'], desc: 'On an empty Claude prompt — also detaches (claude attach behavior)' },
    ],
  },
  {
    section: 'Modals (history, this dialog)',
    items: [
      { keys: ['Esc'], desc: 'Close the modal' },
    ],
  },
];

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="inline-flex items-center justify-center min-w-[44px] h-11 px-3 rounded-md border border-border bg-panel2 text-base font-mono font-semibold text-text shadow-[inset_0_-2px_0_0_rgba(0,0,0,0.4)]"
    >
      {children}
    </kbd>
  );
}

export default function HelpModal({ onClose }: Props) {
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
        className="w-full max-w-xl max-h-[80vh] bg-panel border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        <header className="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-text">Keyboard shortcuts</div>
            <div className="text-xs text-muted">AgentsFlow · v{pkg.version}</div>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text px-2 py-1 rounded hover:bg-panel2"
            title="Close (Esc)"
          >✕</button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {SHORTCUTS.map((group) => (
            <section key={group.section}>
              <h3 className="text-[11px] uppercase tracking-wider text-muted mb-2">{group.section}</h3>
              <ul className="space-y-3">
                {group.items.map((s, i) => (
                  <li key={i} className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {s.keys.map((k, j) => (
                        <span key={j} className="flex items-center gap-1.5">
                          <Key>{k}</Key>
                          {j < s.keys.length - 1 && <span className="text-muted text-sm">+</span>}
                        </span>
                      ))}
                    </div>
                    <div className="text-sm text-text/90">{s.desc}</div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="shrink-0 px-5 py-2.5 border-t border-border text-[11px] text-muted flex items-center gap-1.5">
          Press
          <kbd className="inline-flex items-center justify-center min-w-[28px] h-6 px-1.5 rounded border border-border bg-panel2 text-[11px] font-mono text-text">Esc</kbd>
          or click outside to close
        </footer>
      </div>
    </div>
  );
}
