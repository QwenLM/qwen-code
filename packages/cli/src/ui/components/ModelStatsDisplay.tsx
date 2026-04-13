/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { formatDuration } from '../utils/formatters.js';
import {
  calculateAverageLatency,
  calculateCacheHitRate,
  calculateErrorRate,
} from '../utils/computeStats.js';
import type { ModelMetricsCore } from '../contexts/SessionContext.js';
import { useSessionStats } from '../contexts/SessionContext.js';
import { flattenModelsBySource } from '../utils/modelsBySource.js';
import { t } from '../../i18n/index.js';

const METRIC_COL_WIDTH = 28;
// 28 + 2*24 = 76, fitting the 76-column panel at 80-column terminal width
// when the session has a single (model, source) pair split into two columns.
// Sessions with three or more sources will exceed the panel — acceptable per
// the design doc, which accepts the crowded layout for many-subagent cases.
const MODEL_COL_WIDTH = 24;

interface StatRowProps {
  title: string;
  values: Array<string | React.ReactElement>;
  isSubtle?: boolean;
  isSection?: boolean;
}

const StatRow: React.FC<StatRowProps> = ({
  title,
  values,
  isSubtle = false,
  isSection = false,
}) => (
  <Box>
    <Box width={METRIC_COL_WIDTH}>
      <Text
        bold={isSection}
        color={isSection ? theme.text.primary : theme.text.link}
      >
        {isSubtle ? `  ↳ ${title}` : title}
      </Text>
    </Box>
    {values.map((value, index) => (
      <Box width={MODEL_COL_WIDTH} key={index}>
        <Text color={theme.text.primary}>{value}</Text>
      </Box>
    ))}
  </Box>
);

interface ModelStatsDisplayProps {
  width?: number;
}

export const ModelStatsDisplay: React.FC<ModelStatsDisplayProps> = ({
  width,
}) => {
  const { stats } = useSessionStats();
  const { models } = stats.metrics;
  const entries = flattenModelsBySource(models);

  if (entries.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        paddingY={1}
        paddingX={2}
        width={width}
      >
        <Text color={theme.text.primary}>
          {t('No API calls have been made in this session.')}
        </Text>
      </Box>
    );
  }

  const columnLabels = entries.map(({ label }) => label);

  const getModelValues = (
    getter: (metrics: ModelMetricsCore) => string | React.ReactElement,
  ) => entries.map(({ metrics }) => getter(metrics));

  const hasThoughts = entries.some(
    ({ metrics }) => metrics.tokens.thoughts > 0,
  );
  const hasTool = entries.some(({ metrics }) => metrics.tokens.tool > 0);
  const hasCached = entries.some(({ metrics }) => metrics.tokens.cached > 0);

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingY={1}
      paddingX={2}
      width={width}
    >
      <Text bold color={theme.text.accent}>
        {t('Model Stats For Nerds')}
      </Text>
      <Box height={1} />

      {/* Header */}
      <Box>
        <Box width={METRIC_COL_WIDTH}>
          <Text bold color={theme.text.primary}>
            {t('Metric')}
          </Text>
        </Box>
        {columnLabels.map((label) => (
          <Box width={MODEL_COL_WIDTH} key={label}>
            <Text bold color={theme.text.primary}>
              {label}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Divider */}
      <Box
        borderStyle="single"
        borderBottom={true}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.border.default}
      />

      {/* API Section */}
      <StatRow title={t('API')} values={[]} isSection />
      <StatRow
        title={t('Requests')}
        values={getModelValues((m) => m.api.totalRequests.toLocaleString())}
      />
      <StatRow
        title={t('Errors')}
        values={getModelValues((m) => {
          const errorRate = calculateErrorRate(m);
          return (
            <Text
              color={
                m.api.totalErrors > 0 ? theme.status.error : theme.text.primary
              }
            >
              {m.api.totalErrors.toLocaleString()} ({errorRate.toFixed(1)}%)
            </Text>
          );
        })}
      />
      <StatRow
        title={t('Avg Latency')}
        values={getModelValues((m) => {
          const avgLatency = calculateAverageLatency(m);
          return formatDuration(avgLatency);
        })}
      />

      <Box height={1} />

      {/* Tokens Section */}
      <StatRow title={t('Tokens')} values={[]} isSection />
      <StatRow
        title={t('Total')}
        values={getModelValues((m) => (
          <Text color={theme.status.warning}>
            {m.tokens.total.toLocaleString()}
          </Text>
        ))}
      />
      <StatRow
        title={t('Prompt')}
        isSubtle
        values={getModelValues((m) => m.tokens.prompt.toLocaleString())}
      />
      {hasCached && (
        <StatRow
          title={t('Cached')}
          isSubtle
          values={getModelValues((m) => {
            const cacheHitRate = calculateCacheHitRate(m);
            return (
              <Text color={theme.status.success}>
                {m.tokens.cached.toLocaleString()} ({cacheHitRate.toFixed(1)}%)
              </Text>
            );
          })}
        />
      )}
      {hasThoughts && (
        <StatRow
          title={t('Thoughts')}
          isSubtle
          values={getModelValues((m) => m.tokens.thoughts.toLocaleString())}
        />
      )}
      {hasTool && (
        <StatRow
          title={t('Tool')}
          isSubtle
          values={getModelValues((m) => m.tokens.tool.toLocaleString())}
        />
      )}
      <StatRow
        title={t('Output')}
        isSubtle
        values={getModelValues((m) => m.tokens.candidates.toLocaleString())}
      />
    </Box>
  );
};
