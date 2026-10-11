import type { PerfSeverity } from '../../shared/perf-severity';

// The Performance monitor's small shared pieces: the severity colours and the
// section heading / label-value line every section is built from.

export const SEV_COLOR: Record<PerfSeverity, string> = {
  normal: '#4ade80',
  warning: '#fbbf24',
  danger: '#ef4444',
};

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-wider text-subtle">{children}</div>;
}

// One "label ....... value" line with an optional coloured value and sub-note.
export function Row({ label, value, severity, sub }: { label: string; value: string; severity?: PerfSeverity; sub?: string }) {
  return (
    <div className="px-3 py-0.5 flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-muted truncate">{label}</span>
      <span className="text-[11px] font-mono shrink-0 text-right" style={{ color: severity ? SEV_COLOR[severity] : undefined }}>
        <span className={severity ? '' : 'text-text'}>{value}</span>
        {sub && <span className="text-subtle ml-1.5">{sub}</span>}
      </span>
    </div>
  );
}
