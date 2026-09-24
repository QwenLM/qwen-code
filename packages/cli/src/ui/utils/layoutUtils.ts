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

export const MAIN_CONTENT_HEIGHT_RESERVATION = 2;

/**
 * The static-chrome rows AppContainer subtracts from the terminal height when
 * it budgets a dialog — the `staticExtraHeight` half of that budget. Exported
 * so the OpenTUI popup region derives the same number rather than carrying a
 * second copy that could drift.
 *
 * Three read sites, only two of them dialogs: ink's dialog manager, the
 * OpenTUI popup region, and AppContainer's `mainContentHeightReservation`.
 * The third is legacy-mode only — VP mode reserves nothing there — but it
 * feeds `availableTerminalHeight`, and through it the shell tool's terminal
 * height and the stream's viewport rows, so raising this constant to give a
 * popup one more row also shortens every embedded shell result by one.
 */
export const STATIC_EXTRA_HEIGHT = 3;

export const clampDialogHeight = (
  height: number | undefined,
): number | undefined =>
  height === undefined ? undefined : Math.max(1, Math.floor(height));

/**
 * Returns the max row budget for dialogs rendered in the input/control area.
 *
 * The row reservation matches AppContainer's main-content height
 * reservation. Keeping the same buffer here prevents a newly opened dialog from
 * painting into the terminal's bottom rows before control-height measurement
 * settles.
 */
export const getDialogMaxHeight = (
  terminalHeight: number,
  staticExtraHeight: number,
): number =>
  Math.max(
    1,
    terminalHeight - staticExtraHeight - MAIN_CONTENT_HEIGHT_RESERVATION,
  );
