/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseDoubleTapOptions {
  /** Time window (ms) between taps to count as a double-tap. */
  timeoutMs: number;
  /** Fired on the second tap within the window. */
  onDoubleTap: () => void;
  /** Fired on the first tap (optional, e.g. for showing a hint). */
  onFirstTap?: () => void;
  /** Fired when the window expires without a second tap. */
  onTimeout?: () => void;
}

export interface UseDoubleTapResult {
  /** Call this on every qualifying tap event. */
  handleTap: () => void;
  /** True between the first tap and the timeout/second-tap. */
  isPending: boolean;
  /** Manually reset the pending state. */
  reset: () => void;
}

export function useDoubleTap(opts: UseDoubleTapOptions): UseDoubleTapResult {
  const { timeoutMs } = opts;
  const [isPending, setIsPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacksRef = useRef(opts);
  callbacksRef.current = opts;

  useEffect(() => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    }, []);

  const reset = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsPending(false);
  }, []);

  const handleTap = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      setIsPending(false);
      callbacksRef.current.onDoubleTap();
    } else {
      setIsPending(true);
      callbacksRef.current.onFirstTap?.();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setIsPending(false);
        callbacksRef.current.onTimeout?.();
      }, timeoutMs);
    }
  }, [timeoutMs]);

  return { handleTap, isPending, reset };
}
