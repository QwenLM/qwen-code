/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text, Box } from 'ink';
import { theme } from '../../semantic-colors.js';

interface ErrorMessageProps {
  text: string;
  /** Optional inline hint displayed after the error text in secondary/dimmed color */
  hint?: string;
}

/**
 * Renders an error message with a "✕" prefix.
 * When a hint is provided (e.g., retry countdown), it is displayed inline
 * in parentheses with a dimmed secondary color, similar to the ESC hint
 * style used in LoadingIndicator.
 */
export const ErrorMessage: React.FC<ErrorMessageProps> = ({ text, hint }) => {
  const prefix = '✕ ';
  const prefixWidth = prefix.length;

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth}>
        <Text color={theme.status.error}>{prefix}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap" color={theme.status.error}>
          {text}
        </Text>
        {hint && (
          <Text wrap="wrap" color={theme.text.secondary}>
            {' '}
            ({hint})
          </Text>
        )}
      </Box>
    </Box>
  );
};
