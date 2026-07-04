import { useMemo, useRef, useState, type PointerEvent } from 'react';
import styles from './SvgLineChart.module.css';

export interface ChartSeries {
  /** Legend label. */
  label: string;
  /** Data points, oldest→newest; shares the x-axis with the other series. */
  values: number[];
  /** CSS color for the line + swatch, e.g. `'var(--primary)'`. Applied as an
   *  SVG `stroke`/`fill` presentation attribute (not an inline style). */
  color: string;
}

interface SvgLineChartProps {
  series: ChartSeries[];
  /** Epoch-ms timestamp per data point, aligned with `values`; drives the
   *  hover tooltip's time line. */
  timestamps?: number[];
  /** Format a y value for the peak label, per-series current value, and hover. */
  format?: (value: number) => string;
  /** Format a bucket timestamp for the hover tooltip header. */
  formatTime?: (t: number) => string;
  /** Start the y-axis at 0 (default) so magnitudes read honestly, vs. auto-min
   *  which exaggerates small wiggles. */
  zeroBased?: boolean;
  /** Accessible description of what the chart shows. */
  ariaLabel?: string;
  /** Localized prefix for the peak-value label (default `'peak'`). */
  peakLabel?: string;
}

// A wide, short viewBox stretched to the card width. `preserveAspectRatio:none`
// lets x fill the container (time needs no fixed aspect); `non-scaling-stroke`
// keeps the line crisp despite the non-uniform scale.
const VIEW_W = 320;
const VIEW_H = 64;
const PAD = 3;
const INNER_W = VIEW_W - PAD * 2;
const INNER_H = VIEW_H - PAD * 2;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

// Approx. tooltip height (time header + a few series rows + padding). When the
// plot sits within this many px of its scroll container's top edge, the upward
// tooltip would clip, so we flip it below the cursor instead.
const TOOLTIP_CLEARANCE_PX = 84;

/** Nearest scrollable ancestor — its top edge is what clips an upward tooltip
 *  (e.g. DialogShell's `overflow-y: auto` body). Null when none is found. */
function findScrollParent(el: Element): Element | null {
  let node: Element | null = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

function defaultFormatTime(t: number): string {
  return new Date(t).toLocaleTimeString();
}

/**
 * Dependency-free inline-SVG line chart for the Daemon Status dashboard. Draws
 * one or more equal-length series on a shared, zero-based y-axis, with a hover
 * cursor that reads out each series' value and the bucket time at that point.
 * Kept deliberately small rather than pulling a charting lib into the
 * self-contained, CSP-strict `serve --web` bundle.
 */
export function SvgLineChart({
  series,
  timestamps,
  format = (v) => String(Math.round(v)),
  formatTime = defaultFormatTime,
  zeroBased = true,
  ariaLabel,
  peakLabel = 'peak',
}: SvgLineChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Flip the tooltip below the cursor near a scroll container's top edge.
  const [tooltipBelow, setTooltipBelow] = useState(false);
  // Nearest scroll container, resolved once on first hover (undefined = not yet
  // looked up; null = none found).
  const scrollParentRef = useRef<Element | null | undefined>(undefined);

  const { paths, maxV, maxLen, min, span } = useMemo(() => {
    const len = series.reduce((m, s) => Math.max(m, s.values.length), 0);
    let max = 0;
    let lo = zeroBased ? 0 : Number.POSITIVE_INFINITY;
    for (const s of series) {
      for (const v of s.values) {
        if (!Number.isFinite(v)) continue;
        if (v > max) max = v;
        if (v < lo) lo = v;
      }
    }
    if (!Number.isFinite(lo)) lo = 0;
    // Flat/all-zero series: a unit span avoids /0 and pins the line to the
    // baseline instead of NaN.
    const range = max - lo || 1;
    const xFn = (i: number): number =>
      len <= 1 ? PAD + INNER_W / 2 : PAD + (i / (len - 1)) * INNER_W;
    const yFn = (v: number): number =>
      PAD + INNER_H - ((finiteOr(v, lo) - lo) / range) * INNER_H;
    const built = series.map((s) => {
      const d = s.values
        .map(
          (v, i) =>
            `${i === 0 ? 'M' : 'L'}${xFn(i).toFixed(1)},${yFn(v).toFixed(1)}`,
        )
        .join(' ');
      const lastIdx = s.values.length - 1;
      const dot =
        lastIdx >= 0
          ? { cx: xFn(lastIdx), cy: yFn(s.values[lastIdx]), color: s.color }
          : undefined;
      return { key: s.label, d, color: s.color, dot };
    });
    return { paths: built, maxV: max, maxLen: len, min: lo, span: range };
  }, [series, zeroBased]);

  const hasData = maxLen > 0;

  // Recomputed on hover only; cheap and keeps the memo above dependency-light.
  const xAt = (i: number): number =>
    maxLen <= 1 ? PAD + INNER_W / 2 : PAD + (i / (maxLen - 1)) * INNER_W;
  const yAt = (v: number): number =>
    PAD + INNER_H - ((finiteOr(v, min) - min) / span) * INNER_H;

  const handleMove = (e: PointerEvent<SVGSVGElement>): void => {
    const svg = svgRef.current;
    if (!svg || maxLen === 0) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const rel = (e.clientX - rect.left) / rect.width;
    const idx = Math.max(
      0,
      Math.min(maxLen - 1, Math.round(rel * (maxLen - 1))),
    );
    setHoverIdx(idx);
    // Flip the tooltip below the cursor when the plot is too close to the top
    // of its scroll container for the default upward tooltip to clear the clip
    // boundary — otherwise the topmost chart's readout truncates inside
    // DialogShell's overflow-y:auto body.
    if (scrollParentRef.current === undefined) {
      scrollParentRef.current = findScrollParent(svg);
    }
    const scroller = scrollParentRef.current;
    const clipTop = scroller ? scroller.getBoundingClientRect().top : 0;
    setTooltipBelow(rect.top - clipTop < TOOLTIP_CLEARANCE_PX);
  };
  const handleLeave = (): void => setHoverIdx(null);

  const active =
    hoverIdx != null && hoverIdx >= 0 && hoverIdx < maxLen ? hoverIdx : null;
  const cursorX = active != null ? xAt(active) : 0;
  // Position the tooltip horizontally as a percentage of the plot so it tracks
  // the cursor across the responsive-width SVG.
  const tooltipLeftPct =
    active != null && maxLen > 1 ? (active / (maxLen - 1)) * 100 : 50;

  return (
    <div className={styles.chart}>
      <div className={styles.plot}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={ariaLabel}
          className={styles.svg}
          onPointerMove={handleMove}
          onPointerLeave={handleLeave}
        >
          <line
            x1={PAD}
            y1={VIEW_H - PAD}
            x2={VIEW_W - PAD}
            y2={VIEW_H - PAD}
            className={styles.axis}
            vectorEffect="non-scaling-stroke"
          />
          {paths.map((p) => (
            <path
              key={p.key}
              d={p.d}
              fill="none"
              stroke={p.color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* Hover cursor: a vertical time line plus a dot on each series at the
              hovered bucket. Rendered before the last-point dots so those stay
              on top at rest. */}
          {active != null && (
            <>
              <line
                x1={cursorX}
                y1={PAD}
                x2={cursorX}
                y2={VIEW_H - PAD}
                className={styles.cursor}
                vectorEffect="non-scaling-stroke"
              />
              {series.map((s) =>
                active < s.values.length ? (
                  <circle
                    key={`${s.label}-hover`}
                    cx={cursorX}
                    cy={yAt(s.values[active])}
                    r={2.5}
                    fill={s.color}
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null,
              )}
            </>
          )}
          {active == null &&
            paths.map((p) =>
              p.dot ? (
                <circle
                  key={`${p.key}-dot`}
                  cx={p.dot.cx}
                  cy={p.dot.cy}
                  r={2}
                  fill={p.dot.color}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null,
            )}
        </svg>
        {active != null && (
          <div
            className={`${styles.tooltip} ${
              tooltipBelow ? styles.tooltipBelow : ''
            }`}
            style={{ left: `${tooltipLeftPct}%` }}
            role="tooltip"
          >
            {timestamps && timestamps[active] != null && (
              <div className={styles.tooltipTime}>
                {formatTime(timestamps[active])}
              </div>
            )}
            {series.map((s) =>
              active < s.values.length ? (
                <div key={s.label} className={styles.tooltipRow}>
                  <svg
                    className={styles.swatch}
                    viewBox="0 0 8 8"
                    aria-hidden="true"
                  >
                    <rect width="8" height="8" rx="1.5" fill={s.color} />
                  </svg>
                  <span className={styles.tooltipLabel}>{s.label}</span>
                  <span className={styles.tooltipValue}>
                    {format(s.values[active])}
                  </span>
                </div>
              ) : null,
            )}
          </div>
        )}
      </div>
      <div className={styles.legend}>
        {series.map((s) => {
          const last = s.values.length
            ? s.values[s.values.length - 1]
            : undefined;
          return (
            <span key={s.label} className={styles.legendItem}>
              <svg
                className={styles.swatch}
                viewBox="0 0 8 8"
                aria-hidden="true"
              >
                <rect width="8" height="8" rx="1.5" fill={s.color} />
              </svg>
              <span className={styles.legendLabel}>{s.label}</span>
              {last !== undefined && (
                <span className={styles.legendValue}>{format(last)}</span>
              )}
            </span>
          );
        })}
        {hasData && (
          <span className={styles.peak}>{`${peakLabel} ${format(maxV)}`}</span>
        )}
      </div>
    </div>
  );
}
