import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Small SVG time-series charts for the Performance monitor's Timeline view.
 *
 * Follows the dataviz method: one axis per chart (never dual-axis), 2px round
 * lines, area washes at ~10%, hairline solid gridlines, a crosshair that snaps
 * to the nearest X with ONE tooltip listing every series, a legend whenever
 * there are >= 2 series, and text always in text tokens (identity comes from
 * the mark beside it, never coloured text). Colours come from the validated
 * dark categorical palette (see PALETTE) in fixed slot order.
 */

// Validated dark categorical palette (adjacent-pair CVD ΔE >= 8.4 on #181b25).
export const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const;
export const OTHER_COLOR = '#8c93a8';
const SURFACE = '#181b25';
const GRID = 'rgba(255,255,255,0.08)';
const AXIS = 'rgba(255,255,255,0.14)';

export interface Series {
  key: string;
  label: string;
  color: string;
  values: Array<number | null>;
}

export interface LineChartProps {
  title: string;
  // Unit suffix for ticks and tooltip values.
  unit: string;
  times: number[];
  series: Series[];
  // Stack the series as areas (composition over time) instead of overlaying lines.
  stacked?: boolean;
  // Fix the top of the axis (e.g. 100 for percentages); otherwise fit the data.
  yMax?: number;
  // A labelled reference hairline, e.g. the core count on a load chart.
  reference?: { value: number; label: string };
  height?: number;
  // Number formatting for values in the legend and tooltip.
  format?: (v: number) => string;
  // Extra tooltip content for the hovered sample (e.g. "what was running").
  detail?: (index: number) => React.ReactNode;
}

const PAD = { left: 38, right: 10, top: 8, bottom: 18 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / exp;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return step * exp;
}

function hhmm(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function hhmmss(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.round(e.contentRect.width));
    });
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function LineChart({ title, unit, times, series, stacked = false, yMax, reference, height = 120, format, detail }: LineChartProps) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const fmt = format ?? ((v: number) => (Math.abs(v) >= 100 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString()));

  const n = times.length;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = Math.max(0, height - PAD.top - PAD.bottom);

  // Stacked: each series' plotted value is its cumulative sum at that X.
  const stackedValues = useMemo(() => {
    if (!stacked) return null;
    const acc = new Array(n).fill(0);
    return series.map((s) => s.values.map((v, i) => { acc[i] += v ?? 0; return acc[i]; }));
  }, [stacked, series, n]);

  const dataMax = useMemo(() => {
    let m = 0;
    if (stackedValues) {
      for (const vs of stackedValues) for (const v of vs) if (v > m) m = v;
    } else {
      for (const s of series) for (const v of s.values) if (v !== null && v > m) m = v;
    }
    if (reference && reference.value > m) m = reference.value;
    return m;
  }, [series, stackedValues, reference]);
  const top = yMax ?? niceMax(dataMax * 1.1);

  const x = (i: number) => (n <= 1 ? PAD.left : PAD.left + (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (Math.max(0, Math.min(top, v)) / top) * plotH;

  const pathFor = (vals: Array<number | null>): string => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const areaFor = (upper: Array<number | null>, lower?: number[]): string => {
    if (n === 0) return '';
    const up: string[] = [];
    const down: string[] = [];
    upper.forEach((v, i) => {
      if (v === null) return;
      up.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      down.push(`${x(i).toFixed(1)},${y(lower ? lower[i] : 0).toFixed(1)}`);
    });
    if (up.length === 0) return '';
    return `M${up.join('L')}L${down.reverse().join('L')}Z`;
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const xLabels = n >= 2 ? [0, Math.floor((n - 1) / 2), n - 1] : n === 1 ? [0] : [];
  const last = n - 1;
  const idx = hover ?? last;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (n === 0 || plotW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - PAD.left;
    const i = Math.round((px / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const tooltipLeft = hover !== null ? x(hover) : 0;
  const flip = hover !== null && tooltipLeft > width * 0.6;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <span className="text-[11px] text-text">{title}</span>
        {n > 0 && <span className="text-[10px] text-subtle font-mono">{hhmm(times[0])} – {hhmm(times[last])}</span>}
      </div>
      {/* Legend: mark + label in text tokens, plus the value at the hovered X
          (or the latest). Always present for >= 2 series. */}
      {series.length >= 2 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-1 pb-0.5 text-[10px]">
          {series.map((s) => {
            const v = n > 0 ? s.values[idx] : null;
            return (
              <span key={s.key} className="flex items-center gap-1 min-w-0">
                {stacked
                  ? <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: s.color }} aria-hidden="true" />
                  : <span className="inline-block w-3 h-0.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} aria-hidden="true" />}
                <span className="text-muted truncate max-w-[180px]" title={s.label}>{s.label}</span>
                <span className="text-text font-mono">{v === null || v === undefined ? '–' : `${fmt(v)}${unit}`}</span>
              </span>
            );
          })}
        </div>
      )}
      <div ref={wrapRef} className="relative w-full" style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            className="block select-none"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            role="img"
            aria-label={title}
          >
            {/* Gridlines + y ticks (recessive, hairline, solid). */}
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke={i === 0 ? AXIS : GRID} strokeWidth={1} />
                {i > 0 && (
                  <text x={PAD.left - 4} y={y(t) + 3} textAnchor="end" fontSize={9} fill="#8c93a8" fontFamily="ui-monospace, Menlo, monospace">
                    {fmt(t)}{unit}
                  </text>
                )}
              </g>
            ))}
            {reference && reference.value <= top && (
              <g>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(reference.value)} y2={y(reference.value)} stroke="rgba(255,255,255,0.28)" strokeWidth={1} />
                <text x={PAD.left + plotW - 2} y={y(reference.value) - 3} textAnchor="end" fontSize={9} fill="#b2b8cc" fontFamily="ui-monospace, Menlo, monospace">{reference.label}</text>
              </g>
            )}
            {/* x labels */}
            {xLabels.map((i) => (
              <text
                key={i}
                x={x(i)}
                y={height - 5}
                textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}
                fontSize={9}
                fill="#8c93a8"
                fontFamily="ui-monospace, Menlo, monospace"
              >{hhmm(times[i])}</text>
            ))}
            {/* Marks */}
            {stacked && stackedValues
              ? stackedValues.map((vals, si) => {
                  const lower = si === 0 ? undefined : (stackedValues[si - 1] as number[]);
                  return (
                    <g key={series[si].key}>
                      <path d={areaFor(vals, lower)} fill={series[si].color} fillOpacity={0.45} />
                      {/* A surface-coloured hairline separates bands, then the band's own edge. */}
                      <path d={pathFor(vals)} fill="none" stroke={SURFACE} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
                      <path d={pathFor(vals)} fill="none" stroke={series[si].color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
                    </g>
                  );
                })
              : series.map((s, si) => (
                  <g key={s.key}>
                    {series.length === 1 && <path d={areaFor(s.values)} fill={s.color} fillOpacity={0.1} />}
                    <path d={pathFor(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={si >= 8 ? 0.6 : 1} />
                  </g>
                ))}
            {/* Crosshair + point rings at the hovered X. */}
            {hover !== null && n > 0 && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="rgba(255,255,255,0.35)" strokeWidth={1} />
                {(stacked && stackedValues ? stackedValues : series.map((s) => s.values)).map((vals, si) => {
                  const v = vals[hover];
                  if (v === null || v === undefined) return null;
                  return <circle key={series[si].key} cx={x(hover)} cy={y(v)} r={4} fill={series[si].color} stroke={SURFACE} strokeWidth={2} />;
                })}
              </g>
            )}
          </svg>
        )}
        {hover !== null && n > 0 && (
          <div
            className="absolute top-1 pointer-events-none rounded border border-border bg-panel2 shadow-lg px-2 py-1 text-[10px] font-mono whitespace-nowrap z-10"
            style={flip ? { right: width - tooltipLeft + 8 } : { left: tooltipLeft + 8 }}
          >
            <div className="text-subtle mb-0.5">{hhmmss(times[hover])}</div>
            {series.map((s) => {
              const v = s.values[hover];
              return (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-0.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} aria-hidden="true" />
                  <span className="text-text">{v === null || v === undefined ? '–' : `${fmt(v)}${unit}`}</span>
                  <span className="text-muted truncate max-w-[220px]">{s.label}</span>
                </div>
              );
            })}
            {detail?.(hover)}
          </div>
        )}
      </div>
    </div>
  );
}
