/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ACTIVE_SHELL_MAX_LINES,
  COMPLETED_SHELL_MAX_LINES,
} from '../constants.js';
import { CoreToolCallStatus } from '@qwen-code/core';

/**
 * Constants used for calculating available height for tool results.
 * These MUST be kept in sync between ToolGroupMessage (for overflow detection)
 * and ToolResultDisplay (for actual truncation).
 */
export const TOOL_RESULT_STATIC_HEIGHT = 1;
export const TOOL_RESULT_ASB_RESERVED_LINE_COUNT = 6;
export const TOOL_RESULT_STANDARD_RESERVED_LINE_COUNT = 2;
export const TOOL_RESULT_MIN_LINES_SHOWN = 2;

/**
 * Maximum lines of tool output to show in compact/truncated mode.
 * Default: 3 lines.
 * Used when FoldLevel is GroupExpandedToolCollapsed.
 */
export const TOOL_OUTPUT_COMPACT_MAX_LINES = 3;

/**
 * The vertical space (in lines) consumed by the shell UI elements
 * (1 line for the shell title/header and 2 lines for the top and bottom borders).
 */
export const SHELL_CONTENT_OVERHEAD =
  TOOL_RESULT_STATIC_HEIGHT + TOOL_RESULT_STANDARD_RESERVED_LINE_COUNT;

/**
 * Calculates the final height available for the content of a tool result display.
 *
 * This accounts for:
 * 1. The static height of the tool message (name, status line).
 * 2. Reserved space for hints and padding (different in ASB vs Standard mode).
 * 3. Enforcing a minimum number of lines shown.
 */
export function calculateToolContentMaxLines(options: {
  availableTerminalHeight: number | undefined;
  isAlternateBuffer: boolean;
  maxLinesLimit?: number;
}): number | undefined {
  const { availableTerminalHeight, isAlternateBuffer, maxLinesLimit } = options;

  const reservedLines = isAlternateBuffer
    ? TOOL_RESULT_ASB_RESERVED_LINE_COUNT
    : TOOL_RESULT_STANDARD_RESERVED_LINE_COUNT;

  let contentHeight =
    availableTerminalHeight !== undefined
      ? Math.max(
          availableTerminalHeight - TOOL_RESULT_STATIC_HEIGHT - reservedLines,
          TOOL_RESULT_MIN_LINES_SHOWN + 1,
        )
      : undefined;

  if (maxLinesLimit !== undefined) {
    contentHeight =
      contentHeight !== undefined
        ? Math.min(contentHeight, maxLinesLimit)
        : maxLinesLimit;
  }

  return contentHeight;
}

/**
 * Calculates the maximum number of lines to display for shell output.
 *
 * This logic distinguishes between:
 * 1. Process Status: Active (Executing) vs Completed.
 * 2. Expansion State: Whether the current view is height-constrained.
 */
export function calculateShellMaxLines(options: {
  status: CoreToolCallStatus;
  isAlternateBuffer: boolean;
  availableTerminalHeight: number | undefined;
  constrainHeight: boolean;
  isExpandable: boolean | undefined;
}): number | undefined {
  const {
    status,
    isAlternateBuffer,
    availableTerminalHeight,
    constrainHeight,
  } = options;

  // 1. Unconstrained views render the complete output.
  if (!constrainHeight) {
    return undefined;
  }

  // 2. Handle cases where height is unknown (Standard mode history).
  if (availableTerminalHeight === undefined) {
    return isAlternateBuffer
      ? ACTIVE_SHELL_MAX_LINES - SHELL_CONTENT_OVERHEAD
      : undefined;
  }

  const maxLinesBasedOnHeight = Math.max(
    1,
    availableTerminalHeight - TOOL_RESULT_STANDARD_RESERVED_LINE_COUNT,
  );

  // 3. Fall back to process-based constants.
  const isExecuting = status === CoreToolCallStatus.Executing;
  const shellMaxLinesLimit = isExecuting
    ? ACTIVE_SHELL_MAX_LINES - SHELL_CONTENT_OVERHEAD
    : COMPLETED_SHELL_MAX_LINES - SHELL_CONTENT_OVERHEAD;

  return Math.min(maxLinesBasedOnHeight, shellMaxLinesLimit);
}
