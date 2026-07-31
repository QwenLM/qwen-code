/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Zero-width space used as a height placeholder in contentEditable inputs.
 *
 * After clearing a contentEditable element (e.g. on message submit), setting
 * its textContent to this character keeps the element at its normal line height
 * instead of collapsing to zero height. All downstream consumers must strip
 * this character before treating the text as real user input.
 */
export const ZERO_WIDTH_SPACE = '\u200B';

/**
 * Strip {@link ZERO_WIDTH_SPACE} placeholders from text.
 *
 * @param text - raw text that may contain zero-width spaces
 * @returns text with all zero-width spaces removed
 */
export function stripZeroWidthSpaces(text: string): string {
  return text.replace(/\u200B/g, '');
}
