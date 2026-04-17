/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';

/**
 * Hook that polls a ref at a fixed interval and smoothly animates the
 * displayed value toward the real value. This avoids jarring jumps when
 * large chunks of characters arrive at once (e.g. tool call args JSON).
 *
 * Animation rules (matching Claude Code's SpinnerAnimationRow):
 * - Gap < 70:   increment by 3 per frame
 * - Gap 70–200: increment by ~20% of gap per frame
 * - Gap > 200:  increment by 50 per frame
 *
 * When the real value decreases (e.g. ref reset to 0), the displayed
 * value snaps immediately — animation only applies to increases.
 *
 * Pass `null` as intervalMs to pause polling entirely.
 *
 * @param watchRef - The ref to poll for changes.
 * @param intervalMs - How often to check (ms), or null to pause.
 * @returns The smoothly animated value.
 */
export function useAnimationFrame(
  watchRef: React.RefObject<number>,
  intervalMs: number | null = 50,
): number {
  const [displayValue, setDisplayValue] = useState(() => watchRef.current);
  const displayRef = useRef(watchRef.current);
  const targetRef = useRef(watchRef.current);

  useEffect(() => {
    if (intervalMs === null) return;

    // Re-sync when the interval resumes or the ref changed externally
    // (e.g. ref reset to 0 at new turn start while paused).
    const current = watchRef.current;
    if (current !== targetRef.current) {
      targetRef.current = current;
      // Snap down immediately (reset), animate up
      if (current < displayRef.current) {
        displayRef.current = current;
        setDisplayValue(current);
      }
    }

    const id = setInterval(() => {
      const realValue = watchRef.current;
      targetRef.current = realValue;

      // Snap down immediately on reset
      if (realValue < displayRef.current) {
        displayRef.current = realValue;
        setDisplayValue(realValue);
        return;
      }

      const gap = realValue - displayRef.current;
      if (gap <= 0) return;

      // Smooth interpolation: small gaps crawl, large gaps leap
      let increment: number;
      if (gap < 70) {
        increment = 3;
      } else if (gap <= 200) {
        increment = Math.max(3, Math.round(gap * 0.2));
      } else {
        increment = 50;
      }

      const next = Math.min(displayRef.current + increment, realValue);
      displayRef.current = next;
      setDisplayValue(next);
    }, intervalMs);

    return () => clearInterval(id);
  }, [watchRef, intervalMs]);

  return displayValue;
}
