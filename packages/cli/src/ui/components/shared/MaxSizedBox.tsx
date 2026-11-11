/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useId } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useOverflowActions } from '../../contexts/OverflowContext.js';
import { isNarrowWidth } from '../../utils/isNarrowWidth.js';
import { Command } from '../../key/keyBindings.js';
import { formatCommand } from '../../key/keybindingUtils.js';

/**
 * Minimum height for the MaxSizedBox component.
 * This ensures there is room for at least one line of content as well as the
 * message that content was truncated.
 */
export const MINIMUM_MAX_HEIGHT = 2;

export interface MaxSizedBoxProps {
  children?: React.ReactNode;
  maxWidth?: number;
  maxHeight?: number;
  overflowDirection?: 'top' | 'bottom';
  additionalHiddenLinesCount?: number;
  paddingX?: number;
}

/**
 * A React component that constrains the size of its children using pure Yoga
 * layout (`maxHeight` + `overflow="hidden"`).
 *
 * Hidden-line counts are determined statically from caller-provided
 * `additionalHiddenLinesCount` — no ResizeObserver is used, eliminating
 * the synchronous layout-measurement feedback loop that caused stack overflows.
 */
export const MaxSizedBox: React.FC<MaxSizedBoxProps> = ({
  children,
  maxWidth,
  maxHeight,
  overflowDirection = 'top',
  additionalHiddenLinesCount = 0,
  paddingX = 0,
}) => {
  const id = useId();
  const { addOverflowingId, removeOverflowingId } = useOverflowActions() || {};

  const effectiveMaxHeight =
    maxHeight !== undefined
      ? Math.max(Math.round(maxHeight), MINIMUM_MAX_HEIGHT)
      : undefined;

  const totalHiddenLines = additionalHiddenLinesCount;
  const showIndicator = totalHiddenLines > 0;

  // When the indicator is shown it occupies 1 line, so content gets 1 less.
  const contentMaxHeight =
    showIndicator && effectiveMaxHeight !== undefined
      ? effectiveMaxHeight - 1
      : effectiveMaxHeight;

  const isNarrow = maxWidth !== undefined && isNarrowWidth(maxWidth);
  const showMoreKey = formatCommand(Command.SHOW_MORE_LINES);

  useEffect(() => {
    if (totalHiddenLines > 0) {
      addOverflowingId?.(id);
    } else {
      removeOverflowingId?.(id);
    }
  }, [id, totalHiddenLines, addOverflowingId, removeOverflowingId]);

  useEffect(
    () => () => {
      removeOverflowingId?.(id);
    },
    [id, removeOverflowingId],
  );

  if (effectiveMaxHeight === undefined) {
    return (
      <Box flexDirection="column" width={maxWidth}>
        {children}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={maxWidth}
      maxHeight={effectiveMaxHeight}
      flexShrink={0}
    >
      {showIndicator && overflowDirection === 'top' && (
        <Box paddingX={paddingX}>
          <Text color={theme.text.secondary} wrap="truncate">
            {isNarrow
              ? `... ${totalHiddenLines} hidden (${showMoreKey}) ...`
              : `... first ${totalHiddenLines} line${totalHiddenLines === 1 ? '' : 's'} hidden (${showMoreKey} to show) ...`}
          </Text>
        </Box>
      )}
      <Box
        flexDirection="column"
        overflow="hidden"
        flexGrow={0}
        maxHeight={contentMaxHeight}
      >
        <Box flexDirection="column" flexShrink={0}>
          {children}
        </Box>
      </Box>
      {showIndicator && overflowDirection === 'bottom' && (
        <Box paddingX={paddingX}>
          <Text color={theme.text.secondary} wrap="truncate">
            {isNarrow
              ? `... ${totalHiddenLines} hidden (${showMoreKey}) ...`
              : `... last ${totalHiddenLines} line${totalHiddenLines === 1 ? '' : 's'} hidden (${showMoreKey} to show) ...`}
          </Text>
        </Box>
      )}
    </Box>
  );
};
