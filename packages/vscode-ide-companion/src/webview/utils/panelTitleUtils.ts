/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Maximum number of Unicode code points shown before truncation in VS Code panel tab titles.
 * Titles longer than this are shown as the first MAX_PANEL_TITLE_LENGTH code points + "…".
 * Prevents a long session title from stretching the editor tab bar.
 * Note: VS Code measures tab width in rendered pixels, not character count, so this is
 * a reasonable approximation rather than a precise pixel limit.
 */
export const MAX_PANEL_TITLE_LENGTH = 50;

/**
 * Truncate a title to fit within the VS Code editor tab, appending "…" if needed.
 * Operates on Unicode code points (not UTF-16 code units) to avoid splitting surrogate pairs,
 * e.g. emoji that are encoded as two UTF-16 code units.
 * If truncated, the result is MAX_PANEL_TITLE_LENGTH content code points + "…".
 */
export function truncatePanelTitle(title: string): string {
  const codePoints = [...title];
  if (codePoints.length <= MAX_PANEL_TITLE_LENGTH) {
    return title;
  }
  return codePoints.slice(0, MAX_PANEL_TITLE_LENGTH).join('') + '…';
}
