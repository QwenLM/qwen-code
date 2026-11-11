/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';

export interface ShellElapsedTime {
  elapsedMs: number;
  elapsedSeconds: number;
}

/** Derive live shell elapsed time from a stable start timestamp. */
export function useShellElapsedTime(
  startedAt: number | undefined,
  active: boolean,
): ShellElapsedTime {
  const fallbackStartedAt = useRef(Date.now());
  const effectiveStartedAt = startedAt ?? fallbackStartedAt.current;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }

    setNow(Date.now());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const scheduleNextTick = () => {
      const timestamp = Date.now();
      const elapsed = Math.max(0, timestamp - effectiveStartedAt);
      const untilNextSecond = 1000 - (elapsed % 1000);
      timeout = setTimeout(() => {
        setNow(Date.now());
        scheduleNextTick();
      }, untilNextSecond);
    };
    scheduleNextTick();

    return () => {
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }, [active, effectiveStartedAt]);

  const elapsedMs = active ? Math.max(0, now - effectiveStartedAt) : 0;
  return {
    elapsedMs,
    elapsedSeconds: Math.floor(elapsedMs / 1000),
  };
}
