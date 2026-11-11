/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useReducer } from 'react';

/** Updates only the displayed running batch; completed UI frames keep their end time. */
export function useHookElapsedTime(
  startedAt: number | undefined,
  endedAt: number | undefined,
): number | undefined {
  const [, refresh] = useReducer((tick: number) => tick + 1, 0);

  useEffect(() => {
    if (startedAt === undefined || endedAt !== undefined) return;

    let timeout: ReturnType<typeof setTimeout>;
    const scheduleNextTick = () => {
      const elapsed = Math.max(0, Date.now() - startedAt);
      timeout = setTimeout(
        () => {
          refresh();
          scheduleNextTick();
        },
        1000 - (elapsed % 1000),
      );
    };
    scheduleNextTick();
    return () => clearTimeout(timeout);
  }, [startedAt, endedAt]);

  if (startedAt === undefined) return undefined;
  return Math.floor(Math.max(0, (endedAt ?? Date.now()) - startedAt) / 1000);
}
