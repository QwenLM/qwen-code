/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared layout calculation utilities for the terminal UI.
 */

export const getPromptHorizontalMargin = (terminalWidth: number): number =>
  terminalWidth >= 8 ? 2 : 0;

/**
 * Calculate the widths for the input prompt area based on terminal width.
 *
 * Returns the text-buffer width, the input and suggestions container widths,
 * and the columns used by the outer gutters and prompt prefix.
 */
export const calculatePromptWidths = (terminalWidth: number) => {
  const OUTER_GUTTER = getPromptHorizontalMargin(terminalWidth) * 2;
  const PROMPT_PREFIX_WIDTH = 2; // '> ' or '! '
  const MIN_CONTENT_WIDTH = 2;

  const containerWidth = Math.max(4, terminalWidth - OUTER_GUTTER);
  const innerContentWidth = containerWidth - PROMPT_PREFIX_WIDTH;

  const inputWidth = Math.max(MIN_CONTENT_WIDTH, innerContentWidth);
  const FRAME_OVERHEAD = OUTER_GUTTER + PROMPT_PREFIX_WIDTH;
  const suggestionsWidth = containerWidth;

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
 * height and the stream's viewport rows, so raising this constant takes a row
 * from every popup and shortens every embedded shell result by one.
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

/** Minimum rows the `/btw` answer viewport keeps even on a tiny terminal. */
export const MIN_BTW_ANSWER_ROWS = 3;

/**
 * The `/btw` side answer shares the bottom controls region with the composer
 * and the live-agent panel, so unlike a dialog it cannot take the whole
 * screen. It is capped at half the terminal, and never so tall that the
 * composer would be pushed off a short one.
 */
export const getBtwAnswerMaxRows = (terminalHeight: number): number => {
  if (!Number.isFinite(terminalHeight) || terminalHeight <= 0) {
    return MIN_BTW_ANSWER_ROWS;
  }
  return Math.max(
    MIN_BTW_ANSWER_ROWS,
    Math.min(Math.floor(terminalHeight / 2), terminalHeight - 8),
  );
};
