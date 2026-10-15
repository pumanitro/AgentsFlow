import { useEffect, useLayoutEffect, useState } from 'react';
import { formatSlot } from '../../../shared/routine-schedule';
import { useNotificationsUI } from '../../lib/use-notifications';
import { BellIcon } from './NotificationBell';
import NotificationCard, { hhmm } from './NotificationCard';

const SECTION = 'flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted';
const X_BTN = 'shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-muted hover:bg-panel2 hover:text-text';

/** Bottom edge of the page's header, so the drawer starts right under the bell. */
function measureHeaderBottom(): number {
  return document.querySelector('header')?.getBoundingClientRect().bottom ?? 45;
}

/**
 * The 400 px panel along the right edge, below the header. No backdrop: the
 * page behind stays usable, the bell toggles the panel, ✕ and Escape close it.
 * "Needs you" holds a card per open action notice; "Earlier" a row per open
 * warning, each closed with one ✕.
 */
export default function NotificationDrawer() {
  const { available, open, setOpen, list, counts, focusId, setFocusId, justCleared, actions } = useNotificationsUI();
  const [top, setTop] = useState(45);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [err, setErr] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setTop(measureHeaderBottom());
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  // Capture phase, so Escape closes the drawer before the page's own Escape
  // handlers (back navigation, modals) see it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, setOpen]);

  // A focused notice (new arrival or a banner click) opens expanded and in view.
  useEffect(() => {
    if (!open || !focusId) return;
    setExpanded((cur) => (cur.has(focusId) ? cur : new Set(cur).add(focusId)));
    const t = setTimeout(() => {
      document.getElementById(`notification-${focusId}`)?.scrollIntoView({ block: 'nearest' });
      setFocusId(null);
    }, 0);
    return () => clearTimeout(t);
  }, [open, focusId, setFocusId]);

  if (!available || !open) return null;

  const needs = list.filter((n) => n.level === 'action');
  const warns = list.filter((n) => n.level === 'warn');
  const toggle = (id: string) => setExpanded((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const dismiss = (id: string) => { setErr(null); actions.dismiss(id).catch((e) => setErr(e instanceof Error ? e.message : String(e))); };
  const clearAll = () => { warns.forEach((n) => dismiss(n.id)); };

  return (
    <aside
      role="complementary"
      aria-label="Notifications"
      className="fixed right-0 bottom-0 z-[60] w-[400px] max-w-[100vw] bg-panel border-l border-border shadow-[-20px_0_40px_-12px_rgba(0,0,0,.6)] flex flex-col"
      style={{ top, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-border bg-panel2/35 text-text">
        <BellIcon />
        <b className="text-[13px] font-semibold">Notifications</b>
        <span className="text-subtle">·</span>
        {counts.action
          ? <span className="text-[12px] text-orange-500">{counts.action} needs you</span>
          : <span className="text-[12px] text-ok">nothing needs you</span>}
        <button type="button" className={`ml-auto ${X_BTN}`} title="Close (Esc)" aria-label="Close the panel" onClick={() => setOpen(false)}>✕</button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2.5">
        <div className={SECTION}><span className="w-[3px] h-3 rounded-sm bg-orange-500" />Needs you</div>
        {needs.length === 0 && (
          <div className={`text-[12px] px-2.5 py-2 border border-dashed rounded-md flex items-center gap-1.5 ${justCleared ? 'text-ok border-ok/45' : 'text-subtle border-border'}`}>
            {justCleared && <span aria-hidden="true">✓</span>}
            Nothing needs you right now.
          </div>
        )}
        {needs.map((n) => (
          <div key={n.id} id={`notification-${n.id}`}>
            <NotificationCard n={n} expanded={expanded.has(n.id)} onToggle={() => toggle(n.id)} />
          </div>
        ))}

        <div className={`${SECTION} justify-between mt-1.5`}>
          <span className="flex items-center gap-1.5"><span className="w-[3px] h-3 rounded-sm bg-subtle" />Earlier</span>
          {warns.length > 0 && (
            <button type="button" className="normal-case tracking-normal text-[11px] text-accent hover:underline" onClick={clearAll}>Clear all</button>
          )}
        </div>
        {warns.length === 0 && (
          <div className="text-[12px] text-subtle px-2.5 py-2 border border-dashed border-border rounded-md">Nothing here.</div>
        )}
        {warns.map((n) => (
          <div key={n.id} id={`notification-${n.id}`} className="flex gap-2 items-start px-2 py-[7px] rounded-md border border-border/70 bg-bg/40">
            <span className="shrink-0 text-warn text-[13px] leading-4" aria-label="Warning">⚠</span>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold leading-4 text-text break-words">{n.title}</div>
              {n.body && <div className="text-[11px] leading-[15px] text-subtle break-words">{n.body}</div>}
            </div>
            <span className="shrink-0 mt-0.5 font-mono text-[10px] text-subtle" title={`Arrived ${formatSlot(n.createdAt)}`}>{hhmm(n.createdAt)}</span>
            <button type="button" className={`${X_BTN} !w-5 !h-5 text-[11px]`} title="Close — one click" aria-label={`Close ${n.title}`} onClick={() => dismiss(n.id)}>✕</button>
          </div>
        ))}
        {err && <div className="text-[11px] text-err">{err}</div>}
      </div>
    </aside>
  );
}
