/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  buildBrailleLineChart,
  MONTH_LABELS,
  type LineChartPoint,
} from '../utils/asciiCharts.js';
import { fmtTokens, fmtDurationShort, TableRow } from './stats-helpers.js';
import { HeatmapView } from './StatsHeatmapView.js';
import type { StatsData } from '../utils/statsDataService.js';
import type { TimeRange } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

export const ActivityTab: React.FC<{
  data: StatsData;
  bodyWidth: number;
  chartMonthOffset: number;
  range: TimeRange;
}> = ({ data, bodyWidth, chartMonthOffset, range }) => {
  const heatmapWeeks = Math.min(
    26,
    Math.max(8, Math.floor((bodyWidth - 4) / 2)),
  );
  const col1Width = Math.floor(bodyWidth / 3);

  let totalTokens = 0;
  for (const m of Object.values(data.report.models)) {
    totalTokens += m.totalTokens;
  }

  const dailyTotals = new Map<string, number>();
  for (const d of data.tokensPerDay) {
    dailyTotals.set(d.date, (dailyTotals.get(d.date) || 0) + d.tokens);
  }
  const allDates = [...dailyTotals.keys()].sort();
  const availableMonths = [...new Set(allDates.map((d) => d.slice(0, 7)))]
    .sort()
    .reverse();
  const clampedOffset = Math.min(
    chartMonthOffset,
    Math.max(0, availableMonths.length - 1),
  );
  const chartMonth =
    range === 'all' && availableMonths.length > 0
      ? availableMonths[clampedOffset]!
      : null;
  const chartMonthLabel = chartMonth
    ? `${MONTH_LABELS[Number(chartMonth.slice(5, 7)) - 1]} ${chartMonth.slice(0, 4)}`
    : null;
  const canGoLeft = clampedOffset < availableMonths.length - 1;
  const canGoRight = clampedOffset > 0;
  const filteredTokens = chartMonth
    ? data.tokensPerDay.filter((d) => d.date.startsWith(chartMonth))
    : data.tokensPerDay;

  const filteredDailyTotals = new Map<string, number>();
  for (const d of filteredTokens) {
    filteredDailyTotals.set(
      d.date,
      (filteredDailyTotals.get(d.date) || 0) + d.tokens,
    );
  }

  const lineData: LineChartPoint[] = [...filteredDailyTotals.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const lineChart = buildBrailleLineChart(lineData, bodyWidth - 8, 8);

  return (
    <Box flexDirection="column">
      {/* KPI Row */}
      <Box flexDirection="row" marginBottom={1}>
        <Box width={col1Width}>
          <Text color={theme.text.secondary}>{t('Sessions')} </Text>
          <Text bold color={theme.text.primary}>
            {data.report.sessionCount}
          </Text>
          {data.delta?.sessions != null && (
            <Text
              color={
                data.delta.sessions >= 0
                  ? theme.status.success
                  : theme.status.error
              }
            >
              {' '}
              {data.delta.sessions >= 0 ? '\u25B2' : '\u25BC'}
              {Math.abs(data.delta.sessions).toFixed(0)}%
            </Text>
          )}
        </Box>
        <Box width={col1Width}>
          <Text color={theme.text.secondary}>{t('Duration')} </Text>
          <Text bold color={theme.text.primary}>
            {fmtDurationShort(data.report.totalDurationMs)}
          </Text>
          {data.delta?.duration != null && (
            <Text
              color={
                data.delta.duration >= 0
                  ? theme.status.success
                  : theme.status.error
              }
            >
              {' '}
              {data.delta.duration >= 0 ? '\u25B2' : '\u25BC'}
              {Math.abs(data.delta.duration).toFixed(0)}%
            </Text>
          )}
        </Box>
        <Box>
          <Text color={theme.text.secondary}>{t('Tokens')} </Text>
          <Text bold color={theme.status.warning}>
            {fmtTokens(totalTokens)}
          </Text>
          {data.delta?.tokens != null && (
            <Text
              color={
                data.delta.tokens >= 0
                  ? theme.status.success
                  : theme.status.error
              }
            >
              {' '}
              {data.delta.tokens >= 0 ? '\u25B2' : '\u25BC'}
              {Math.abs(data.delta.tokens).toFixed(0)}%
            </Text>
          )}
        </Box>
      </Box>

      {/* Heatmap with streak */}
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1}>
          <HeatmapView
            data={data}
            weeks={heatmapWeeks}
            monthOffset={clampedOffset}
          />
        </Box>
        <Box marginLeft={2} flexDirection="column">
          <Box>
            <Text color={theme.text.secondary}>{t('streak')}: </Text>
            <Text color={theme.status.success} bold>
              {data.currentStreak}
              {t('d')}
            </Text>
          </Box>
          <Box>
            <Text color={theme.text.secondary}>{t('best')}: </Text>
            <Text color={theme.status.warning} bold>
              {data.longestStreak}
              {t('d')}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Token Trend Chart */}
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold color={theme.text.primary}>
            {t('Token Trend')}
          </Text>
          {chartMonthLabel && (
            <Text color={theme.text.accent}>
              {'  '}
              {canGoLeft ? '\u2190 ' : '  '}
              {chartMonthLabel}
              {canGoRight ? ' \u2192' : ''}
            </Text>
          )}
        </Box>
        {lineChart ? (
          <Box flexDirection="column">
            {lineChart.rows.map((row, ri) => (
              <Box key={ri}>
                <Text color={theme.text.secondary}>
                  {lineChart.yLabels[ri]?.padStart(6) ?? '      '}
                  {'\u2502'}
                </Text>
                {row.map((cell, ci) => (
                  <Text
                    key={ci}
                    color={
                      cell.filled ? theme.text.accent : theme.text.secondary
                    }
                  >
                    {cell.char}
                  </Text>
                ))}
              </Box>
            ))}
            <Box>
              <Text color={theme.text.secondary}>
                {'      \u2514'}
                {lineChart.xLabels}
              </Text>
            </Box>
            <Box marginTop={0}>
              <Text color={theme.text.secondary}>
                {'       '}peak {fmtTokens(lineChart.peak)}
              </Text>
            </Box>
          </Box>
        ) : (
          <Text color={theme.text.secondary}>
            {'  '}
            {t('(no data)')}
          </Text>
        )}
      </Box>

      {/* Project Ranking */}
      {data.report.projects.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.text.primary}>
            {t('Projects')}
          </Text>
          <TableRow
            cells={[
              {
                text: '  ' + t('Project'),
                width: 22,
                color: theme.text.secondary,
              },
              { text: t('Sessions'), width: 10, color: theme.text.secondary },
              { text: t('Tokens'), width: 10, color: theme.text.secondary },
              { text: t('Duration'), width: 10, color: theme.text.secondary },
            ]}
          />
          {data.report.projects.slice(0, 5).map((proj) => {
            const name = proj.path.split('/').pop() || proj.path;
            const tokens = proj.totalInputTokens + proj.totalOutputTokens;
            return (
              <TableRow
                key={proj.path}
                cells={[
                  {
                    text: '  ' + name.slice(0, 18),
                    width: 22,
                    color: theme.text.primary,
                  },
                  {
                    text: String(proj.sessionCount),
                    width: 10,
                    color: theme.text.primary,
                  },
                  {
                    text: fmtTokens(tokens),
                    width: 10,
                    color: theme.status.warning,
                  },
                  {
                    text: fmtDurationShort(proj.totalDurationMs),
                    width: 10,
                    color: theme.text.secondary,
                  },
                ]}
              />
            );
          })}
        </Box>
      )}
    </Box>
  );
};
