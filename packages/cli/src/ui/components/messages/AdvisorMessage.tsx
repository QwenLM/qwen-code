/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../colors.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';

export interface AdvisorDisplayProps {
  /** The reviewer's markdown review. */
  text: string;
  /** Resolved model id that produced the review; shown in the header. */
  model: string;
  /** Width of the parent container. Falls back to terminal width. */
  containerWidth?: number;
  /** Height budget while rendered in the live tool-call region. */
  availableTerminalHeight?: number;
  /** Whether the message is still part of the live tool-call region. */
  isPending?: boolean;
}

// border(1)*2 + paddingX(1)*2 = 4
const ADVISOR_SELF_CHROME = 4;
// border(1)*2 + header(1) + body margin(1) = 4
const ADVISOR_VERTICAL_CHROME = 4;

const AdvisorMessageInternal: React.FC<AdvisorDisplayProps> = ({
  text,
  model,
  containerWidth,
  availableTerminalHeight,
  isPending = false,
}) => {
  const { columns: terminalWidth } = useTerminalSize();
  const baseWidth = containerWidth ?? terminalWidth;
  const contentWidth = Math.max(2, baseWidth - ADVISOR_SELF_CHROME);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={Colors.AccentCyan}
      paddingX={1}
      width="100%"
    >
      <Box flexDirection="row">
        <Text color={Colors.AccentCyan} bold>
          {'/advisor'}
        </Text>
        <Text color={Colors.AccentCyan}>{` · ${model}`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <MarkdownDisplay
          text={text}
          isPending={false}
          enforceHeightBudget={isPending}
          availableTerminalHeight={
            availableTerminalHeight === undefined
              ? undefined
              : Math.max(1, availableTerminalHeight - ADVISOR_VERTICAL_CHROME)
          }
          contentWidth={contentWidth}
        />
      </Box>
    </Box>
  );
};

export const AdvisorMessage = React.memo(AdvisorMessageInternal);
