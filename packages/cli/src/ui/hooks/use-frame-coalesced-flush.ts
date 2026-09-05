/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef } from 'react';

/** One 60Hz frame — the coalescing window for burst scroll input. */
export const SCROLL_FRAME_MS = 16;

/**
 * Coalesce a burst of imperative updates into at most one `flush` per frame.
 *
 * Terminal mouse reporting emits one event per row the pointer crosses, so a
 * brisk wheel spin or scrollbar drag fires many events in quick succession.
 * Applying each synchronously forces one Ink reflow + terminal write per event
 * — the source of choppy scrolling. Callers accumulate their intent in their
 * own ref(s) and call `schedule()`. The leading update applies immediately;
 * later updates in the same frame wait only until that frame's deadline. If
 * rendering already overran the deadline, the next update applies immediately
 * instead of paying another full-frame delay. `cancel()` drops a pending flush
 * (e.g. when a new gesture takes over). The timer is always cleared on unmount.
 *
 * The timer is real (not gated on NODE_ENV), so tests exercise the same path
 * production does; they just need to advance ~`frameMs` before asserting.
 */
export function useFrameCoalescedFlush(
  flush: () => void,
  frameMs: number = SCROLL_FRAME_MS,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushAt = useRef<number | null>(null);
  // Keep the latest flush without re-arming the timer on every render.
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const run = useCallback(() => {
    timer.current = null;
    lastFlushAt.current = performance.now();
    flushRef.current();
  }, []);

  const schedule = useCallback(() => {
    if (timer.current !== null) return;

    const lastFlush = lastFlushAt.current;
    if (lastFlush === null) {
      run();
      return;
    }

    const remaining = frameMs - (performance.now() - lastFlush);
    if (remaining <= 0) {
      run();
      return;
    }

    timer.current = setTimeout(run, remaining);
  }, [run, frameMs]);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const isWindowActive = useCallback(() => {
    if (timer.current !== null) return true;
    const lastFlush = lastFlushAt.current;
    return lastFlush !== null && performance.now() - lastFlush < frameMs;
  }, [frameMs]);

  useEffect(() => cancel, [cancel]);

  return { schedule, cancel, isWindowActive };
}
