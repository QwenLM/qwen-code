/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';

/**
 * Custom hook to manage a timer that increments every second.
 * @param isActive Whether the timer should be running. Inactive timers pause
 * without losing elapsed time.
 * @param resetKey A key that resets the elapsed time to 0 when changed.
 * @returns The elapsed time in seconds.
 */
export const useTimer = (isActive: boolean, resetKey: unknown) => {
  const [elapsedTime, setElapsedTime] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const prevResetKeyRef = useRef(resetKey);

  useEffect(() => {
    if (prevResetKeyRef.current !== resetKey) {
      prevResetKeyRef.current = resetKey;
      setElapsedTime(0);
    }

    // Manage interval
    if (isActive) {
      // Clear previous interval unconditionally before starting a new one
      // This handles resetKey changes while active, ensuring a fresh interval start.
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      timerRef.current = setInterval(() => {
        setElapsedTime((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isActive, resetKey]);

  return elapsedTime;
};
