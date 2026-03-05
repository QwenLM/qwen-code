/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text, Box } from 'ink';
import { theme } from '../../semantic-colors.js';

interface RetryCountdownMessageProps {
  text: string;
}

/**
 * Displays a retry countdown message in a dimmed/secondary style
 * to visually distinguish it from error messages.
 */
export const RetryCountdownMessage: React.FC<RetryCountdownMessageProps> = ({
  text,
}) => {
  if (!text || text.trim() === '') {
    return null;
  }

  const prefix = '↻ ';
  const prefixWidth = prefix.length;

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth}>
        <Text color={theme.text.secondary}>{prefix}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap" color={theme.text.secondary}>
          {text}
        </Text>
      </Box>
    </Box>
  );
};
