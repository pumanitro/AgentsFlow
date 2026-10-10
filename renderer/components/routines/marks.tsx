import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import type { MarkStatus, RoutineCadence, RoutineIcon } from '../../../shared/routines';
import type { SlotMark } from '../../../shared/routine-board';
import { cadenceLabel, formatSlot } from '../../../shared/routine-schedule';
import { STATUS_FILL, STATUS_LABEL } from '../../lib/routine-style';
import { GLYPH_PATHS } from './glyphs';

// The shared visual vocabulary of the Routines screen. Wave 0 ships plain
// versions; the props are frozen so the boards can build against them while
// the glyphs are polished.

const SHAPE_CLASS: Record<'segment' | 'dot' | 'circle', string> = {
  segment: 'flex-1 h-full rounded-[2px]',
  dot: 'w-2 h-2 rounded-full',
  circle: 'w-3.5 h-3.5 rounded-full',
};

export function StatusMark({ status, shape, size, title }: { status: MarkStatus; shape: 'segment' | 'dot' | 'circle'; size?: number; title?: string }): JSX.Element {
  const style = size && shape !== 'segment' ? { width: size, height: size } : undefined;
  return <span title={title} style={style} className={`block shrink-0 ${SHAPE_CLASS[shape]} ${STATUS_FILL[status]}`} />;
}

export function CadenceIcon({ cadence, size = 12, className }: { cadence: RoutineCadence; size?: number; className?: string }): JSX.Element {
  const common = {
    width: size, height: size, viewBox: '0 0 12 12', className, 'aria-hidden': true as const,
    fill: 'none', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' as const,
  };
  if (cadence === 'daily') { // sun: disc + 8 rays
    return (
      <svg {...common}>
        <circle cx="6" cy="6" r="1.9" fill="currentColor" stroke="none" />
        <path d="M6 .8v1.6 M6 9.6v1.6 M.8 6h1.6 M9.6 6h1.6 M2.3 2.3l1.1 1.1 M8.6 8.6l1.1 1.1 M9.7 2.3L8.6 3.4 M3.4 8.6L2.3 9.7" />
      </svg>
    );
  }
  if (cadence === 'every2days') { // two dots side by side
    return (
      <svg {...common}>
        <circle cx="3.2" cy="6" r="2" fill="currentColor" stroke="none" />
        <circle cx="8.8" cy="6" r="2" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (cadence === 'weekly') { // a strip of 7 vertical bars
    return (
      <svg {...common}>
        <path d="M1.2 3.5v5 M3 3.5v5 M4.8 3.5v5 M6.6 3.5v5 M8.4 3.5v5 M10.2 3.5v5 M12 3.5v5" transform="translate(-.6 0)" />
      </svg>
    );
  }
  return ( // calendar frame with two dots (twice a month) or one dot (monthly)
    <svg {...common}>
      <rect x="1.5" y="2.5" width="9" height="8" rx="1" />
      <path d="M1.5 5h9 M4 1.3v2 M8 1.3v2" />
      {cadence === 'twiceMonthly' ? (
        <>
          <circle cx="4.2" cy="7.7" r=".9" fill="currentColor" stroke="none" />
          <circle cx="7.8" cy="7.7" r=".9" fill="currentColor" stroke="none" />
        </>
      ) : (
        <circle cx="6" cy="7.7" r=".9" fill="currentColor" stroke="none" />
      )}
    </svg>
  );
}

export function RoutineGlyph({ icon, name, size = 16, className }: { icon: RoutineIcon; name: string; size?: number; className?: string }): JSX.Element {
  const d = GLYPH_PATHS[icon];
  if (!d) {
    // Unknown icon id (older data): fall back to the name's first letter.
    return (
      <span
        data-icon={icon}
        aria-hidden="true"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}
        className={`inline-flex shrink-0 items-center justify-center rounded-[4px] border border-current font-semibold leading-none ${className ?? ''}`}
      >{(name.trim()[0] ?? '?').toUpperCase()}</span>
    );
  }
  return (
    <svg
      data-icon={icon}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className ?? ''}`.trim()}
    >
      <path d={d} />
    </svg>
  );
}

const MARGIN = 8;
const GAP = 6;

export function MarkTooltip({ anchor, lines, onClose }: { anchor: DOMRect | null; lines: string[]; onClose: () => void }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measure, then place below-left of the anchor; flip above when it would
  // run off the bottom, and clamp so it never leaves the viewport.
  useLayoutEffect(() => {
    if (!anchor || !ref.current) { setPos(null); return; }
    const { width, height } = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = anchor.bottom + GAP;
    if (top + height > vh - MARGIN) top = anchor.top - height - GAP;
    top = Math.max(MARGIN, Math.min(top, vh - height - MARGIN));
    const left = Math.max(MARGIN, Math.min(anchor.left, vw - width - MARGIN));
    setPos({ left, top });
  }, [anchor, lines]);

  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // A mark's own click stops propagation, so this only sees clicks elsewhere.
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('click', onDocClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick);
    };
  }, [anchor, onClose]);

  if (!anchor || lines.length === 0) return null;
  return (
    <div
      ref={ref}
      role="tooltip"
      style={{ position: 'fixed', left: pos?.left ?? anchor.left, top: pos?.top ?? anchor.bottom + GAP, visibility: pos ? 'visible' : 'hidden', maxWidth: 320 }}
      className="z-50 bg-panel border border-border rounded-md shadow-2xl text-xs px-2.5 py-1.5 space-y-0.5"
    >
      {lines.map((line, i) => (
        <div key={i} className={i === 0 ? 'text-text font-semibold' : 'text-muted'}>{line}</div>
      ))}
    </div>
  );
}

type TooltipState = { anchor: DOMRect; lines: string[] } | null;

/** Hover shows, leaving hides; click toggles a sticky tooltip — one tooltip for mouse and tap. */
export function useMarkTooltip(): {
  tooltip: TooltipState;
  bind: (lines: () => string[]) => {
    onMouseEnter: React.MouseEventHandler<HTMLElement>;
    onMouseLeave: React.MouseEventHandler<HTMLElement>;
    onFocus: React.FocusEventHandler<HTMLElement>;
    onBlur: React.FocusEventHandler<HTMLElement>;
    onClick: React.MouseEventHandler<HTMLElement>;
  };
  close: () => void;
} {
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const stickyRef = useRef(false);
  const elRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    stickyRef.current = false;
    elRef.current = null;
    setTooltip(null);
  }, []);

  const bind = useCallback((lines: () => string[]) => {
    const show = (el: HTMLElement) => {
      elRef.current = el;
      setTooltip({ anchor: el.getBoundingClientRect(), lines: lines() });
    };
    const hide = () => { if (!stickyRef.current) close(); };
    return {
      onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { if (!stickyRef.current) show(e.currentTarget); },
      onMouseLeave: hide,
      onFocus: (e: React.FocusEvent<HTMLElement>) => { if (!stickyRef.current) show(e.currentTarget); },
      onBlur: hide,
      onClick: (e: React.MouseEvent<HTMLElement>) => {
        e.stopPropagation();
        // A second click on the mark that pinned it closes; any other click pins.
        if (stickyRef.current && elRef.current === e.currentTarget) { close(); return; }
        stickyRef.current = true;
        show(e.currentTarget);
      },
    };
  }, [close]);

  return { tooltip, bind, close };
}

export function tooltipLines(mark: SlotMark): string[] {
  return [
    mark.routine.name,
    `${formatSlot(mark.slotAt)} · ${cadenceLabel(mark.routine.schedule)}`,
    STATUS_LABEL[mark.status],
    mark.run?.summary ?? mark.run?.error,
  ].filter((x): x is string => Boolean(x));
}
