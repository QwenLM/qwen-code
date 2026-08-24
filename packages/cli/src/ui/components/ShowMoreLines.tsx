/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { useOverflowState } from '../contexts/OverflowContext.js';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';
import { theme } from '../semantic-colors.js';

interface ShowMoreLinesProps {
  constrainHeight: boolean;
}

/**
 * Whether <ShowMoreLines> will render its one-row hint right now. Exported
 * so a fixed-height container that lays it out as a sibling (VP mode's
 * viewport, which cannot scroll to reveal a row it did not budget for) can
 * reserve that row instead of discovering it only after paint.
 */
export const useShowMoreLinesVisible = (constrainHeight: boolean): boolean => {
  const overflowState = useOverflowState();
  const streamingState = useStreamingContext();

  return (
    overflowState !== undefined &&
    overflowState.overflowingIds.size > 0 &&
    constrainHeight &&
    (streamingState === StreamingState.Idle ||
      streamingState === StreamingState.WaitingForConfirmation)
  );
};

export const ShowMoreLines = ({ constrainHeight }: ShowMoreLinesProps) => {
  const visible = useShowMoreLinesVisible(constrainHeight);

  if (!visible) {
    return null;
  }

  return (
    <Box>
      <Text color={theme.text.secondary} wrap="truncate">
        Press ctrl-s to show more lines
      </Text>
    </Box>
  );
};
