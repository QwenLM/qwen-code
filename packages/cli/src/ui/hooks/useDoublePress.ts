/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef, useCallback, useEffect } from 'react';

const DOUBLE_PRESS_TIMEOUT_MS = 800;

/**
 * Generic double-press detection hook.
 *
 * Returns a callback that should be invoked on each press. On the first
 * press, optionally calls `onPending(true)` and starts a timer. If a
 * second press arrives within 800ms, calls `onDoublePress`. Otherwise,
 * the pending state is cleared after the timeout.
 *
 * @param onDoublePress Callback fired when a double-press is detected
 * @param onPending Optional callback to update pending state (for UI hints)
 * @returns A callback to invoke on each press
 */
export function useDoublePress(
  onDoublePress: () => void,
  onPending?: (pending: boolean) => void,
): () => void {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up timer on unmount
  useEffect(
    () => () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    },
    [],
  );

  return useCallback(() => {
    if (timeoutRef.current !== null) {
      // Second press within the timeout window
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      onPending?.(false);
      onDoublePress();
    } else {
      // First press — start the timer
      onPending?.(true);
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        onPending?.(false);
      }, DOUBLE_PRESS_TIMEOUT_MS);
    }
  }, [onDoublePress, onPending]);
}
