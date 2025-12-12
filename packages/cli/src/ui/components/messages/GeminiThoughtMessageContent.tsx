/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box } from 'ink';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { theme } from '../../semantic-colors.js';

interface GeminiThoughtMessageContentProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
}

/**
 * Continuation component for thought messages, similar to GeminiMessageContent.
 * Used when a thought response gets too long and needs to be split for performance.
 */
export const GeminiThoughtMessageContent: React.FC<
  GeminiThoughtMessageContentProps
> = ({ text, isPending, availableTerminalHeight, terminalWidth }) => {
  const originalPrefix = '✦ ';
  const prefixWidth = originalPrefix.length;

  return (
    <Box flexDirection="column" paddingLeft={prefixWidth} marginBottom={1}>
      <MarkdownDisplay
        text={text}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        terminalWidth={terminalWidth}
        textColor={theme.text.secondary}
      />
    </Box>
  );
};
