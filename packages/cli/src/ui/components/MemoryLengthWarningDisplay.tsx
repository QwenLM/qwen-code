/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { MemoryLengthWarning } from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

interface MemoryLengthWarningDisplayProps {
  warning: MemoryLengthWarning;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return String(tokens);
}

export const MemoryLengthWarningDisplay: React.FC<
  MemoryLengthWarningDisplayProps
> = ({ warning }) => {
  const percentageText = `${Math.round(warning.percentUsed * 100)}%`;
  const tokenText = formatTokenCount(warning.estimatedTokens);
  const windowText = formatTokenCount(warning.contextWindowSize);

  return (
    <Box paddingX={2}>
      <Text color={theme.status.warning}>
        {t(
          "⚠ QWEN.md is ~{{tokens}} tokens ({{percent}} of the model's {{window}} context window). Consider trimming for better performance.",
          {
            tokens: tokenText,
            percent: percentageText,
            window: windowText,
          },
        )}
      </Text>
    </Box>
  );
};
