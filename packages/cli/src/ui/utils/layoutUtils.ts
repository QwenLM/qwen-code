/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared layout calculation utilities for the terminal UI.
 */

/**
 * Calculate the widths for the input prompt area based on terminal width.
 *
 * Returns the content width (for the text buffer), the total container width
 * (including border + padding + prefix), the suggestions dropdown width,
 * and the frame overhead constant.
 */
export const calculatePromptWidths = (terminalWidth: number) => {
  const widthFraction = 0.9;
  const FRAME_PADDING_AND_BORDER = 4; // Border (2) + padding (2)
  const PROMPT_PREFIX_WIDTH = 2; // '> ' or '! '
  const MIN_CONTENT_WIDTH = 2;

  const innerContentWidth =
    Math.floor(terminalWidth * widthFraction) -
    FRAME_PADDING_AND_BORDER -
    PROMPT_PREFIX_WIDTH;

  const inputWidth = Math.max(MIN_CONTENT_WIDTH, innerContentWidth);
  const FRAME_OVERHEAD = FRAME_PADDING_AND_BORDER + PROMPT_PREFIX_WIDTH;
  const containerWidth = inputWidth + FRAME_OVERHEAD;
  const suggestionsWidth = Math.max(20, Math.floor(terminalWidth * 1.0));

  return {
    inputWidth,
    containerWidth,
    suggestionsWidth,
    frameOverhead: FRAME_OVERHEAD,
  } as const;
};
