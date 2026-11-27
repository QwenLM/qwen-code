/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { PrefixedMessage } from './PrefixedMessage.js';
import { INDENT } from '../../constants/messageLayout.js';

interface AssistantMessageContentProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
}

/*
 * Assistant message content is a semi-hacked component. The intention is to represent a partial
 * of AssistantMessage and is only used when a response gets too long. In that instance messages
 * are split into multiple AssistantMessageContent's to enable the root <Static> component in
 * App.tsx to be as performant as humanly possible.
 */
export const AssistantMessageContent: React.FC<
  AssistantMessageContentProps
> = ({ text, isPending, availableTerminalHeight, terminalWidth }) => {
  const { renderMarkdown } = useUIState();
  const prefixWidth = INDENT.PREFIX_WIDTH_STANDARD;
  const contentWidth = Math.max(
    terminalWidth - prefixWidth - INDENT.FEED_LEFT_OFFSET,
    0,
  );

  // Don't render anything when there's no text content
  if (!text && !isPending) {
    return null;
  }

  return (
    <PrefixedMessage prefix={' '.repeat(prefixWidth)} prefixWidth={prefixWidth}>
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
