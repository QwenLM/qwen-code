/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef } from 'react';

/**
 * Number of lines a height decrease must exceed during streaming
 * to be accepted immediately. Smaller decreases are absorbed.
 */
const SIGNIFICANT_DECREASE_THRESHOLD = 5;

/**
 * Maximum time (ms) a cached height value is allowed to remain stale
 * during streaming before being forcibly updated.
 */
const STALE_TIMEOUT_MS = 2000;

/**
 * Stabilizes a height value during streaming to prevent visual flickering.
 *
 * During active streaming, small height decreases (< threshold) are absorbed
 * to maintain visual stability. Height increases are always accepted since
 * they don't cause content to jump. When idle, the value syncs immediately.
 *
 * @param rawHeight - The real-time computed height
 * @param isStreaming - Whether content is actively streaming
 * @returns Stabilized height value
 */
// Note: This hook mutates refs and reads Date.now() during render.
// This is safe under Ink's synchronous rendering model (no concurrent mode).
export function useStableHeight(
  rawHeight: number,
  isStreaming: boolean,
): number {
  const stableRef = useRef(rawHeight);
  const lastUpdateRef = useRef(Date.now());

  if (!isStreaming) {
    // Idle: sync immediately for accuracy
    stableRef.current = rawHeight;
    lastUpdateRef.current = Date.now();
  } else {
    const delta = rawHeight - stableRef.current;
    const timeSinceUpdate = Date.now() - lastUpdateRef.current;

    if (delta > 0) {
      // More space available — always safe to expand, no content jump
      stableRef.current = rawHeight;
      lastUpdateRef.current = Date.now();
    } else if (
      delta < -SIGNIFICANT_DECREASE_THRESHOLD ||
      timeSinceUpdate > STALE_TIMEOUT_MS
    ) {
      // Significant shrink or stale cache — accept change
      stableRef.current = rawHeight;
      lastUpdateRef.current = Date.now();
    }
    // Otherwise: absorb the small fluctuation, keep cached value
  }

  return stableRef.current;
}
