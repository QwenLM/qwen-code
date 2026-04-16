/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';

/**
 * Hook that polls a ref at a fixed interval and triggers a re-render only
 * when the ref's value has changed. This avoids the cost of unconditional
 * re-renders while still providing smooth animation-style updates.
 *
 * Pass `null` as intervalMs to pause polling entirely. When resuming from
 * pause, the internal tracking is re-synced to the ref's current value.
 *
 * @param watchRef - The ref to poll for changes.
 * @param intervalMs - How often to check (ms), or null to pause.
 * @returns The latest value read from the ref.
 */
export function useAnimationFrame(
  watchRef: React.RefObject<number>,
  intervalMs: number | null = 50,
): number {
  const [value, setValue] = useState(() => watchRef.current);
  const lastSeen = useRef(watchRef.current);

  useEffect(() => {
    if (intervalMs === null) return;

    // Re-sync when resuming from pause (e.g. new turn resets ref to 0
    // while we were paused with a stale lastSeen from the previous turn).
    const current = watchRef.current;
    if (current !== lastSeen.current) {
      lastSeen.current = current;
      setValue(current);
    }

    const id = setInterval(() => {
      const now = watchRef.current;
      if (now !== lastSeen.current) {
        lastSeen.current = now;
        setValue(now);
      }
    }, intervalMs);

    return () => clearInterval(id);
  }, [watchRef, intervalMs]);

  return value;
}
