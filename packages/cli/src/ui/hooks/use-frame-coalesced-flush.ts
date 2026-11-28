/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef } from 'react';

/** One 60Hz frame — the coalescing window for burst scroll input. */
export const SCROLL_FRAME_MS = 16;

/** Deliver the first update immediately, then flush on a frame cadence.
 * Return true from flush while buffered motion needs another frame.
 */
export function useFrameCoalescedFlush(
  flush: () => boolean,
  frameMs: number = SCROLL_FRAME_MS,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlush = useRef<number | null>(null);
  // Keep the latest flush without re-arming the timer on every render.
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const run = useCallback(
    function run() {
      timer.current = null;
      lastFlush.current = performance.now();
      if (flushRef.current()) {
        timer.current = setTimeout(
          run,
          Math.max(0, frameMs - (performance.now() - lastFlush.current)),
        );
      }
    },
    [frameMs],
  );

  const schedule = useCallback(() => {
    if (timer.current !== null) return;
    const remaining =
      lastFlush.current === null
        ? 0
        : frameMs - (performance.now() - lastFlush.current);
    if (remaining <= 0) run();
    else timer.current = setTimeout(run, remaining);
  }, [run, frameMs]);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    lastFlush.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  return { schedule, cancel };
}
