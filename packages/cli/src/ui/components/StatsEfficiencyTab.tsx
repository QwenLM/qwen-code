/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  fmtTokens,
  fmtSuccessBar,
  getSuccessColor,
  getCacheColor,
  TableRow,
  getSeriesColors,
} from './stats-helpers.js';
import type { StatsData } from '../utils/statsDataService.js';
import { t } from '../../i18n/index.js';

export const EfficiencyTab: React.FC<{
  data: StatsData;
  bodyWidth: number;
}> = ({ data, bodyWidth }) => {
  const SERIES_COLORS = getSeriesColors();
  const cardWidth = Math.floor((bodyWidth - 4) / 3);
  const modelEntries = Object.entries(data.report.models).sort(
    (a, b) => b[1].totalTokens - a[1].totalTokens,
  );

  return (
    <Box flexDirection="column">
      {/* Performance Cards Row */}
      <Box flexDirection="row" marginBottom={1}>
        <Box
          width={cardWidth}
          flexDirection="column"
          borderStyle="single"
          borderColor={theme.border.default}
          paddingX={1}
        >
          <Text color={theme.text.secondary}>{t('Cache Hit Rate')}</Text>
          <Text bold color={getCacheColor(data.efficiency.cacheHitRate)}>
            {data.efficiency.cacheHitRate.toFixed(1)}%
          </Text>
          {data.delta?.cacheRate != null && (
            <Text
              color={
                data.delta.cacheRate >= 0
                  ? theme.status.success
                  : theme.status.error
              }
            >
              {data.delta.cacheRate >= 0 ? '\u25B2' : '\u25BC'}{' '}
              {Math.abs(data.delta.cacheRate).toFixed(1)}%
            </Text>
          )}
        </Box>
        <Box
          width={cardWidth}
          flexDirection="column"
          borderStyle="single"
          borderColor={theme.border.default}
          paddingX={1}
          marginLeft={1}
        >
          <Text color={theme.text.secondary}>{t('Tool Success')}</Text>
          <Text bold color={getSuccessColor(data.efficiency.toolSuccessRate)}>
            {data.efficiency.toolSuccessRate.toFixed(1)}%
          </Text>
          {data.delta?.toolSuccess != null && (
            <Text
              color={
                data.delta.toolSuccess >= 0
                  ? theme.status.success
                  : theme.status.error
              }
            >
              {data.delta.toolSuccess >= 0 ? '\u25B2' : '\u25BC'}{' '}
              {Math.abs(data.delta.toolSuccess).toFixed(1)}%
            </Text>
          )}
        </Box>
        <Box
          width={cardWidth}
          flexDirection="column"
          borderStyle="single"
          borderColor={theme.border.default}
          paddingX={1}
          marginLeft={1}
        >
          <Text color={theme.text.secondary}>{t('Avg Latency')}</Text>
          <Text bold color={theme.text.accent}>
            {data.efficiency.avgLatencyMs != null
              ? `${(data.efficiency.avgLatencyMs / 1000).toFixed(1)}s`
              : '\u2014'}
          </Text>
          {data.delta?.avgLatency != null && (
            <Text
              color={
                data.delta.avgLatency <= 0
                  ? theme.status.success
                  : theme.status.error
              }
            >
              {data.delta.avgLatency <= 0 ? '\u25BC' : '\u25B2'}{' '}
              {Math.abs(data.delta.avgLatency / 1000).toFixed(1)}s
            </Text>
          )}
        </Box>
      </Box>

      {/* Tool Leaderboard */}
      {data.toolLeaderboard.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.text.primary}>
            {t('Tool Leaderboard')}
          </Text>
          <TableRow
            cells={[
              {
                text: '  ' + t('Tool'),
                width: 16,
                color: theme.text.secondary,
              },
              { text: t('Calls'), width: 10, color: theme.text.secondary },
              { text: t('Time'), width: 12, color: theme.text.secondary },
              { text: t('Success'), width: 22, color: theme.text.secondary },
            ]}
          />
          {data.toolLeaderboard.map((tool) => (
            <TableRow
              key={tool.name}
              cells={[
                {
                  text: '  ' + tool.name.slice(0, 14),
                  width: 16,
                  color: theme.text.accent,
                },
                {
                  text: String(tool.count),
                  width: 10,
                  color: theme.text.primary,
                },
                {
                  text: `${(tool.totalDurationMs / 1000).toFixed(1)}s`,
                  width: 12,
                  color: theme.text.secondary,
                },
                {
                  text: `${fmtSuccessBar(tool.successRate)} ${tool.successRate.toFixed(0)}%`,
                  width: 22,
                  color: getSuccessColor(tool.successRate),
                },
              ]}
            />
          ))}
        </Box>
      )}

      {/* Model Comparison Table */}
      {modelEntries.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.text.primary}>
            {t('Models')}
          </Text>
          <TableRow
            cells={[
              {
                text: '  ' + t('Model'),
                width: 20,
                color: theme.text.secondary,
              },
              { text: t('Reqs'), width: 7, color: theme.text.secondary },
              { text: t('In/Out'), width: 14, color: theme.text.secondary },
              { text: t('Thoughts'), width: 9, color: theme.text.secondary },
              { text: t('Cache'), width: 7, color: theme.text.secondary },
              { text: t('Latency'), width: 8, color: theme.text.secondary },
            ]}
          />
          {modelEntries.map(([name, m], i) => {
            const cacheRate =
              m.inputTokens > 0 ? (m.cachedTokens / m.inputTokens) * 100 : 0;
            const latency =
              m.totalLatencyMs > 0 && m.requests > 0
                ? `${(m.totalLatencyMs / m.requests / 1000).toFixed(1)}s`
                : '\u2014';
            return (
              <TableRow
                key={name}
                cells={[
                  {
                    text: `\u25CF ${name.slice(0, 17)}`,
                    width: 20,
                    color: SERIES_COLORS[i % SERIES_COLORS.length],
                  },
                  {
                    text: String(m.requests),
                    width: 7,
                    color: theme.text.primary,
                  },
                  {
                    text: `${fmtTokens(m.inputTokens)}/${fmtTokens(m.outputTokens)}`,
                    width: 14,
                    color: theme.text.primary,
                  },
                  {
                    text: fmtTokens(m.thoughtsTokens),
                    width: 9,
                    color: theme.text.secondary,
                  },
                  {
                    text: `${cacheRate.toFixed(0)}%`,
                    width: 7,
                    color: getCacheColor(cacheRate),
                  },
                  { text: latency, width: 8, color: theme.text.accent },
                ]}
              />
            );
          })}
        </Box>
      )}

      {/* Code Impact */}
      {(data.report.files.linesAdded > 0 ||
        data.report.files.linesRemoved > 0) && (
        <Box>
          <Text bold color={theme.text.primary}>
            {t('Code Impact')}{' '}
          </Text>
          <Text color={theme.status.success}>
            +{data.report.files.linesAdded.toLocaleString()}
          </Text>
          <Text color={theme.text.primary}> / </Text>
          <Text color={theme.status.error}>
            -{data.report.files.linesRemoved.toLocaleString()}
          </Text>
          <Text color={theme.text.secondary}> {t('net')}: </Text>
          <Text
            color={
              data.report.files.linesAdded - data.report.files.linesRemoved >= 0
                ? theme.status.success
                : theme.status.error
            }
          >
            {data.report.files.linesAdded - data.report.files.linesRemoved >= 0
              ? '+'
              : ''}
            {(
              data.report.files.linesAdded - data.report.files.linesRemoved
            ).toLocaleString()}
          </Text>
        </Box>
      )}
    </Box>
  );
};
