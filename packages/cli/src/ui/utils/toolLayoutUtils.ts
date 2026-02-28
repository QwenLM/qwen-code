/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolCallStatus } from '../types.js';

export const ACTIVE_SHELL_MAX_LINES = 50;
export const COMPLETED_SHELL_MAX_LINES = 15;

export const TOOL_RESULT_STATIC_HEIGHT = 1;
export const TOOL_RESULT_ASB_RESERVED_LINE_COUNT = 6;
export const TOOL_RESULT_STANDARD_RESERVED_LINE_COUNT = 2;
export const TOOL_RESULT_MIN_LINES_SHOWN = 2;

export function calculateToolContentMaxLines(options: {
  availableTerminalHeight: number | undefined;
  isAlternateBuffer: boolean;
  maxLinesLimit?: number;
}): number | undefined {
  const { availableTerminalHeight, isAlternateBuffer, maxLinesLimit } = options;

  const reservedLines = isAlternateBuffer
    ? TOOL_RESULT_ASB_RESERVED_LINE_COUNT
    : TOOL_RESULT_STANDARD_RESERVED_LINE_COUNT;

  let contentHeight = availableTerminalHeight
    ? Math.max(
        availableTerminalHeight - TOOL_RESULT_STATIC_HEIGHT - reservedLines,
        TOOL_RESULT_MIN_LINES_SHOWN + 1,
      )
    : undefined;

  if (maxLinesLimit) {
    contentHeight =
      contentHeight !== undefined
        ? Math.min(contentHeight, maxLinesLimit)
        : maxLinesLimit;
  }

  return contentHeight;
}

export function calculateShellMaxLines(options: {
  status: ToolCallStatus;
  isAlternateBuffer: boolean;
  isThisShellFocused: boolean;
  availableTerminalHeight: number | undefined;
  constrainHeight: boolean;
  isExpandable: boolean | undefined;
}): number | undefined {
  const {
    status,
    isAlternateBuffer,
    isThisShellFocused,
    availableTerminalHeight,
    constrainHeight,
    isExpandable,
  } = options;

  if (!constrainHeight && isExpandable) {
    return undefined;
  }

  if (availableTerminalHeight === undefined) {
    return isAlternateBuffer ? ACTIVE_SHELL_MAX_LINES : undefined;
  }

  const maxLinesBasedOnHeight = Math.max(1, availableTerminalHeight - 2);

  if (isAlternateBuffer && isThisShellFocused && !constrainHeight) {
    return maxLinesBasedOnHeight;
  }

  const isExecuting = status === ToolCallStatus.Executing;
  const shellMaxLinesLimit = isExecuting
    ? ACTIVE_SHELL_MAX_LINES
    : COMPLETED_SHELL_MAX_LINES;

  return Math.min(maxLinesBasedOnHeight, shellMaxLinesLimit);
}
