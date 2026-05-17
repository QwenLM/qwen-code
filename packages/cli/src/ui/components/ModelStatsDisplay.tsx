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
import { useSettings } from '../contexts/SettingsContext.js';
import { calculateCost } from '../../utils/costCalculator.js';

const METRIC_COL_WIDTH = 28;
// 28 + 2*24 = 76, fitting the 76-column panel at 80-column terminal width
// when the session has a single (model, source) pair split into two columns.
// Sessions with three or more sources will exceed the panel — acceptable per
// the design doc, which accepts the crowded layout for many-subagent cases.
const MODEL_COL_WIDTH = 24;
// Keep this in sync with the surrounding Box borderStyle and paddingX:
// Ink's round border consumes 2 border columns plus 2 columns of horizontal
// padding on each side.
const PANEL_HORIZONTAL_CHROME_WIDTH = 6;

interface StatRowProps {
  title: string;
  values: Array<string | React.ReactElement>;
  modelColWidth: number;
  isSubtle?: boolean;
  isSection?: boolean;
}

const StatRow: React.FC<StatRowProps> = ({
  title,
  values,
  modelColWidth,
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
      <Box width={modelColWidth} key={index}>
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
  const settings = useSettings();
  const modelPricing = settings.merged.modelPricing;

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

  const getModelValues = (
    getter: (metrics: ModelMetricsCore) => string | React.ReactElement,
  ) => entries.map(({ metrics }) => getter(metrics));

  const hasThoughts = entries.some(
    ({ metrics }) => metrics.tokens.thoughts > 0,
  );
  const hasCached = entries.some(({ metrics }) => metrics.tokens.cached > 0);
  const modelColWidth =
    entries.length === 1 && width
      ? Math.max(
          MODEL_COL_WIDTH,
          width - PANEL_HORIZONTAL_CHROME_WIDTH - METRIC_COL_WIDTH,
        )
      : MODEL_COL_WIDTH;

  const getModelName = (key: string): string => key.split('::')[0];

  const hasPricing = entries.some(
    ({ key, metrics }) =>
      calculateCost({
        inputTokens: metrics.tokens.prompt,
        outputTokens: metrics.tokens.candidates + metrics.tokens.thoughts,
        pricing: modelPricing?.[getModelName(key)],
      }) != null,
  );

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
        {entries.map(({ key, label }) => (
          <Box width={modelColWidth} key={key}>
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
      <StatRow
        title={t('API')}
        values={[]}
        modelColWidth={modelColWidth}
        isSection
      />
      <StatRow
        title={t('Requests')}
        values={getModelValues((m) => m.api.totalRequests.toLocaleString())}
        modelColWidth={modelColWidth}
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
        modelColWidth={modelColWidth}
      />
      <StatRow
        title={t('Avg Latency')}
        values={getModelValues((m) => {
          const avgLatency = calculateAverageLatency(m);
          return formatDuration(avgLatency);
        })}
        modelColWidth={modelColWidth}
      />

      <Box height={1} />

      {/* Tokens Section */}
      <StatRow
        title={t('Tokens')}
        values={[]}
        modelColWidth={modelColWidth}
        isSection
      />
      <StatRow
        title={t('Total')}
        values={getModelValues((m) => (
          <Text color={theme.status.warning}>
            {m.tokens.total.toLocaleString()}
          </Text>
        ))}
        modelColWidth={modelColWidth}
      />
      <StatRow
        title={t('Prompt')}
        isSubtle
        values={getModelValues((m) => m.tokens.prompt.toLocaleString())}
        modelColWidth={modelColWidth}
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
          modelColWidth={modelColWidth}
        />
      )}
      {hasThoughts && (
        <StatRow
          title={t('Thoughts')}
          isSubtle
          values={getModelValues((m) => m.tokens.thoughts.toLocaleString())}
          modelColWidth={modelColWidth}
        />
      )}
      <StatRow
        title={t('Output')}
        isSubtle
        values={getModelValues((m) => m.tokens.candidates.toLocaleString())}
        modelColWidth={modelColWidth}
      />
      {hasPricing && (
        <>
          <Box height={1} />
          <StatRow
            title={t('Cost')}
            values={[]}
            modelColWidth={modelColWidth}
            isSection
          />
          <StatRow
            title={t('Estimated')}
            values={entries.map(({ key, metrics }) => {
              const cost = calculateCost({
                inputTokens: metrics.tokens.prompt,
                outputTokens:
                  metrics.tokens.candidates + metrics.tokens.thoughts,
                pricing: modelPricing?.[getModelName(key)],
              });
              return cost != null ? `$${cost.toFixed(4)}` : 'N/A';
            })}
            modelColWidth={modelColWidth}
          />
        </>
      )}
    </Box>
  );
};
