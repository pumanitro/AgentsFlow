import { useEffect, useRef, useState } from 'react';

export interface AgentOption {
  id: string;       // the peer's directory id
  name: string;     // its displayName
  count: number;    // routines on that peer
}

interface Props {
  agents: AgentOption[];              // only peers that have at least one routine
  selected: string[];                 // [] = all agents
  onChange: (ids: string[]) => void;
}

const ROW = 'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-panel focus:bg-panel outline-none';

function Check({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`w-3.5 h-3.5 shrink-0 rounded-sm border flex items-center justify-center text-[10px] leading-none ${on ? 'bg-accent border-accent text-bg' : 'border-border'}`}
    >
      {on ? '✓' : ''}
    </span>
  );
}

/**
 * The Routines toolbar's agent (peer) filter: one agent, a few, or all. The
 * menu stays open while boxes are ticked; click-outside or Escape closes it.
 */
export default function AgentFilter({ agents, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    // Document-level, so it claims the key before the screen's own Escape handler on window.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); buttonRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = selected.filter((id) => agents.some((a) => a.id === id));
  const label = active.length === 0
    ? 'All agents'
    : active.length === 1
      ? agents.find((a) => a.id === active[0])?.name ?? '1 agent'
      : `${active.length} agents`;

  const toggle = (id: string) => {
    onChange(active.includes(id) ? active.filter((x) => x !== id) : [...active, id]);
  };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Show only the routines of these agents"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`max-w-[14rem] flex items-center gap-1.5 px-2 py-1 rounded-md border text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-accent ${
          active.length > 0 ? 'border-accent/60 bg-accent/10 text-text' : 'border-border bg-panel text-muted hover:text-text hover:bg-panel2'
        }`}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden="true" className="text-subtle">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Filter by agent"
          className="absolute left-0 top-full mt-1 w-64 max-h-80 overflow-y-auto rounded-md border border-border bg-panel2 shadow-lg z-30 py-1"
        >
          <button type="button" role="menuitemcheckbox" aria-checked={active.length === 0} onClick={() => onChange([])} className={ROW}>
            <Check on={active.length === 0} />
            <span className="text-text">All agents</span>
          </button>
          <div className="my-1 border-t border-border" />
          {agents.length === 0 && <div className="px-3 py-1.5 text-[12px] text-subtle">No agent has a routine yet</div>}
          {agents.map((a) => {
            const on = active.includes(a.id);
            return (
              <button key={a.id} type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => toggle(a.id)} className={ROW}>
                <Check on={on} />
                <span className="truncate text-text">{a.name}</span>
                <span className="ml-auto shrink-0 tabular-nums text-[11px] text-subtle">{a.count}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
