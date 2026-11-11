/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { useOverflowState } from '../contexts/OverflowContext.js';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';
import { theme } from '../semantic-colors.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import { useI18nService } from '../i18n/index.js';

interface ShowMoreLinesProps {
  constrainHeight: boolean;
  isOverflowing?: boolean;
}

export const ShowMoreLines = ({
  constrainHeight,
  isOverflowing: isOverflowingProp,
}: ShowMoreLinesProps) => {
  const i18n = useI18nService();
  const overflowState = useOverflowState();
  const streamingState = useStreamingContext();

  const isOverflowing =
    isOverflowingProp ??
    (overflowState !== undefined && overflowState.overflowingIds.size > 0);

  if (
    !isOverflowing ||
    !constrainHeight ||
    !(
      streamingState === StreamingState.Idle ||
      streamingState === StreamingState.WaitingForConfirmation ||
      streamingState === StreamingState.Responding
    )
  ) {
    return null;
  }

  return (
    <Box paddingX={1} marginBottom={1}>
      <Text color={theme.text.accent} wrap="truncate">
        {i18n.get('status.transcript.view', {
          shortcut: SHORTCUT_HINTS.CTRL_O_KEY,
        })}
      </Text>
    </Box>
  );
};
