import { useEffect, useRef, useState } from 'react';

// Max gap between two ⌘←/⌥← presses that still counts as a deliberate
// "double press → go back" inside the markdown editor. Also how long the
// "press again" hint stays on screen.
const DOUBLE_PRESS_MS = 600;

/**
 * Wire up the page-level back-navigation shortcuts (⌘←/⌥← and Shift+Esc),
 * which return from a session/preview to the Peers Flow start screen.
 *
 * Inside the markdown (BlockNote) editor, ⌘← and ⌥← are native text-navigation
 * keys (caret to start of line / previous word). Hijacking a single press to
 * navigate away would yank the user out of the document mid-edit, so there the
 * first press is left for the editor and only a quick double-press goes back.
 * Everywhere else a single press goes back, unchanged.
 *
 * Returns the key combo to flash in a "press again to go back" hint after the
 * first in-editor press (or null when no hint should show). Render it with
 * {@link BackNavHint}.
 */
export function useBackNavKeys(goBack: () => void): string | null {
  // Timestamp of the last ⌘←/⌥← press seen inside the markdown editor.
  const lastEditorArrowAt = useRef(0);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && (e.metaKey || e.altKey)) {
        const target = e.target as HTMLElement | null;
        const inMarkdownEditor = !!target?.closest?.('.blocknote-host');
        if (inMarkdownEditor) {
          const now = Date.now();
          if (now - lastEditorArrowAt.current <= DOUBLE_PRESS_MS) {
            // Second press within the window — go back for real.
            lastEditorArrowAt.current = 0;
            if (hintTimer.current) clearTimeout(hintTimer.current);
            setHint(null);
            e.preventDefault();
            goBack();
          } else {
            // First press — let the editor move the caret (start of line) and
            // flash a hint that a second press leaves the document.
            lastEditorArrowAt.current = now;
            setHint(e.metaKey ? '⌘ ←' : '⌥ ←');
            if (hintTimer.current) clearTimeout(hintTimer.current);
            hintTimer.current = setTimeout(() => setHint(null), DOUBLE_PRESS_MS);
          }
          return;
        }
        e.preventDefault();
        goBack();
      } else if (e.key === 'Escape' && e.shiftKey) {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, [goBack]);

  return hint;
}

/**
 * Transient pill shown after the first ⌘←/⌥← in the markdown editor, nudging
 * the user to press again to return to Peers Flow. Renders nothing when idle.
 */
export function BackNavHint({ hint }: { hint: string | null }) {
  if (!hint) return null;
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 pointer-events-none flex items-center gap-1.5 rounded-full border border-border bg-panel2/95 px-3 py-1.5 text-xs text-text shadow-lg backdrop-blur-sm">
      <kbd className="font-mono text-text/90">{hint}</kbd>
      <span className="text-muted">again to go back</span>
    </div>
  );
}
