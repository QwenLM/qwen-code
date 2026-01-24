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
  contentWidth: number;
}

/**
 * Continuation component for thought messages, similar to GeminiMessageContent.
 * Used when a thought response gets too long and needs to be split for performance.
 */
export const GeminiThoughtMessageContent: React.FC<
  GeminiThoughtMessageContentProps
> = ({ text, isPending, availableTerminalHeight, contentWidth }) => {
  const originalPrefix = '✦ ';
  const prefixWidth = originalPrefix.length;

  return (
    <Box flexDirection="column" paddingLeft={prefixWidth}>
      <MarkdownDisplay
        text={text}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        contentWidth={contentWidth - prefixWidth}
        textColor={theme.text.secondary}
      />
    </Box>
  );
};
