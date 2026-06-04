/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { fmtTokens, getSeriesColors } from './stats-helpers.js';
import { useSessionStats } from '../contexts/SessionContext.js';
import { computeSessionStats } from '../utils/computeStats.js';
import { formatDuration } from '../utils/formatters.js';
import {
  getStatusColor,
  TOOL_SUCCESS_RATE_HIGH,
  TOOL_SUCCESS_RATE_MEDIUM,
  USER_AGREEMENT_RATE_HIGH,
  USER_AGREEMENT_RATE_MEDIUM,
} from '../utils/displayUtils.js';
import { t } from '../../i18n/index.js';

export const SessionTab: React.FC<{ bodyWidth: number }> = () => {
  const SERIES_COLORS = getSeriesColors();
  const { stats } = useSessionStats();
  const { metrics } = stats;
  const computed = computeSessionStats(metrics);
  const now = new Date();
  const wallDuration = stats.sessionStartTime
    ? now.getTime() - stats.sessionStartTime.getTime()
    : 0;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  for (const m of Object.values(metrics.models)) {
    totalInput += m.tokens.prompt;
    totalOutput += m.tokens.candidates;
    totalCached += m.tokens.cached;
  }
  const cacheRate = totalInput > 0 ? (totalCached / totalInput) * 100 : 0;

  const successColor = getStatusColor(computed.successRate, {
    green: TOOL_SUCCESS_RATE_HIGH,
    yellow: TOOL_SUCCESS_RATE_MEDIUM,
  });
  const agreementColor = getStatusColor(computed.agreementRate, {
    green: USER_AGREEMENT_RATE_HIGH,
    yellow: USER_AGREEMENT_RATE_MEDIUM,
  });

  const labelWidth = 28;

  return (
    <Box flexDirection="column">
      {/* Session ID */}
      <Box>
        <Box width={labelWidth}>
          <Text color={theme.text.secondary}>{t('Session ID:')}</Text>
        </Box>
        <Text color={theme.text.primary}>{stats.sessionId}</Text>
      </Box>

      {/* Interaction Summary */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.text.primary}>
          {t('Interaction Summary')}
        </Text>
        <Box>
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{t('Tool Calls:')}</Text>
          </Box>
          <Text color={theme.text.primary}>
            {metrics.tools.totalCalls} ({' '}
            <Text color={theme.status.success}>
              ✓ {metrics.tools.totalSuccess}
            </Text>{' '}
            <Text color={theme.status.error}>✗ {metrics.tools.totalFail}</Text>{' '}
            )
          </Text>
        </Box>
        <Box>
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{t('Success Rate:')}</Text>
          </Box>
          <Text color={successColor}>{computed.successRate.toFixed(1)}%</Text>
        </Box>
        {computed.totalDecisions > 0 && (
          <Box>
            <Box width={labelWidth}>
              <Text color={theme.text.secondary}>{t('User Agreement:')}</Text>
            </Box>
            <Text color={agreementColor}>
              {computed.agreementRate.toFixed(1)}%{' '}
              <Text color={theme.text.secondary}>
                ({computed.totalDecisions} {t('reviewed')})
              </Text>
            </Text>
          </Box>
        )}
        {(metrics.files.totalLinesAdded > 0 ||
          metrics.files.totalLinesRemoved > 0) && (
          <Box>
            <Box width={labelWidth}>
              <Text color={theme.text.secondary}>{t('Code Changes:')}</Text>
            </Box>
            <Text color={theme.status.success}>
              +{metrics.files.totalLinesAdded}
            </Text>
            <Text color={theme.text.primary}> </Text>
            <Text color={theme.status.error}>
              -{metrics.files.totalLinesRemoved}
            </Text>
          </Box>
        )}
      </Box>

      {/* Performance */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.text.primary}>
          {t('Performance')}
        </Text>
        <Box>
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{t('Wall Time:')}</Text>
          </Box>
          <Text color={theme.text.primary}>{formatDuration(wallDuration)}</Text>
        </Box>
        <Box>
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{t('Agent Active:')}</Text>
          </Box>
          <Text color={theme.text.primary}>
            {formatDuration(computed.agentActiveTime)}
          </Text>
        </Box>
        <Box paddingLeft={2}>
          <Box width={26}>
            <Text color={theme.text.secondary}>» {t('API Time:')}</Text>
          </Box>
          <Text color={theme.text.primary}>
            {formatDuration(computed.totalApiTime)}{' '}
            <Text color={theme.text.secondary}>
              ({computed.apiTimePercent.toFixed(1)}%)
            </Text>
          </Text>
        </Box>
        <Box paddingLeft={2}>
          <Box width={26}>
            <Text color={theme.text.secondary}>» {t('Tool Time:')}</Text>
          </Box>
          <Text color={theme.text.primary}>
            {formatDuration(computed.totalToolTime)}{' '}
            <Text color={theme.text.secondary}>
              ({computed.toolTimePercent.toFixed(1)}%)
            </Text>
          </Text>
        </Box>
      </Box>

      {/* Token Summary */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.text.primary}>
          {t('Tokens')}
        </Text>
        <Box>
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{t('Input')}:</Text>
          </Box>
          <Text color={theme.status.warning}>
            {totalInput.toLocaleString()}
          </Text>
        </Box>
        <Box>
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{t('Output')}:</Text>
          </Box>
          <Text color={theme.status.warning}>
            {totalOutput.toLocaleString()}
          </Text>
        </Box>
        {totalCached > 0 && (
          <Box>
            <Box width={labelWidth}>
              <Text color={theme.text.secondary}>{t('Cached')}:</Text>
            </Box>
            <Text color={theme.status.success}>
              {totalCached.toLocaleString()} ({cacheRate.toFixed(1)}%)
            </Text>
          </Box>
        )}
      </Box>

      {/* Models */}
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
    </Box>
  );
};
