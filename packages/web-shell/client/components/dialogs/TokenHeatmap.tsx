/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { useI18n } from '../../i18n';
import { formatMegaTokens } from '../../utils/formatTokenCount';
import styles from './TokenHeatmap.module.css';

const MS_PER_DAY = 86_400_000;
// GitHub-style 5-step ramp: 0 = empty track, 1..4 = increasing intensity.
const LEVEL_COUNT = 4;

interface HeatmapDay {
  tokens: number;
  /** cachedTokens / inputTokens for that day, 0..1. */
  cacheReadRate: number;
}

interface TokenHeatmapProps {
  /** Per-day cells keyed by local `YYYY-MM-DD`. */
  heatmap: Record<string, HeatmapDay>;
  /** Trailing days the daemon aggregated (drives the rendered window). */
  days: number;
}

interface Cell {
  dateKey: string;
  tokens: number;
  cacheReadRate: number;
  level: number;
  isToday: boolean;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** Column index (0-based) from the earliest rendered week. */
  week: number;
}

interface MonthLabel {
  week: number;
  text: string;
}

interface HeatmapModel {
  cells: Cell[];
  months: MonthLabel[];
  weeks: number;
}

interface Tooltip {
  left: number;
  top: number;
  text: string;
}

function startOfLocalDay(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

function localDateKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Quartile thresholds over the nonzero day totals, so a few heavy days don't
 * flatten every other day to level 1. Returns the 25/50/75 percentile cut
 * points; `levelFor` maps a value onto 0..4 against them.
 */
function quartileThresholds(values: number[]): [number, number, number] {
  const nonzero = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nonzero.length === 0) return [0, 0, 0];
  const at = (p: number) =>
    nonzero[
      Math.min(nonzero.length - 1, Math.floor(p * (nonzero.length - 1)))
    ]!;
  return [at(0.25), at(0.5), at(0.75)];
}

function levelFor(v: number, [t1, t2, t3]: [number, number, number]): number {
  if (v <= 0) return 0;
  if (v <= t1) return 1;
  if (v <= t2) return 2;
  if (v <= t3) return 3;
  return LEVEL_COUNT;
}

function buildModel(
  heatmap: Record<string, HeatmapDay>,
  days: number,
  locale: string,
): HeatmapModel {
  const window = Math.max(1, Math.floor(days));
  const today = startOfLocalDay(Date.now());
  const first = startOfLocalDay(today.getTime() - (window - 1) * MS_PER_DAY);
  // Align the first column to a Monday so weeks stack cleanly (Mon..Sun).
  const firstWeekday = (first.getDay() + 6) % 7;
  const gridStart = startOfLocalDay(
    first.getTime() - firstWeekday * MS_PER_DAY,
  );

  const totalDays =
    Math.round((today.getTime() - gridStart.getTime()) / MS_PER_DAY) + 1;

  const rawCells: Array<Omit<Cell, 'level'>> = [];
  const values: number[] = [];
  const todayKey = localDateKey(today);
  for (let i = 0; i < totalDays; i++) {
    const date = new Date(gridStart.getTime() + i * MS_PER_DAY);
    const key = localDateKey(date);
    const cell = heatmap[key];
    const tokens = cell?.tokens ?? 0;
    values.push(tokens);
    rawCells.push({
      dateKey: key,
      tokens,
      cacheReadRate: cell?.cacheReadRate ?? 0,
      isToday: key === todayKey,
      weekday: i % 7,
      week: Math.floor(i / 7),
    });
  }

  const thresholds = quartileThresholds(values);
  const cells: Cell[] = rawCells.map((c) => ({
    ...c,
    level: levelFor(c.tokens, thresholds),
  }));
  const weeks = Math.ceil(totalDays / 7);

  // Label a month at the first week whose Monday falls in a new month.
  const months: MonthLabel[] = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const monday = new Date(gridStart.getTime() + w * 7 * MS_PER_DAY);
    const m = monday.getMonth();
    if (m !== lastMonth) {
      months.push({
        week: w,
        text: monday.toLocaleDateString(locale, { month: 'short' }),
      });
      lastMonth = m;
    }
  }

  return { cells, months, weeks };
}

export function TokenHeatmap({ heatmap, days }: TokenHeatmapProps) {
  const { t, language } = useI18n();
  const model = useMemo(
    () => buildModel(heatmap, days, language),
    [heatmap, days, language],
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  // Mon/Wed/Fri row labels, matching the mockup (weekday index 0/2/4).
  const weekdayLabels: Record<number, string> = {
    0: t('daemon.usage.dowMon'),
    2: t('daemon.usage.dowWed'),
    4: t('daemon.usage.dowFri'),
  };

  // Delegated hover: read the cell's data-* and place a tooltip centered above
  // it, positioned relative to the wrap so horizontal scroll doesn't offset it.
  // Gaps between cells (no data-date) leave the current tooltip untouched to
  // avoid flicker; leaving the grid clears it.
  const handlePointer = (e: MouseEvent<HTMLDivElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-date]');
    const wrap = wrapRef.current;
    if (!cell || !wrap) return;
    const date = cell.dataset['date'] ?? '';
    const tokens = Number(cell.dataset['tokens'] ?? '0');
    const cache = Number(cell.dataset['cache'] ?? '0');
    const cellRect = cell.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    setTooltip({
      left: cellRect.left - wrapRect.left + cellRect.width / 2,
      top: cellRect.top - wrapRect.top,
      text: t('daemon.usage.cellTokens', {
        date,
        tokens: formatMegaTokens(tokens),
        cache: Math.round(cache * 100),
      }),
    });
  };

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <div className={styles.legend}>
        <span className={styles.legendLabel}>{t('daemon.usage.low')}</span>
        {[0, 1, 2, 3, 4].map((lvl) => (
          <span
            key={lvl}
            className={`${styles.cell} ${styles.legendCell} ${styles[`lvl${lvl}`]}`}
          />
        ))}
        <span className={styles.legendLabel}>{t('daemon.usage.high')}</span>
      </div>
      <div
        className={styles.scroll}
        onMouseOver={handlePointer}
        onMouseLeave={() => setTooltip(null)}
      >
        <div
          className={styles.grid}
          role="img"
          aria-label={t('daemon.usage.heatmapTitle')}
          style={{
            gridTemplateColumns: `auto repeat(${model.weeks}, var(--hm-cell))`,
          }}
        >
          {model.months.map((m) => (
            <div
              key={`m-${m.week}`}
              className={styles.month}
              style={{ gridColumn: m.week + 2, gridRow: 1 }}
            >
              {m.text}
            </div>
          ))}
          {[0, 2, 4].map((wd) => (
            <div
              key={`wd-${wd}`}
              className={styles.weekday}
              style={{ gridColumn: 1, gridRow: wd + 2 }}
            >
              {weekdayLabels[wd]}
            </div>
          ))}
          {model.cells.map((c) => (
            <div
              key={c.dateKey}
              className={`${styles.cell} ${styles[`lvl${c.level}`]} ${
                c.isToday ? styles.today : ''
              }`}
              style={{ gridColumn: c.week + 2, gridRow: c.weekday + 2 }}
              data-date={c.dateKey}
              data-tokens={c.tokens}
              data-cache={c.cacheReadRate}
            />
          ))}
        </div>
      </div>
      {tooltip && (
        <div
          className={styles.tooltip}
          style={{ left: tooltip.left, top: tooltip.top }}
          role="status"
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
