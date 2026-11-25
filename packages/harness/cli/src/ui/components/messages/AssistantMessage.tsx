/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text } from 'ink';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { theme } from '../../semantic-colors.js';
import { SCREEN_READER_MODEL_PREFIX } from '../../textConstants.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { PrefixedMessage } from './PrefixedMessage.js';
import { INDENT } from '../../constants/messageLayout.js';
import { FEED_MARKER } from '../../constants/feedGrammar.js';

interface AssistantMessageProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  terminalWidth,
}) => {
  const { renderMarkdown } = useUIState();
  const prefix = FEED_MARKER.assistant;
  const prefixWidth = INDENT.PREFIX_WIDTH_STANDARD;
  const contentWidth = Math.max(
    terminalWidth - prefixWidth - INDENT.FEED_LEFT_OFFSET,
    0,
  );

  // Don't render anything until there's actual text content
  if (!text) {
    return null;
  }

  const prefixNode = (
    <Text color={theme.text.primary} aria-label={SCREEN_READER_MODEL_PREFIX}>
      {prefix}
    </Text>
  );

  return (
    <PrefixedMessage prefix={prefixNode} prefixWidth={prefixWidth}>
      <MarkdownDisplay
        text={text}
        isPending={isPending}
        availableTerminalHeight={
          availableTerminalHeight === undefined
            ? undefined
            : Math.max(availableTerminalHeight - 1, 1)
        }
        terminalWidth={contentWidth}
        renderMarkdown={renderMarkdown}
      />
    </PrefixedMessage>
  );
};
