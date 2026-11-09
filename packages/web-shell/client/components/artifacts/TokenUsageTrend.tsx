/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { DaemonSessionStatsModelMetrics } from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { formatDuration } from '../messages/StatsMessage';
import styles from './TokenUsageTrend.module.css';

type TimingSample = NonNullable<
  DaemonSessionStatsModelMetrics['timingSamples']
>[number];
type FailureSample = NonNullable<
  DaemonSessionStatsModelMetrics['failures']
>['recent'][number];

export interface TrendSeries {
  key: string;
  label: string;
  /** Color slot shared with the model card. */
  color: string;
  samples: TimingSample[];
  failures: FailureSample[];
}

export type TrendMetric = 'speed' | 'ttft';

const CHART_HEIGHT = 168;
const FAILURE_STRIP = 18;
const PAD = { left: 48, right: 8, top: 16, bottom: 22 } as const;
const HIT_RADIUS = 28;
const MEDIAN_WINDOW = 5;

/** Time from sending the request to its last visible output. */
function sampleDurationMs(sample: TimingSample): number {
  return sample.ttftMs + sample.generationMs;
}

/**
 * Output tokens per second over `durationMs`; undefined without output tokens
 * (no usage reported) or time.
 */
export function tokensPerSecond(
  outputTokens: number,
  durationMs: number,
): number | undefined {
  return outputTokens > 0 && durationMs > 0
    ? outputTokens / (durationMs / 1000)
    : undefined;
}

/**
 * Output tokens per second over the time from sending the request to its last
 * visible output, TTFT included.
 */
export function sampleSpeed(sample: TimingSample): number | undefined {
  return tokensPerSecond(sample.outputTokens, sampleDurationMs(sample));
}

function metricValue(
  sample: TimingSample,
  metric: TrendMetric,
): number | undefined {
  return metric === 'speed' ? sampleSpeed(sample) : sample.ttftMs / 1000;
}

/** Linear-interpolated quantile of an unsorted list; undefined when empty. */
export function quantile(values: number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}

/** Smallest 1/2/5 × 10^n step whose 4 ticks cover `max`. */
function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * power >= raw)! * power;
  return step * 4;
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatAxisValue(value: number, metric: TrendMetric): string {
  if (metric === 'speed') return String(Math.round(value));
  return `${Number.isInteger(value) ? value : value.toFixed(1)}s`;
}

interface PlotPoint {
  series: TrendSeries;
  x: number;
  y: number;
  sample?: TimingSample;
  failure?: FailureSample;
}

function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0) setWidth(element.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function TokenUsageTrend({ series }: { series: TrendSeries[] }) {
  const { t } = useI18n();
  const [metric, setMetric] = useState<TrendMetric>('speed');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<PlotPoint | null>(null);
  const [wrapRef, width] = useWidth(320);

  const visible = series.filter((s) => !hidden.has(s.key));
  const hasFailures = series.some((s) => s.failures.length > 0);
  const height = CHART_HEIGHT + (hasFailures ? FAILURE_STRIP : 0);
  const plotBottom = CHART_HEIGHT - PAD.bottom;

  const geometry = useMemo(() => {
    const times = series.flatMap((s) => [
      ...s.samples.map((p) => p.at),
      ...s.failures.map((f) => f.at),
    ]);
    let tMin = Math.min(...times);
    let tMax = Math.max(...times);
    if (!(tMax > tMin)) {
      tMin -= 30_000;
      tMax += 30_000;
    }
    const values = visible.flatMap((s) =>
      s.samples
        .map((p) => metricValue(p, metric))
        .filter((v): v is number => v !== undefined),
    );
    const yMax = niceMax(Math.max(0, ...values));
    const x = (at: number) =>
      PAD.left + ((at - tMin) / (tMax - tMin)) * (width - PAD.left - PAD.right);
    const y = (value: number) =>
      PAD.top + (1 - value / yMax) * (plotBottom - PAD.top);
    return { tMin, tMax, yMax, x, y };
  }, [series, visible, metric, width, plotBottom]);

  const plotted = useMemo(() => {
    const points: PlotPoint[] = [];
    const lines: Array<{ series: TrendSeries; d: string }> = [];
    for (const s of visible) {
      const valued = s.samples
        .map((sample) => ({ sample, value: metricValue(sample, metric) }))
        .filter(
          (p): p is { sample: TimingSample; value: number } =>
            p.value !== undefined,
        )
        .sort((a, b) => a.sample.at - b.sample.at);
      const half = Math.floor(MEDIAN_WINDOW / 2);
      const path = valued.map((p, index) => {
        const window = valued
          .slice(Math.max(0, index - half), index + half + 1)
          .map((w) => w.value);
        const median = quantile(window, 0.5)!;
        const command = index === 0 ? 'M' : 'L';
        return `${command}${geometry.x(p.sample.at).toFixed(1)},${geometry.y(median).toFixed(1)}`;
      });
      if (path.length > 1) lines.push({ series: s, d: path.join('') });
      for (const p of valued) {
        points.push({
          series: s,
          sample: p.sample,
          x: geometry.x(p.sample.at),
          y: geometry.y(p.value),
        });
      }
      for (const failure of s.failures) {
        points.push({
          series: s,
          failure,
          x: geometry.x(failure.at),
          y: CHART_HEIGHT + FAILURE_STRIP / 2 - 4,
        });
      }
    }
    return { points, lines };
  }, [visible, metric, geometry]);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      let best: PlotPoint | null = null;
      let bestDistance = HIT_RADIUS;
      for (const point of plotted.points) {
        const distance = Math.hypot(point.x - px, (point.y - py) * 0.6);
        if (distance < bestDistance) {
          best = point;
          bestDistance = distance;
        }
      }
      setActive(best);
    },
    [plotted.points],
  );

  useEffect(() => setActive(null), [metric, hidden]);

  const toggleSeries = (key: string) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      // Hiding every series would leave an empty chart; show all instead.
      return next.size === series.length ? new Set() : next;
    });

  const ticks = [0, 1, 2, 3, 4].map((i) => (geometry.yMax * i) / 4);
  const timeTicks = [0, 1, 2].map(
    (i) => geometry.tMin + ((geometry.tMax - geometry.tMin) * i) / 2,
  );
  const metricLabel =
    metric === 'speed'
      ? t('tokenUsage.outputSpeed')
      : t('tokenUsage.firstToken');
  const summary = t('tokenUsage.trendSummary', {
    metric: metricLabel,
    models: visible
      .map((s) => {
        const median = quantile(
          s.samples
            .map((p) => metricValue(p, metric))
            .filter((v): v is number => v !== undefined),
          0.5,
        );
        return median === undefined
          ? s.label
          : `${s.label} ${formatAxisValue(median, metric)}`;
      })
      .join(', '),
  });

  return (
    <div className={styles.trend} data-testid="token-usage-trend">
      <div className={styles.header}>
        <h3 className={styles.title}>{t('tokenUsage.trendTitle')}</h3>
        <div className={styles.metricToggle} role="group">
          {(['speed', 'ttft'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={metric === value}
              onClick={() => setMetric(value)}
            >
              {value === 'speed'
                ? t('tokenUsage.outputSpeed')
                : t('tokenUsage.firstToken')}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.chart} ref={wrapRef}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={summary}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerMove}
          onPointerLeave={(event) => {
            // A touch ends with pointerleave; keep the tapped point until the
            // next tap lands elsewhere.
            if (event.pointerType !== 'touch') setActive(null);
          }}
        >
          <text className={styles.axisUnit} x={PAD.left} y={8}>
            {metric === 'speed' ? 'tok/s' : t('tokenUsage.trendSeconds')}
          </text>
          {ticks.map((value) => (
            <g key={value}>
              <line
                className={styles.grid}
                x1={PAD.left}
                x2={width - PAD.right}
                y1={geometry.y(value)}
                y2={geometry.y(value)}
              />
              <text
                className={styles.axisLabel}
                x={PAD.left - 6}
                y={geometry.y(value) + 3}
                textAnchor="end"
              >
                {formatAxisValue(value, metric)}
              </text>
            </g>
          ))}
          {timeTicks.map((at, index) => (
            <text
              key={index}
              className={styles.axisLabel}
              x={geometry.x(at)}
              y={plotBottom + 14}
              textAnchor={
                index === 0 ? 'start' : index === 2 ? 'end' : 'middle'
              }
            >
              {formatClock(at)}
            </text>
          ))}
          {plotted.lines.map(({ series: s, d }) => (
            <path
              key={s.key}
              className={styles.line}
              data-share-color={s.color}
              d={d}
            />
          ))}
          {plotted.points.map((point, index) =>
            point.sample ? (
              <circle
                key={index}
                className={styles.dot}
                data-share-color={point.series.color}
                cx={point.x}
                cy={point.y}
                r={2.5}
              />
            ) : null,
          )}
          {hasFailures && (
            <text
              className={styles.axisLabel}
              x={PAD.left - 6}
              y={CHART_HEIGHT + FAILURE_STRIP / 2}
              textAnchor="end"
            >
              {t('tokenUsage.trendFailed')}
            </text>
          )}
          {plotted.points.map((point, index) =>
            point.failure ? (
              <path
                key={`f${index}`}
                className={styles.failure}
                d={`M${point.x - 3.5},${point.y - 3.5}l7,7m0,-7l-7,7`}
              />
            ) : null,
          )}
          {active && (
            <g aria-hidden="true">
              {active.sample && (
                <line
                  className={styles.crosshair}
                  x1={active.x}
                  x2={active.x}
                  y1={PAD.top}
                  y2={plotBottom}
                />
              )}
              <circle
                className={styles.highlight}
                data-share-color={active.series.color}
                data-failure={active.failure ? true : undefined}
                cx={active.x}
                cy={active.y}
                r={5.5}
              />
            </g>
          )}
        </svg>
        {active && <TrendTooltip point={active} chartWidth={width} />}
      </div>
      {series.length > 1 && (
        <ul className={styles.legend}>
          {series.map((s) => (
            <li key={s.key} data-share-color={s.color}>
              <button
                type="button"
                aria-pressed={!hidden.has(s.key)}
                onClick={() => toggleSeries(s.key)}
              >
                <span className={styles.swatch} aria-hidden="true" />
                <span className={styles.legendName} title={s.key}>
                  {s.label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className={styles.note}>{t('tokenUsage.trendNote')}</p>
    </div>
  );
}

function TrendTooltip({
  point,
  chartWidth,
}: {
  point: PlotPoint;
  chartWidth: number;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (element) {
      setSize({ width: element.offsetWidth, height: element.offsetHeight });
    }
  }, [point]);
  const { sample, failure, series } = point;
  const at = sample?.at ?? failure!.at;
  const source = sample?.source ?? failure?.source;
  const speed = sample ? sampleSpeed(sample) : undefined;
  const left = Math.min(
    Math.max(0, point.x - size.width / 2),
    Math.max(0, chartWidth - size.width),
  );
  const top = Math.max(0, point.y - size.height - 10);
  return (
    <div
      ref={ref}
      className={styles.tooltip}
      role="tooltip"
      style={{ left, top }}
      data-share-color={series.color}
    >
      <div className={styles.tooltipHead}>
        <span className={styles.swatch} aria-hidden="true" />
        <strong>{series.label}</strong>
        <span>
          {formatClock(at)}
          {source ? ` · ${source}` : ''}
        </span>
      </div>
      {failure ? (
        <div>{t('tokenUsage.trendFailure', { kind: failure.kind })}</div>
      ) : (
        <>
          <div>
            {speed !== undefined
              ? t('tokenUsage.trendSpeed', {
                  rate: speed.toFixed(1),
                  ttft: formatDuration(sample!.ttftMs),
                })
              : t('tokenUsage.trendTtftOnly', {
                  ttft: formatDuration(sample!.ttftMs),
                })}
          </div>
          <div>
            {t('tokenUsage.trendOutput', {
              count: sample!.outputTokens.toLocaleString('en-US'),
              duration: formatDuration(sampleDurationMs(sample!)),
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** Per-model output-speed spread: every sample as a dot on a shared scale. */
export function SpeedSpread({
  samples,
  scaleMax,
}: {
  samples: TimingSample[];
  scaleMax: number;
}) {
  const { t } = useI18n();
  const speeds = samples
    .map(sampleSpeed)
    .filter((v): v is number => v !== undefined);
  if (speeds.length < 2 || !(scaleMax > 0)) return null;
  const p10 = quantile(speeds, 0.1)!;
  const p50 = quantile(speeds, 0.5)!;
  const p90 = quantile(speeds, 0.9)!;
  const pct = (value: number) => `${Math.min(100, (value / scaleMax) * 100)}%`;
  const text = t('tokenUsage.speedSpread', {
    p50: p50.toFixed(0),
    p10: p10.toFixed(0),
    p90: p90.toFixed(0),
  });
  return (
    <div className={styles.spread} data-testid="token-usage-speed-spread">
      <div className={styles.spreadTrack} aria-hidden="true">
        <div
          className={styles.spreadRange}
          style={{ left: pct(p10), width: `calc(${pct(p90)} - ${pct(p10)})` }}
        />
        {speeds.map((speed, index) => (
          <span
            key={index}
            className={styles.spreadDot}
            style={{ left: pct(speed) }}
          />
        ))}
        <span className={styles.spreadMedian} style={{ left: pct(p50) }} />
      </div>
      <span className={styles.spreadText} title={text}>
        {text}
      </span>
    </div>
  );
}
