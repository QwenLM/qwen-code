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
  fmtDurationShort,
  getSeriesColors,
} from './stats-helpers.js';
import { useSessionStats } from '../contexts/SessionContext.js';
import { t } from '../../i18n/index.js';

export const SessionTab: React.FC<{ bodyWidth: number }> = ({ bodyWidth }) => {
  const SERIES_COLORS = getSeriesColors();
  const { stats } = useSessionStats();
  const { metrics } = stats;
  const now = new Date();
  const wallDuration = stats.sessionStartTime
    ? now.getTime() - stats.sessionStartTime.getTime()
    : 0;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalRequests = 0;
  for (const m of Object.values(metrics.models)) {
    totalInput += m.tokens.prompt;
    totalOutput += m.tokens.candidates;
    totalCached += m.tokens.cached;
    totalRequests += m.api.totalRequests;
  }
  const cacheRate = totalInput > 0 ? (totalCached / totalInput) * 100 : 0;
  const successRate =
    metrics.tools.totalCalls > 0
      ? (metrics.tools.totalSuccess / metrics.tools.totalCalls) * 100
      : 0;

  const col1Width = Math.floor(bodyWidth / 2);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={col1Width} flexDirection="column">
          <Box>
            <Text color={theme.text.secondary}>{t('Duration')}: </Text>
            <Text color={theme.text.primary}>
              {fmtDurationShort(wallDuration)}
            </Text>
          </Box>
          <Box>
            <Text color={theme.text.secondary}>{t('API Requests')}: </Text>
            <Text color={theme.text.primary}>{totalRequests}</Text>
          </Box>
          <Box>
            <Text color={theme.text.secondary}>{t('Tool Calls')}: </Text>
            <Text color={theme.text.primary}>
              {metrics.tools.totalCalls}{' '}
              <Text color={theme.status.success}>
                ✓{metrics.tools.totalSuccess}
              </Text>{' '}
              <Text color={theme.status.error}>✗{metrics.tools.totalFail}</Text>
            </Text>
          </Box>
        </Box>
        <Box flexDirection="column">
          <Box>
            <Text color={theme.text.secondary}>{t('Input')}: </Text>
            <Text color={theme.status.warning}>{fmtTokens(totalInput)}</Text>
          </Box>
          <Box>
            <Text color={theme.text.secondary}>{t('Output')}: </Text>
            <Text color={theme.status.warning}>{fmtTokens(totalOutput)}</Text>
          </Box>
          {totalCached > 0 && (
            <Box>
              <Text color={theme.text.secondary}>{t('Cached')}: </Text>
              <Text color={theme.status.success}>
                {fmtTokens(totalCached)} ({cacheRate.toFixed(1)}%)
              </Text>
            </Box>
          )}
        </Box>
      </Box>

      {Object.keys(metrics.models).length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.text.primary}>
            {t('Models')}
          </Text>
          {Object.entries(metrics.models).map(([name, m], i) => (
            <Box key={name}>
              <Text color={SERIES_COLORS[i % SERIES_COLORS.length]}>● </Text>
              <Text color={theme.text.primary}>{name} </Text>
              <Text color={theme.text.secondary}>
                {m.api.totalRequests} {t('reqs')} · {t('in')}=
                {fmtTokens(m.tokens.prompt)} · {t('out')}=
                {fmtTokens(m.tokens.candidates)}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {metrics.tools.totalCalls > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.text.primary}>
            {t('Tools')}
          </Text>
          <Text color={theme.text.secondary}>
            {t('Success rate')}: {successRate.toFixed(1)}%
          </Text>
        </Box>
      )}

      {(metrics.files.totalLinesAdded > 0 ||
        metrics.files.totalLinesRemoved > 0) && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>{t('Code Changes')}: </Text>
          <Text color={theme.status.success}>
            +{metrics.files.totalLinesAdded}
          </Text>
          <Text color={theme.text.primary}> / </Text>
          <Text color={theme.status.error}>
            -{metrics.files.totalLinesRemoved}
          </Text>
        </Box>
      )}
    </Box>
  );
};
