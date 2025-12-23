/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import { theme } from '../semantic-colors.js';
import type { ContextBreakdown } from '../types.js';
import { t } from '../../i18n/index.js';

interface StatRowProps {
  title: string;
  children: React.ReactNode;
}

const StatRow: React.FC<StatRowProps> = ({ title, children }) => (
  <Box>
    <Box width={30}>
      <Text color={theme.text.link}>{title}</Text>
    </Box>
    <Box flexGrow={1}>{children}</Box>
  </Box>
);

interface SubStatRowProps {
  title: string;
  children: React.ReactNode;
}

const SubStatRow: React.FC<SubStatRowProps> = ({ title, children }) => (
  <Box paddingLeft={2}>
    <Box width={28}>
      <Text color={theme.text.secondary}>» {title}</Text>
    </Box>
    <Box flexGrow={1}>{children}</Box>
  </Box>
);

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ title, children }) => (
  <Box flexDirection="column" width="100%" marginBottom={1}>
    <Text bold color={theme.text.primary}>
      {title}
    </Text>
    {children}
  </Box>
);

interface ProgressBarProps {
  percentage: number;
  width?: number;
}

const ProgressBar: React.FC<ProgressBarProps> = ({
  percentage,
  width = 40,
}) => {
  const filledWidth = Math.round((percentage / 100) * width);
  const emptyWidth = width - filledWidth;

  const filled = '█'.repeat(Math.max(0, filledWidth));
  const empty = '░'.repeat(Math.max(0, emptyWidth));

  // 根据使用百分比选择颜色
  let color = theme.status.success;
  if (percentage >= 90) {
    color = theme.status.error;
  } else if (percentage >= 80) {
    color = theme.status.warning;
  }

  return (
    <Box>
      <Text color={color}>
        {filled}
        {empty}
      </Text>
      <Box marginLeft={1}>
        <Text color={color}>{percentage.toFixed(1)}%</Text>
      </Box>
    </Box>
  );
};

interface BreakdownTableProps {
  breakdown: ContextBreakdown;
}

const BreakdownTable: React.FC<BreakdownTableProps> = ({ breakdown }) => {
  const typeWidth = 25;
  const tokensWidth = 15;
  const percentWidth = 10;

  const calculatePercent = (tokens: number) =>
    breakdown.total > 0 ? (tokens / breakdown.total) * 100 : 0;

  const items = [
    {
      label: t('User Messages'),
      tokens: breakdown.userMessages,
      percent: calculatePercent(breakdown.userMessages),
    },
    {
      label: t('Assistant Responses'),
      tokens: breakdown.assistantResponses,
      percent: calculatePercent(breakdown.assistantResponses),
    },
    {
      label: t('Tool Calls'),
      tokens: breakdown.toolCalls,
      percent: calculatePercent(breakdown.toolCalls),
    },
    {
      label: t('Tool Responses'),
      tokens: breakdown.toolResponses,
      percent: calculatePercent(breakdown.toolResponses),
    },
    {
      label: t('System Instructions'),
      tokens: breakdown.systemInstructions,
      percent: calculatePercent(breakdown.systemInstructions),
    },
  ];

  // 添加可选的思考和缓存token(如果有的话)
  if (breakdown.thoughts > 0) {
    items.push({
      label: t('Thoughts'),
      tokens: breakdown.thoughts,
      percent: calculatePercent(breakdown.thoughts),
    });
  }

  if (breakdown.cached > 0) {
    items.push({
      label: t('Cached'),
      tokens: breakdown.cached,
      percent: calculatePercent(breakdown.cached),
    });
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header */}
      <Box>
        <Box width={typeWidth}>
          <Text bold color={theme.text.primary}>
            {t('Content Type')}
          </Text>
        </Box>
        <Box width={tokensWidth} justifyContent="flex-end">
          <Text bold color={theme.text.primary}>
            {t('Tokens')}
          </Text>
        </Box>
        <Box width={percentWidth} justifyContent="flex-end">
          <Text bold color={theme.text.primary}>
            {t('Percent')}
          </Text>
        </Box>
      </Box>

      {/* Divider */}
      <Box
        borderStyle="round"
        borderBottom={true}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.border.default}
        width={typeWidth + tokensWidth + percentWidth}
      ></Box>

      {/* Rows */}
      {items.map((item) => (
        <Box key={item.label}>
          <Box width={typeWidth}>
            <Text color={theme.text.primary}>{item.label}</Text>
          </Box>
          <Box width={tokensWidth} justifyContent="flex-end">
            <Text color={theme.status.warning}>
              {item.tokens.toLocaleString()}
            </Text>
          </Box>
          <Box width={percentWidth} justifyContent="flex-end">
            <Text color={theme.text.secondary}>{item.percent.toFixed(1)}%</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
};

interface ContextDisplayProps {
  totalTokens: number;
  breakdown: ContextBreakdown;
  sessionLimit: number;
  usagePercentage: number;
  remainingTokens: number;
  estimatedExchanges: number;
}

export const ContextDisplay: React.FC<ContextDisplayProps> = ({
  totalTokens,
  breakdown,
  sessionLimit,
  usagePercentage,
  remainingTokens,
  estimatedExchanges,
}) => {
  const renderTitle = () => theme.ui.gradient && theme.ui.gradient.length > 0 ? (
      <Gradient colors={theme.ui.gradient}>
        <Text bold color={theme.text.primary}>
          {t('Context Usage')}
        </Text>
      </Gradient>
    ) : (
      <Text bold color={theme.text.accent}>
        {t('Context Usage')}
      </Text>
    );

  const renderWarning = () => {
    if (usagePercentage < 80) {
      return null;
    }

    const warningColor =
      usagePercentage >= 90 ? theme.status.error : theme.status.warning;
    const warningIcon = usagePercentage >= 90 ? '⚠️ ' : '⚠ ';

    let warningMessage = '';
    let suggestions = '';

    if (usagePercentage >= 90) {
      warningMessage = t(
        'Context is critically high! Consider taking action soon.',
      );
      suggestions = t(
        'Suggestions: Use /compress to reduce context, or /clear to start fresh.',
      );
    } else {
      warningMessage = t('Context usage is approaching the limit.');
      suggestions = t(
        'Suggestions: Consider using /compress if conversation gets too long.',
      );
    }

    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Text color={warningColor}>
          {warningIcon}
          {warningMessage}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>» {suggestions}</Text>
        </Box>
      </Box>
    );
  };

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingY={1}
      paddingX={2}
    >
      {renderTitle()}
      <Box height={1} />

      <Section title={t('Overview')}>
        <StatRow title={t('Total Context:')}>
          <Text color={theme.text.primary}>
            {totalTokens.toLocaleString()} {t('tokens')}
          </Text>
        </StatRow>
        <StatRow title={t('Session Limit:')}>
          <Text color={theme.text.primary}>
            {sessionLimit.toLocaleString()} {t('tokens')}
          </Text>
        </StatRow>
        <StatRow title={t('Usage:')}>
          <ProgressBar percentage={usagePercentage} />
        </StatRow>
        <StatRow title={t('Remaining:')}>
          <Text color={theme.text.primary}>
            {remainingTokens.toLocaleString()} {t('tokens')}
          </Text>
        </StatRow>
        {estimatedExchanges > 0 && (
          <SubStatRow title={t('Est. Exchanges:')}>
            <Text color={theme.text.secondary}>
              ~{estimatedExchanges} {t('more exchanges')}
            </Text>
          </SubStatRow>
        )}
      </Section>

      {renderWarning()}

      <BreakdownTable breakdown={breakdown} />

      <Box height={1} />
      <Text color={theme.text.secondary}>
        »{' '}
        {t(
          'Tip: Use /stats to see session performance and token usage by model.',
        )}
      </Text>
    </Box>
  );
};
