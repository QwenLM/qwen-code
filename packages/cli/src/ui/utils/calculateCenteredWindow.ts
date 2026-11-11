/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Calculates a scroll window start position that keeps the cursor centered.
 *
 * Three zones:
 * - Top zone (cursor < half): window starts at 0
 * - Middle zone: window centers on cursor (start = cursor - half)
 * - Bottom zone (cursor >= itemCount - half): window sticks to bottom
 *
 * @param cursor - The current active/selected index
 * @param itemCount - Total number of items in the list
 * @param windowSize - Number of items visible in the window
 * @returns The starting index of the visible window
 */
export function calculateCenteredWindow(
  cursor: number,
  itemCount: number,
  windowSize: number,
): number {
  if (itemCount <= windowSize) return 0;

  const half = Math.floor(windowSize / 2);
  let start = 0;

  if (cursor >= half && cursor < itemCount - half) {
    start = cursor - half;
  } else if (cursor >= itemCount - half) {
    start = itemCount - windowSize;
  }

  return Math.max(0, start);
}
