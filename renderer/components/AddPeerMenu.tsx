import { forwardRef, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

interface Props {
  onAddDirectory: () => void;
  onAddRemote: () => void;
}

const ITEMS = [
  { key: 'local', label: 'Add directory', hint: 'a folder on this Mac' },
  { key: 'remote', label: 'Add remote peer', hint: 'a folder on another machine, over ssh' },
] as const;

/**
 * The small round `+` at the right end of the TRACKED PEERS header, opening a
 * two-item popover (local folder / remote peer over ssh). Replaces the two
 * dashed "add" blocks that used to sit under the search box.
 *
 * Close rules copy DirectoryCard's ⋯ menu: item click, Escape, outside click.
 * Keyboard: Enter/Space on the button opens it (native button click) and moves
 * focus to the first item; ArrowDown/ArrowUp cycle the items; Escape closes and
 * returns focus to the button. The forwarded ref lands on the `+` button.
 */
const AddPeerMenu = forwardRef<HTMLButtonElement, Props>(function AddPeerMenu({ onAddDirectory, onAddRemote }, buttonRef) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusButton = () => {
    if (buttonRef && typeof buttonRef !== 'function') buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // First item gets focus so arrows work straight away (mouse users won't notice).
    itemRefs.current[0]?.focus();
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); focusButton(); }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (key: (typeof ITEMS)[number]['key']) => {
    setOpen(false);
    if (key === 'local') onAddDirectory();
    else onAddRemote();
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation(); // keep the page's list navigation out of it
    const items = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    const cur = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (cur + 1) % items.length : (cur - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div ref={wrapRef} className="relative ml-auto shrink-0 -my-1 normal-case tracking-normal">
      <button
        ref={buttonRef}
        type="button"
        data-testid="add-peer-button"
        onClick={() => setOpen((v) => !v)}
        title="Add a peer"
        aria-label="Add a peer"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`w-6 h-6 flex items-center justify-center rounded-full border transition-colors outline-none focus-visible:ring-1 focus-visible:ring-accent ${
          open ? 'text-accent border-accent/60 bg-accent/10' : 'text-muted border-border hover:text-accent hover:border-accent/60 hover:bg-accent/10'
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Add a peer"
          data-testid="add-peer-menu"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full mt-1 w-64 rounded-md border border-border bg-panel2 shadow-lg z-30 py-1"
        >
          {ITEMS.map((it, i) => (
            <button
              key={it.key}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              role="menuitem"
              data-testid={`add-peer-${it.key}`}
              onClick={() => choose(it.key)}
              className="w-full text-left px-3 py-1.5 hover:bg-panel focus:bg-panel outline-none"
            >
              <span className="block text-sm text-text">{it.label}</span>
              <span className="block text-[11px] text-muted">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export default AddPeerMenu;
