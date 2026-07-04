import { useMemo } from 'react';
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
  /** Format a y value for the peak label + per-series current value. */
  format?: (value: number) => string;
  /** Start the y-axis at 0 (default) so magnitudes read honestly, vs. auto-min
   *  which exaggerates small wiggles. */
  zeroBased?: boolean;
  /** Accessible description of what the chart shows. */
  ariaLabel?: string;
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

/**
 * Dependency-free inline-SVG line chart for the Daemon Status dashboard. Draws
 * one or more equal-length series on a shared, zero-based y-axis. Kept
 * deliberately tiny (a sparkline with a legend) rather than pulling a charting
 * lib into the self-contained, CSP-strict `serve --web` bundle.
 */
export function SvgLineChart({
  series,
  format = (v) => String(Math.round(v)),
  zeroBased = true,
  ariaLabel,
}: SvgLineChartProps) {
  const { paths, maxV, hasData } = useMemo(() => {
    const maxLen = series.reduce((m, s) => Math.max(m, s.values.length), 0);
    let max = 0;
    let min = zeroBased ? 0 : Number.POSITIVE_INFINITY;
    for (const s of series) {
      for (const v of s.values) {
        if (!Number.isFinite(v)) continue;
        if (v > max) max = v;
        if (v < min) min = v;
      }
    }
    if (!Number.isFinite(min)) min = 0;
    // Flat/all-zero series: a unit span avoids /0 and pins the line to the
    // baseline instead of NaN.
    const span = max - min || 1;

    // A single bucket can't form a line; place it mid-width so the current-value
    // dot still renders during cold start.
    const xAt = (i: number): number =>
      maxLen <= 1 ? PAD + INNER_W / 2 : PAD + (i / (maxLen - 1)) * INNER_W;
    const yAt = (v: number): number =>
      PAD + INNER_H - ((finiteOr(v, min) - min) / span) * INNER_H;

    const built = series.map((s) => {
      const d = s.values
        .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
        .join(' ');
      const lastIdx = s.values.length - 1;
      const dot =
        lastIdx >= 0
          ? { cx: xAt(lastIdx), cy: yAt(s.values[lastIdx]), color: s.color }
          : undefined;
      return { key: s.label, d, color: s.color, dot };
    });
    return { paths: built, maxV: max, hasData: maxLen > 0 };
  }, [series, zeroBased]);

  return (
    <div className={styles.chart}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
        className={styles.svg}
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
        {paths.map(
          (p) =>
            p.dot && (
              <circle
                key={`${p.key}-dot`}
                cx={p.dot.cx}
                cy={p.dot.cy}
                r={2}
                fill={p.dot.color}
                vectorEffect="non-scaling-stroke"
              />
            ),
        )}
      </svg>
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
          <span className={styles.peak}>{`peak ${format(maxV)}`}</span>
        )}
      </div>
    </div>
  );
}
