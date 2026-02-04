/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text, Box } from 'ink';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { theme } from '../../semantic-colors.js';

interface GeminiThoughtMessageProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
}

/**
 * Displays model thinking/reasoning text with a softer, dimmed style
 * to visually distinguish it from regular content output.
 */
export const GeminiThoughtMessage: React.FC<GeminiThoughtMessageProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
}) => {
  const prefix = '✦ ';
  const prefixWidth = prefix.length;

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth}>
        <Text color={theme.text.secondary}>{prefix}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <MarkdownDisplay
          text={text}
          isPending={isPending}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={contentWidth - prefixWidth}
          textColor={theme.text.secondary}
        />
      </Box>
    </Box>
  );
};
