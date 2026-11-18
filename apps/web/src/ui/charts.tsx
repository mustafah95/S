import { useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Minimal SVG charts following the data-viz rules used across the app:
 * single-series marks in the validated wine hue (#a3354a), bars ≤ 24px with a 4px rounded data-end and a square
 * baseline, 2px lines with a 10% area wash, hairline solid gridlines, hover/focus tooltips (value first) and a
 * table view so no value is hover-only. Time axes stay left→right in both languages.
 */

export const SERIES = '#a3354a';
const GRID = 'var(--c-border)';
const INK2 = 'var(--c-muted)';

export interface Point {
  label: string;
  value: number;
  /** Optional longer label for the tooltip / table. */
  title?: string;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(0)}K`;
  return new Intl.NumberFormat('en-US').format(Math.round(v * 10) / 10);
}

/** Positioned in percentages of the (responsive) SVG so it tracks the mark at any width. */
function Tooltip({ x, y, value, label, width, height = 220 }: { x: number; y: number; value: string; label: string; width: number; height?: number }) {
  const xp = Math.min(Math.max((x / width) * 100, 12), 88);
  const yp = (y / height) * 100;
  return (
    <div style={{ position: 'absolute', left: `${xp}%`, top: `calc(${yp}% - 54px)`, transform: 'translateX(-50%)', background: 'var(--c-surface)', border: '1px solid var(--c-border-strong)', boxShadow: 'var(--shadow)', borderRadius: 8, padding: '6px 10px', pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 5 }}>
      <div style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div className="small muted">{label}</div>
    </div>
  );
}

function TableView({ data, format, caption }: { data: Point[]; format: (v: number) => string; caption: ReactNode }) {
  return (
    <details className="no-print" style={{ marginTop: 6 }}>
      <summary className="small muted" style={{ cursor: 'pointer' }}>⊞ {caption}</summary>
      <table className="data" style={{ marginTop: 6 }}>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <td>{d.title ?? d.label}</td>
              <td className="r num">{format(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

const W = 640;

export function ColumnChart({ data, format = compact, height = 220, tableCaption = 'Table' }: { data: Point[]; format?: (v: number) => string; height?: number; tableCaption?: ReactNode }) {
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 8, t: 12, b: 26 };
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const ih = height - pad.t - pad.b;
  const band = (W - pad.l - pad.r) / Math.max(1, data.length);
  const bw = Math.min(24, band * 0.62);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const every = Math.max(1, Math.ceil(data.length / 12));
  return (
    <div dir="ltr" style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={data.map((d) => `${d.label}: ${format(d.value)}`).join(', ')}>
        {ticks.map((tk) => {
          const y = pad.t + ih - (tk / max) * ih;
          return (
            <g key={tk}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
              <text x={pad.l - 6} y={y + 4} textAnchor="end" fontSize={11} fill={INK2}>{compact(tk)}</text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const h = (Math.max(0, d.value) / max) * ih;
          const x = pad.l + i * band + (band - bw) / 2;
          const y = pad.t + ih - h;
          const r = Math.min(4, h, bw / 2);
          const path = h > 0 ? `M${x},${pad.t + ih} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${pad.t + ih} Z` : '';
          return (
            <g key={d.label} tabIndex={0} aria-label={`${d.title ?? d.label}: ${format(d.value)}`} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
              <rect x={pad.l + i * band} y={pad.t} width={band} height={ih} fill="transparent" />
              {path && <path d={path} fill={SERIES} opacity={hover === null || hover === i ? 1 : 0.55} />}
              {i % every === 0 && <text x={x + bw / 2} y={height - 8} textAnchor="middle" fontSize={11} fill={INK2}>{d.label}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (() => {
        const d = data[hover]!;
        const x = ((pad.l + hover * band + band / 2) / W) * 100;
        return <Tooltip x={(x / 100) * W} y={pad.t + ih - (Math.max(0, d.value) / max) * ih} value={format(d.value)} label={d.title ?? d.label} width={W} height={height} />;
      })()}
      <TableView data={data} format={format} caption={tableCaption} />
    </div>
  );
}

export function LineChart({ data, format = compact, height = 220, tableCaption = 'Table' }: { data: Point[]; format?: (v: number) => string; height?: number; tableCaption?: ReactNode }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 54, t: 14, b: 26 };
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const ih = height - pad.t - pad.b;
  const iw = W - pad.l - pad.r;
  const xAt = (i: number) => pad.l + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const yAt = (v: number) => pad.t + ih - (Math.max(0, v) / max) * ih;
  const line = useMemo(() => data.map((d, i) => `${i ? 'L' : 'M'}${xAt(i)},${yAt(d.value)}`).join(' '), [data, max]);
  const area = data.length ? `${line} L${xAt(data.length - 1)},${pad.t + ih} L${xAt(0)},${pad.t + ih} Z` : '';
  const every = Math.max(1, Math.ceil(data.length / 10));
  const last = data.at(-1);
  const onMove = (e: React.PointerEvent) => {
    const svg = ref.current;
    if (!svg || !data.length) return;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((x - pad.l) / iw) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };
  return (
    <div dir="ltr" style={{ position: 'relative' }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${height}`} width="100%" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={data.map((d) => `${d.label}: ${format(d.value)}`).join(', ')}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={yAt(f * max)} y2={yAt(f * max)} stroke={GRID} strokeWidth={1} />
            <text x={pad.l - 6} y={yAt(f * max) + 4} textAnchor="end" fontSize={11} fill={INK2}>{compact(f * max)}</text>
          </g>
        ))}
        {data.map((d, i) => (i % every === 0 ? <text key={d.label} x={xAt(i)} y={height - 8} textAnchor="middle" fontSize={11} fill={INK2}>{d.label}</text> : null))}
        <path d={area} fill={SERIES} opacity={0.1} />
        <path d={line} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {last && (
          <>
            <circle cx={xAt(data.length - 1)} cy={yAt(last.value)} r={4} fill={SERIES} stroke="var(--c-surface)" strokeWidth={2} />
            <text x={xAt(data.length - 1) + 8} y={yAt(last.value) + 4} fontSize={12} fill="var(--c-text)" fontWeight={600}>{format(last.value)}</text>
          </>
        )}
        {hover !== null && data[hover] && (
          <>
            <line x1={xAt(hover)} x2={xAt(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--c-border-strong)" strokeWidth={1} />
            <circle cx={xAt(hover)} cy={yAt(data[hover]!.value)} r={4} fill={SERIES} stroke="var(--c-surface)" strokeWidth={2} />
          </>
        )}
      </svg>
      {hover !== null && data[hover] && <Tooltip x={xAt(hover)} y={yAt(data[hover]!.value)} value={format(data[hover]!.value)} label={data[hover]!.title ?? data[hover]!.label} width={W} height={height} />}
      <TableView data={data} format={format} caption={tableCaption} />
    </div>
  );
}

/** Horizontal bars for categories (sources, statuses): value at the tip, label in text ink. */
export function BarList({ data, format = compact }: { data: Point[]; format?: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {data.map((d) => (
        <div key={d.label} title={`${d.title ?? d.label}: ${format(d.value)}`} tabIndex={0}>
          <div className="row between small"><span>{d.title ?? d.label}</span><span className="num" style={{ fontWeight: 600 }}>{format(d.value)}</span></div>
          <div style={{ height: 10, marginTop: 3, background: 'color-mix(in srgb, var(--c-border) 60%, white)', borderRadius: 4 }}>
            <div style={{ width: `${(d.value / max) * 100}%`, height: '100%', background: SERIES, borderRadius: '0 4px 4px 0' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
