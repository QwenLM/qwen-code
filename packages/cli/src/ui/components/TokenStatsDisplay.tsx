/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import { theme } from '../semantic-colors.js';
import { formatTokenCount } from '../utils/formatters.js';
import { t } from '../../i18n/index.js';
import type {
  PeriodUsage,
  TokenCounts,
} from '@qwen-code/qwen-code-core';

const LABEL_WIDTH = 22;
const VALUE_WIDTH = 14;

interface TokenStatsDisplayProps {
  width?: number;
  mode: 'daily' | 'monthly' | 'model';
  dailyData?: { date: string; usage: PeriodUsage }[];
  monthlyData?: { month: string; usage: PeriodUsage }[];
  modelData?: Record<string, { tokens: TokenCounts; requestCount: number }>;
}

const SectionTitle: React.FC<{ children: string }> = ({ children }) => (
  <Box marginBottom={1}>
    <Gradient name="cristal">
      <Text bold>{children}</Text>
    </Gradient>
  </Box>
);

const formatTokenCountOrDash = (count: number): string =>
  count > 0 ? formatTokenCount(count) : '-';

const TokenRow: React.FC<{
  label: string;
  tokens: TokenCounts;
  indent?: boolean;
}> = ({ label, tokens, indent = false }) => (
  <Box>
    <Box width={LABEL_WIDTH}>
      <Text color={indent ? theme.text.secondary : theme.text.link}>
        {indent ? `  ${label}` : label}
      </Text>
    </Box>
    <Box width={VALUE_WIDTH} justifyContent="flex-end">
      <Text color={theme.text.primary}>
        {formatTokenCountOrDash(tokens.prompt)}
      </Text>
    </Box>
    <Box width={VALUE_WIDTH} justifyContent="flex-end">
      <Text color={theme.text.primary}>
        {formatTokenCountOrDash(tokens.candidates)}
      </Text>
    </Box>
    <Box width={VALUE_WIDTH} justifyContent="flex-end">
      <Text color={theme.text.primary}>
        {formatTokenCountOrDash(tokens.total)}
      </Text>
    </Box>
  </Box>
);

const TableHeader: React.FC = () => (
  <Box marginBottom={1}>
    <Box width={LABEL_WIDTH}>
      <Text bold color={theme.text.secondary}>
        {' '}
      </Text>
    </Box>
    <Box width={VALUE_WIDTH} justifyContent="flex-end">
      <Text bold color={theme.text.secondary}>
        Input
      </Text>
    </Box>
    <Box width={VALUE_WIDTH} justifyContent="flex-end">
      <Text bold color={theme.text.secondary}>
        Output
      </Text>
    </Box>
    <Box width={VALUE_WIDTH} justifyContent="flex-end">
      <Text bold color={theme.text.secondary}>
        Total
      </Text>
    </Box>
  </Box>
);

const DailyView: React.FC<{
  data: { date: string; usage: PeriodUsage }[];
}> = ({ data }) => {
  if (data.length === 0) {
    return (
      <Text color={theme.text.secondary}>
        {t('No usage data found.')}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <SectionTitle>
        {t('Daily Token Usage (Last 7 Days)')}
      </SectionTitle>
      <TableHeader />
      {data.map(({ date, usage }) => (
        <Box key={date} flexDirection="column" marginBottom={1}>
          <TokenRow label={date} tokens={usage.total} />
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.secondary}>
                {' '}
                {usage.sessionCount} {t('sessions')},{' '}
                {usage.requestCount} {t('requests')}
              </Text>
            </Box>
          </Box>
        </Box>
      ))}
    </Box>
  );
};

const MonthlyView: React.FC<{
  data: { month: string; usage: PeriodUsage }[];
}> = ({ data }) => {
  if (data.length === 0) {
    return (
      <Text color={theme.text.secondary}>
        {t('No usage data found.')}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <SectionTitle>
        {t('Monthly Token Usage (Last 6 Months)')}
      </SectionTitle>
      <TableHeader />
      {data.map(({ month, usage }) => (
        <Box key={month} flexDirection="column" marginBottom={1}>
          <TokenRow label={month} tokens={usage.total} />
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.secondary}>
                {' '}
                {usage.sessionCount} {t('sessions')},{' '}
                {usage.requestCount} {t('requests')}
              </Text>
            </Box>
          </Box>
        </Box>
      ))}
    </Box>
  );
};

const ModelView: React.FC<{
  data: Record<
    string,
    { tokens: TokenCounts; requestCount: number }
  >;
}> = ({ data }) => {
  const entries = Object.entries(data).sort(
    ([, a], [, b]) => b.tokens.total - a.tokens.total,
  );

  if (entries.length === 0) {
    return (
      <Text color={theme.text.secondary}>
        {t('No model usage data found.')}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <SectionTitle>
        {t('Token Usage by Model (Last 3 Months)')}
      </SectionTitle>
      <TableHeader />
      {entries.map(([model, entry]) => (
        <Box key={model} flexDirection="column" marginBottom={1}>
          <TokenRow label={model} tokens={entry.tokens} />
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.secondary}>
                {' '}
                {entry.requestCount} {t('requests')}
              </Text>
            </Box>
          </Box>
        </Box>
      ))}
    </Box>
  );
};

export const TokenStatsDisplay: React.FC<TokenStatsDisplayProps> = ({
  width,
  mode,
  dailyData,
  monthlyData,
  modelData,
}) => {
  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      paddingY={1}
      paddingX={2}
      width={width}
      flexDirection="column"
    >
      {mode === 'daily' && dailyData && <DailyView data={dailyData} />}
      {mode === 'monthly' && monthlyData && (
        <MonthlyView data={monthlyData} />
      )}
      {mode === 'model' && modelData && <ModelView data={modelData} />}
    </Box>
  );
};
