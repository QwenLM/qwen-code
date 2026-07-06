/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import {
  useUsageDashboard,
  type DaemonUsageRange,
  type DaemonUsageModelShare,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { formatMegaTokens } from '../../utils/formatTokenCount';
import { TokenHeatmap } from './TokenHeatmap';
import { SvgLineChart } from './SvgLineChart';
import styles from './UsageDashboardTab.module.css';

// The heatmap window as one semantic constant: the sub-label uses the month
// count directly, and the day count (for the day-bucketed API) is derived from
// it, so the label and the requested window can never drift.
const HEATMAP_MONTHS = 12;
const HEATMAP_DAYS = Math.round(HEATMAP_MONTHS * 30.44); // ≈ 365

// The summary-period toggle (mockup: Today / 7D / 30D). `week`/`month` map to
// core's trailing 7/30-day windows.
const RANGES: readonly DaemonUsageRange[] = ['today', 'week', 'month'];
const PERIOD_LABEL_KEY: Record<DaemonUsageRange, string> = {
  today: 'daemon.usage.today',
  week: 'daemon.usage.period7d',
  month: 'daemon.usage.period30d',
};
const HERO_LABEL_KEY: Record<DaemonUsageRange, string> = {
  today: 'daemon.usage.today',
  week: 'daemon.usage.rangeWeek',
  month: 'daemon.usage.rangeMonth',
};
// Short window word prefixed to the model/skill/chart section titles (mockup:
// "7 DAYS MODEL SHARE"). Uppercased by CSS.
const RANGE_WORD_KEY: Record<DaemonUsageRange, string> = {
  today: 'daemon.usage.rangeWordToday',
  week: 'daemon.usage.rangeWordWeek',
  month: 'daemon.usage.rangeWordMonth',
};
// Fixed categorical palette for the model rows (rank badge + bar + share%).
const RANK_COLORS = [
  '#3b82f6',
  '#14b8a6',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#22c55e',
  '#06b6d4',
  '#ec4899',
];

function dayMs(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00`).getTime();
}

function shortDay(dateKey: string, locale: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
  });
}

function shortDayMs(ms: number, locale: string): string {
  return new Date(ms).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
  });
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statValue}>{value.toLocaleString()}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  );
}

function Metric({
  accent,
  value,
  label,
  hint,
}: {
  accent: 'input' | 'output' | 'cache';
  value: string;
  label: string;
  hint: string;
}) {
  return (
    <div className={styles.metric}>
      <div className={styles.metricHead}>
        <span className={`${styles.tick} ${styles[`tick_${accent}`]}`} />
        <span className={styles.metricLabel}>{label}</span>
      </div>
      <div className={styles.metricValue}>{value}</div>
      <div className={styles.metricHint}>{hint}</div>
    </div>
  );
}

function ModelRow({
  rank,
  model,
  color,
}: {
  rank: number;
  model: DaemonUsageModelShare;
  color: string;
}) {
  const { t } = useI18n();
  const sharePct = Math.max(0, Math.min(100, model.share * 100));
  const cachePct = Math.max(0, Math.min(100, model.cacheReadRate * 100));
  return (
    <div className={styles.modelRow}>
      <div className={styles.modelHead}>
        <span className={styles.modelRank} style={{ color }}>
          {String(rank).padStart(2, '0')}
        </span>
        <div className={styles.modelMeta}>
          <div className={styles.modelName}>{model.model}</div>
          <div className={styles.modelSub}>
            {t('daemon.usage.modelMeta', {
              tokens: formatMegaTokens(model.totalTokens),
              cache: Math.round(cachePct),
            })}
          </div>
        </div>
        <span className={styles.modelShare} style={{ color }}>
          {Math.round(sharePct)}%
        </span>
      </div>
      {/* Bar width = token share; the light-green overlay from the left marks
          the cache-read fraction of this model's own tokens. */}
      <div className={styles.modelTrack}>
        <div
          className={styles.modelFill}
          style={{ width: `${sharePct}%`, background: color }}
        >
          <div
            className={styles.modelFillCache}
            style={{ width: `${cachePct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function MiniBars({
  points,
  format,
  locale,
}: {
  points: Array<{ label: string; value: number }>;
  format: (n: number) => string;
  locale: string;
}) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div className={styles.bars}>
      <div className={styles.barsBody}>
        {points.map((p, i) => (
          <div
            key={`${p.label}-${i}`}
            className={styles.barCol}
            title={`${shortDay(p.label, locale)} · ${format(p.value)}`}
          >
            <div
              className={styles.bar}
              style={{ height: `${(p.value / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      {points.length > 1 && (
        <div className={styles.barsCaption}>
          <span>{shortDay(points[0]!.label, locale)}</span>
          <span>{shortDay(points[points.length - 1]!.label, locale)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Daemon Status "统计 / Usage" tab: a Today/7D/30D period toggle over the
 * selected range's totals + breakdown, a ~12-month token heatmap, and — below
 * it — per-model token share, skill-call counts, and daily token/session
 * charts for the range. Mounts only when the tab is active, so the aggregate
 * loads on demand; the daemon caches it per range.
 */
export function UsageDashboardTab() {
  const { t, language } = useI18n();
  const [range, setRange] = useState<DaemonUsageRange>('today');
  const { dashboard, loading, error, reload } = useUsageDashboard({
    range,
    heatmapDays: HEATMAP_DAYS,
    autoLoad: true,
  });

  const periodToggle = (
    <div
      className={styles.segmented}
      role="group"
      aria-label={t('daemon.usage.rangeGroup')}
    >
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          className={`${styles.segment} ${
            r === range ? styles.segmentActive : ''
          }`}
          aria-pressed={r === range}
          onClick={() => setRange(r)}
        >
          {t(PERIOD_LABEL_KEY[r])}
        </button>
      ))}
    </div>
  );

  if (!dashboard) {
    return (
      <div className={styles.usage}>
        <div className={styles.toolbar}>{periodToggle}</div>
        {loading ? (
          <div className={styles.state}>{t('daemon.usage.loading')}</div>
        ) : error ? (
          <div className={styles.state}>
            {t('daemon.usage.failed')}: {error.message}
          </div>
        ) : (
          <div className={styles.state}>{t('daemon.usage.empty')}</div>
        )}
      </div>
    );
  }

  const { summary, models, skills, daily, heatmap, heatmapDays } = dashboard;
  const changes = summary.linesAdded + summary.linesRemoved;
  const hasHeatmap = summary.totalTokens > 0 || Object.keys(heatmap).length > 0;
  const rangeWord = t(RANGE_WORD_KEY[dashboard.range]);

  return (
    <div className={styles.usage} aria-busy={loading}>
      <div className={styles.toolbar}>{periodToggle}</div>

      <header className={styles.hero}>
        <div className={styles.heroMain}>
          {/* Label the window the numbers actually cover (server echo), so it
              stays consistent with the totals during an in-flight switch. */}
          <div className={styles.heroLabel}>
            {t(HERO_LABEL_KEY[dashboard.range])}
          </div>
          <div className={styles.heroNumber}>
            {formatMegaTokens(summary.totalTokens)}
          </div>
          <div className={styles.heroSub}>
            {t('daemon.usage.tokensConsumed')}
          </div>
        </div>
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void reload()}
          disabled={loading}
        >
          {t('daemon.refresh')}
        </button>
      </header>

      <div className={styles.stats}>
        <Stat label={t('daemon.usage.sessions')} value={summary.sessions} />
        <Stat label={t('daemon.usage.requests')} value={summary.requests} />
        <Stat label={t('daemon.usage.tools')} value={summary.toolCalls} />
        <Stat label={t('daemon.usage.changes')} value={changes} />
      </div>

      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>
          {t('daemon.usage.breakdownTitle')}
        </h4>
        <div className={styles.breakdown}>
          <Metric
            accent="input"
            value={formatMegaTokens(summary.inputTokens)}
            label={t('daemon.usage.inputTokens')}
            hint={t('daemon.usage.inputHint')}
          />
          <Metric
            accent="output"
            value={formatMegaTokens(
              summary.outputTokens + summary.thoughtsTokens,
            )}
            label={t('daemon.usage.outputTokens')}
            hint={t('daemon.usage.outputHint')}
          />
          <Metric
            accent="cache"
            value={`${Math.round(summary.cacheReadRate * 100)}%`}
            label={t('daemon.usage.cacheRead')}
            hint={t('daemon.usage.cacheHint')}
          />
        </div>
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>
          {t('daemon.usage.heatmapTitle')}
        </h4>
        <div className={styles.sectionSub}>
          {t('daemon.usage.heatmapSub', { months: HEATMAP_MONTHS })}
        </div>
        {hasHeatmap ? (
          <TokenHeatmap heatmap={heatmap} days={heatmapDays} />
        ) : (
          <div className={styles.state}>{t('daemon.usage.empty')}</div>
        )}
      </section>

      {models.length > 0 && (
        <section className={styles.section}>
          <h4 className={styles.sectionTitle}>
            {rangeWord} {t('daemon.usage.modelShareTitle')}
          </h4>
          <div className={styles.sectionSub}>
            {t('daemon.usage.modelShareSub')}
          </div>
          <div className={styles.modelList}>
            {models.map((m, i) => (
              <ModelRow
                key={m.model}
                rank={i + 1}
                model={m}
                color={RANK_COLORS[i % RANK_COLORS.length]!}
              />
            ))}
          </div>
        </section>
      )}

      {skills.length > 0 && (
        <section className={styles.section}>
          <h4 className={styles.sectionTitle}>
            {rangeWord} {t('daemon.usage.skillTitle')}
          </h4>
          <div className={styles.sectionSub}>{t('daemon.usage.skillSub')}</div>
          <table className={styles.skillTable}>
            <thead>
              <tr>
                <th>{t('daemon.usage.skillName')}</th>
                <th className={styles.right}>{t('daemon.usage.skillCount')}</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td className={styles.right}>{s.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {daily.length > 1 && (
        <section className={styles.section}>
          <h4 className={styles.sectionTitle}>
            {rangeWord} {t('daemon.usage.dailyTokensTitle')}
          </h4>
          <div className={styles.sectionSub}>
            {t('daemon.usage.dailyTokensSub')}
          </div>
          <SvgLineChart
            series={[
              {
                label: t('daemon.usage.tokensConsumed'),
                values: daily.map((d) => d.tokens),
                color: 'var(--agent-blue-400)',
              },
            ]}
            timestamps={daily.map((d) => dayMs(d.date))}
            format={formatMegaTokens}
            formatTime={(ms) => shortDayMs(ms, language)}
            ariaLabel={t('daemon.usage.dailyTokensTitle')}
            peakLabel={t('daemon.charts.peak')}
          />
        </section>
      )}

      {daily.length > 1 && (
        <section className={styles.section}>
          <h4 className={styles.sectionTitle}>
            {rangeWord} {t('daemon.usage.dailySessionsTitle')}
          </h4>
          <div className={styles.sectionSub}>
            {t('daemon.usage.dailySessionsSub')}
          </div>
          <MiniBars
            points={daily.map((d) => ({ label: d.date, value: d.sessions }))}
            format={(n) => n.toLocaleString()}
            locale={language}
          />
        </section>
      )}
    </div>
  );
}
