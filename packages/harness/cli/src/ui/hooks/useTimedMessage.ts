/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * A hook to manage a state value that automatically resets to null after a duration.
 * Useful for transient UI messages, hints, or warnings.
 *
 * When `persist` is passed as the second argument to `showMessage`, the auto-
 * clear timer is skipped and the message stays visible until explicitly replaced.
 */
export function useTimedMessage<T>(durationMs: number) {
  const [message, setMessage] = useState<T | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const showMessage = useCallback(
    (msg: T | null, persist?: boolean) => {
      setMessage(msg);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (msg !== null && !persist) {
        timeoutRef.current = setTimeout(() => {
          setMessage(null);
        }, durationMs);
      }
    },
    [durationMs],
  );

  useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    },
    [],
  );

  return [message, showMessage] as const;
}
