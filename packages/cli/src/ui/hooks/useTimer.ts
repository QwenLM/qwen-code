/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';

const TIMER_REFRESH_INTERVAL_MS = 500;

function elapsedSeconds(elapsedMs: number): number {
  return Number((Math.max(0, elapsedMs) / 1000).toFixed(1));
}

function getRunningElapsedMs(activeSinceMs: number | null): number {
  if (activeSinceMs === null) {
    return 0;
  }

  return Math.max(0, performance.now() - activeSinceMs);
}

/**
 * Custom hook to manage a wall-clock timer.
 * @param isActive Whether the timer should be running.
 * @param resetKey A key that, when changed, will reset the timer to 0 and restart the interval.
 * @param isPaused Whether the timer should pause without resetting elapsed time.
 * @returns The elapsed time in seconds.
 */
export const useTimer = (
  isActive: boolean,
  resetKey: unknown,
  isPaused = false,
) => {
  const [elapsedTime, setElapsedTime] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const activeSinceRef = useRef<number | null>(null);
  const accumulatedElapsedMsRef = useRef(0);
  const prevResetKeyRef = useRef(resetKey);
  const prevIsActiveRef = useRef(isActive);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    const publishElapsedTime = (elapsedMs: number) => {
      setElapsedTime(elapsedSeconds(elapsedMs));
    };

    const finalizeRunningSegment = () => {
      if (activeSinceRef.current !== null) {
        accumulatedElapsedMsRef.current += getRunningElapsedMs(
          activeSinceRef.current,
        );
        activeSinceRef.current = null;
      }
      publishElapsedTime(accumulatedElapsedMsRef.current);
    };

    if (
      prevResetKeyRef.current !== resetKey ||
      (!prevIsActiveRef.current && isActive)
    ) {
      accumulatedElapsedMsRef.current = 0;
      activeSinceRef.current = null;
      setElapsedTime(0);
      prevResetKeyRef.current = resetKey;
    }

    if (!isActive) {
      if (prevIsActiveRef.current) {
        finalizeRunningSegment();
      }
      clearTimer();
      prevIsActiveRef.current = isActive;
      return clearTimer;
    }

    if (isPaused) {
      finalizeRunningSegment();
      clearTimer();
      prevIsActiveRef.current = isActive;
      return clearTimer;
    }

    if (activeSinceRef.current === null) {
      activeSinceRef.current = performance.now();
    }

    const updateElapsedTime = () => {
      const runningElapsedMs = getRunningElapsedMs(activeSinceRef.current);
      publishElapsedTime(accumulatedElapsedMsRef.current + runningElapsedMs);
    };

    clearTimer();
    timerRef.current = setInterval(
      updateElapsedTime,
      TIMER_REFRESH_INTERVAL_MS,
    );
    updateElapsedTime();

    prevIsActiveRef.current = isActive;
    return clearTimer;
  }, [isActive, isPaused, resetKey]);

  return elapsedTime;
};
