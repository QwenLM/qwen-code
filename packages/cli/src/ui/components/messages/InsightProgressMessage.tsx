/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type { InsightProgressProps } from '../../types.js';
import Spinner from 'ink-spinner';

interface InsightProgressMessageProps {
  progress: InsightProgressProps;
}

export const InsightProgressMessage: React.FC<InsightProgressMessageProps> = ({
  progress,
}) => {
  const { stage, progress: percent, isComplete, error } = progress;
  const width = 30;
  const completedWidth = Math.round((percent / 100) * width);
  const remainingWidth = width - completedWidth;

  const bar =
    '█'.repeat(Math.max(0, completedWidth)) +
    '░'.repeat(Math.max(0, remainingWidth));

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color={theme.status.error}>✕ {stage}</Text>
        <Text color={theme.text.secondary}>{error}</Text>
      </Box>
    );
  }

  if (isComplete) {
    return (
      <Box flexDirection="row">
        <Text color={theme.status.success}>✓ {stage}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" marginBottom={0}>
        <Box marginRight={1}>
          <Spinner type="dots" />
        </Box>
        <Text color={theme.text.accent}>{stage}</Text>
      </Box>
      <Box flexDirection="row" marginLeft={2}>
        <Text color={theme.text.primary}>
          {bar} {Math.round(percent)}%
        </Text>
      </Box>
    </Box>
  );
};
