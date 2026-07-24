/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const EstimatedArtWidth = 59;
const BoxBorderWidth = 1;
export const BOX_PADDING_X = 1;

// Calculate width based on art, padding, and border
export const UI_WIDTH =
  EstimatedArtWidth + BOX_PADDING_X * 2 + BoxBorderWidth * 2; // ~63

export const STREAM_DEBOUNCE_MS = 100;

export const SHELL_COMMAND_NAME = 'Shell Command';

export const SHELL_NAME = 'Shell';

// Tool status symbols used in ToolMessage component
export const TOOL_STATUS = {
  SUCCESS: '✓',
  PENDING: 'o',
  EXECUTING: '⊷',
  CONFIRMING: '?',
  CANCELED: '-',
  ERROR: 'x',
} as const;

// Variation Selector 15 (U+FE0E) is zero-width in string-width but forces
// the terminal to render the preceding glyph in narrow (1-column) text
// presentation. This ensures CJK terminals (which would otherwise render
// East-Asian-Width "Ambiguous" glyphs as 2 columns) agree with Ink's
// layout engine (which always measures them as 1 column).
const _VS15 = '\uFE0E';
export const ICON = {
  DIAMOND: `◆${_VS15}`,
  CIRCLE_FILLED: `●${_VS15}`,
  TRIANGLE: `△${_VS15}`,
  CIRCLE_EMPTY: `○${_VS15}`,
  BULLSEYE: `◎${_VS15}`,
  REFERENCE: `※${_VS15}`,
  THEREFORE: `∴${_VS15}`,
  BECAUSE: `∵${_VS15}`,
  STAR: `★${_VS15}`,
  RADIO_FILLED: `◉${_VS15}`,
  CIRCLE_LEFT_HALF: `◐${_VS15}`,
} as const;
