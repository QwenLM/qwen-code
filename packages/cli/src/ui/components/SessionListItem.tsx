/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type { SessionListItem as SessionData } from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';
import { formatRelativeTime } from '../utils/formatters.js';
import {
  truncateText,
  formatMessageCount,
} from '../utils/sessionPickerUtils.js';

export interface SessionListItemViewProps {
  session: SessionData;
  isSelected: boolean;
  isFirst: boolean;
  isLast: boolean;
  showScrollUp: boolean;
  showScrollDown: boolean;
  maxPromptWidth: number;
  /**
   * Prefix characters for selection indicator and scroll hints.
   * Dialog style uses '> ', '^ ', 'v ' (ASCII).
   * Standalone style uses special Unicode characters.
   */
  prefixChars?: {
    selected: string;
    scrollUp: string;
    scrollDown: string;
    normal: string;
  };
  /**
   * Whether to bold the prefix when selected.
   */
  boldSelectedPrefix?: boolean;
}

const DEFAULT_PREFIX_CHARS = {
  selected: '> ',
  scrollUp: '^ ',
  scrollDown: 'v ',
  normal: '  ',
};

export function SessionListItemView({
  session,
  isSelected,
  isFirst,
  isLast,
  showScrollUp,
  showScrollDown,
  maxPromptWidth,
  prefixChars = DEFAULT_PREFIX_CHARS,
  boldSelectedPrefix = true,
}: SessionListItemViewProps): React.JSX.Element {
  const timeAgo = formatRelativeTime(session.mtime);
  const messageText = formatMessageCount(session.messageCount);

  const showUpIndicator = isFirst && showScrollUp;
  const showDownIndicator = isLast && showScrollDown;

  const prefix = isSelected
    ? prefixChars.selected
    : showUpIndicator
      ? prefixChars.scrollUp
      : showDownIndicator
        ? prefixChars.scrollDown
        : prefixChars.normal;

  const promptText = session.prompt || '(empty prompt)';
  const truncatedPrompt = truncateText(promptText, maxPromptWidth);

  return (
    <Box flexDirection="column" marginBottom={isLast ? 0 : 1}>
      {/* First line: prefix + prompt text */}
      <Box>
        <Text
          color={
            isSelected
              ? theme.text.accent
              : showUpIndicator || showDownIndicator
                ? theme.text.secondary
                : undefined
          }
          bold={isSelected && boldSelectedPrefix}
        >
          {prefix}
        </Text>
        <Text
          color={isSelected ? theme.text.accent : theme.text.primary}
          bold={isSelected}
        >
          {truncatedPrompt}
        </Text>
      </Box>
      {/* Second line: metadata */}
      <Box paddingLeft={2}>
        <Text color={theme.text.secondary}>
          {timeAgo} · {messageText}
          {session.gitBranch && ` · ${session.gitBranch}`}
        </Text>
      </Box>
    </Box>
  );
}
