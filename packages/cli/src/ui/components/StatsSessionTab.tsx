/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, type DOMElement } from 'ink';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { ICON } from '../constants.js';
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

interface SessionTabProps {
  /**
   * Rows available for the tab. When set and the content is taller, the tab
   * scrolls with up/down/pageup/pagedown instead of being clipped by the host.
   */
  height?: number;
}

const SessionContent: React.FC = () => {
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
  const generation = metrics.generation;
  const lastGeneration = generation?.last;
  const lastTps =
    lastGeneration && lastGeneration.generationDurationMs > 0
      ? lastGeneration.outputTokens /
        (lastGeneration.generationDurationMs / 1000)
      : undefined;
  const averageTtft =
    generation && generation.timedRequests > 0
      ? generation.totalTtftMs / generation.timedRequests
      : undefined;
  const sessionTps =
    generation && generation.totalGenerationDurationMs > 0
      ? generation.totalThroughputOutputTokens /
        (generation.totalGenerationDurationMs / 1000)
      : undefined;

  const successColor = getStatusColor(computed.successRate, {
    green: TOOL_SUCCESS_RATE_HIGH,
    yellow: TOOL_SUCCESS_RATE_MEDIUM,
  });
  const agreementColor = getStatusColor(computed.agreementRate, {
    green: USER_AGREEMENT_RATE_HIGH,
    yellow: USER_AGREEMENT_RATE_MEDIUM,
  });

  const labelWidth = 28;

  const content = (
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

      {lastGeneration && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.text.primary}>
            {t('Generation Metrics')} ({t('Latest Request')})
          </Text>
          <Box>
            <Box width={labelWidth}>
              <Text color={theme.text.secondary}>{t('Model')}:</Text>
            </Box>
            <Text color={theme.text.primary}>{lastGeneration.model}</Text>
          </Box>
          <Box>
            <Box width={labelWidth}>
              <Text color={theme.text.secondary}>TTFT:</Text>
            </Box>
            <Text color={theme.text.primary}>
              {formatDuration(lastGeneration.ttftMs)}
            </Text>
          </Box>
          <Box>
            <Box width={labelWidth}>
              <Text color={theme.text.secondary}>{t('Generation Time')}:</Text>
            </Box>
            <Text color={theme.text.primary}>
              {formatDuration(lastGeneration.generationDurationMs)}
            </Text>
          </Box>
          <Box>
            <Box width={labelWidth}>
              <Text color={theme.text.secondary}>{t('Output Tokens')}:</Text>
            </Box>
            <Text color={theme.text.primary}>
              {lastGeneration.outputTokens.toLocaleString()}
            </Text>
          </Box>
          <Box>
            <Box width={labelWidth}>
              <Text color={theme.text.secondary}>TPS:</Text>
            </Box>
            <Text color={theme.text.primary}>
              {lastTps === undefined ? '—' : `${lastTps.toFixed(1)} tok/s`}
            </Text>
          </Box>
          <Box paddingLeft={2}>
            <Box width={26}>
              <Text color={theme.text.secondary}>» {t('Requests')}:</Text>
            </Box>
            <Text color={theme.text.primary}>{generation.timedRequests}</Text>
          </Box>
          <Box paddingLeft={2}>
            <Box width={26}>
              <Text color={theme.text.secondary}>» {t('Average TTFT')}:</Text>
            </Box>
            <Text color={theme.text.primary}>
              {averageTtft === undefined ? '—' : formatDuration(averageTtft)}
            </Text>
          </Box>
          <Box paddingLeft={2}>
            <Box width={26}>
              <Text color={theme.text.secondary}>» {t('Session TPS')}:</Text>
            </Box>
            <Text color={theme.text.primary}>
              {sessionTps === undefined
                ? '—'
                : `${sessionTps.toFixed(1)} tok/s`}
            </Text>
          </Box>
        </Box>
      )}

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
              <Text color={SERIES_COLORS[i % SERIES_COLORS.length]}>
                {ICON.CIRCLE_FILLED + ' '}
              </Text>
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

  return content;
};

/**
 * Scrolling wrapper, mounted only when a row budget is passed. The key
 * subscription needs a KeypressProvider, which the unscrolled tab must not.
 */
const ScrollableSessionTab: React.FC<{ height: number }> = ({ height }) => {
  const contentRef = useRef<DOMElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Re-measure after every render: the content height depends on metrics that
  // change independently of `height`. The state update is skipped when equal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!contentRef.current) return;
    const measured = measureElement(contentRef.current).height;
    setContentHeight((prev) => (prev === measured ? prev : measured));
  });

  // One row of the budget is reserved for the scroll hint when it overflows.
  const overflowing = contentHeight > height;
  const viewportHeight = Math.max(1, height - (overflowing ? 1 : 0));
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const offset = Math.min(scrollOffset, maxScroll);

  useKeypress(
    (key) => {
      // Functional updaters so several keys handled before a re-render compose.
      if (key.name === 'up') {
        setScrollOffset((prev) => Math.max(0, Math.min(prev, maxScroll) - 1));
      } else if (key.name === 'down') {
        setScrollOffset((prev) => Math.min(maxScroll, prev + 1));
      } else if (key.name === 'pageup') {
        setScrollOffset((prev) =>
          Math.max(0, Math.min(prev, maxScroll) - viewportHeight),
        );
      } else if (key.name === 'pagedown') {
        setScrollOffset((prev) => Math.min(maxScroll, prev + viewportHeight));
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column">
      <Box height={viewportHeight} overflowY="hidden" flexDirection="column">
        <Box
          ref={contentRef}
          flexShrink={0}
          flexDirection="column"
          marginTop={-offset}
        >
          <SessionContent />
        </Box>
      </Box>
      {overflowing && (
        <Text color={theme.text.secondary}>{t('Use ↑/↓ to scroll')}</Text>
      )}
    </Box>
  );
};

export const SessionTab: React.FC<SessionTabProps> = ({ height }) =>
  height === undefined ? (
    <SessionContent />
  ) : (
    <ScrollableSessionTab height={height} />
  );
