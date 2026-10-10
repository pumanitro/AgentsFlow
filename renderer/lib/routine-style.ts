import type { MarkStatus, RoutineCadence } from '../../shared/routines';

export const STATUS_LABEL: Record<MarkStatus, string> = {
  running: 'In progress', attention: 'Needs your attention', success: 'Succeeded', failed: 'Failed', missed: 'Missed', scheduled: 'Scheduled',
};
// A filled mark: a bar segment, a dot, a circle, a card's status chip.
export const STATUS_FILL: Record<MarkStatus, string> = {
  success: 'bg-ok',
  failed: 'bg-err',
  running: 'bg-info animate-pulse',
  attention: 'bg-orange-500',
  missed: 'bg-transparent border border-err',
  scheduled: 'bg-transparent border border-dashed border-subtle',
};
export const STATUS_TEXT: Record<MarkStatus, string> = {
  success: 'text-ok', failed: 'text-err', running: 'text-info', attention: 'text-orange-500', missed: 'text-err', scheduled: 'text-subtle',
};
export const STATUS_HEX: Record<MarkStatus, string> = {   // for inline SVG / inline styles
  success: '#4ade80', failed: '#ef4444', running: '#3b82f6', attention: '#f97316', missed: '#ef4444', scheduled: '#8c93a8',
};
// Cadence hue — the LEFT edge of a chip, the sidebar group marker, the cadence icon's tint. Chosen away from the four status hues.
export const CADENCE_COLOR: Record<RoutineCadence, string> = {
  daily: '#2dd4bf',        // teal
  every2days: '#a78bfa',   // violet
  weekly: '#e879f9',       // fuchsia
  twiceMonthly: '#facc15', // yellow
  monthly: '#e2e8f0',      // pale slate
};
// The CHAT | FILE pill, verbatim from renderer/pages/session.tsx:345-357.
export const PILL = {
  wrap: 'shrink-0 flex rounded-md border border-border bg-panel overflow-hidden',
  on: 'px-3 py-1 text-[11px] uppercase tracking-wider bg-accent text-bg font-semibold',
  off: 'px-3 py-1 text-[11px] uppercase tracking-wider text-muted hover:text-text hover:bg-panel2',
};
