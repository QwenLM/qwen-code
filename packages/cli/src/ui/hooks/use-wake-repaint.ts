/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';

// How often the heartbeat timer fires.
const HEARTBEAT_INTERVAL_MS = 5_000;

// If the gap between two consecutive heartbeats exceeds this threshold the
// process was almost certainly suspended (macOS display sleep, system sleep,
// lid close, `Ctrl+Z` + `fg`, etc.).  2× the heartbeat interval gives ample
// margin for event-loop jitter while still catching any real suspend.
const WAKE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 2;

/**
 * Repaint the UI when the process resumes after a suspend / sleep.
 *
 * After macOS display-sleep or system-sleep the terminal emulator's screen
 * buffer may be reset or rearranged, but Ink's internal frame-diff state still
 * reflects the pre-sleep output.  The next render then moves the cursor to the
 * wrong row and the erase-and-redraw cycle strands border / separator
 * characters on screen (the "horizontal lines" artifact).
 *
 * Detection is two-pronged:
 *
 * 1. **Heartbeat timer** — a `setInterval` that records `Date.now()` on each
 *    tick.  If the gap between ticks exceeds {@link WAKE_THRESHOLD_MS} the
 *    event loop was frozen (display sleep, system sleep, laptop lid close).
 *    The timer is `.unref()`'d so it never keeps the process alive.
 *
 * 2. **SIGCONT** — delivered when a stopped process is continued (`fg` after
 *    `Ctrl+Z`).  The terminal's screen buffer is likewise stale in this case.
 *
 * `repaint` must be referentially stable (e.g. `useCallback`) so an unrelated
 * re-render does not re-arm the listeners.
 */
export function useWakeRepaint(repaint: () => void): void {
  const repaintRef = useRef(repaint);
  repaintRef.current = repaint;

  useEffect(() => {
    let lastTick = Date.now();

    const timer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastTick;
      lastTick = now;
      if (elapsed > WAKE_THRESHOLD_MS) {
        repaintRef.current();
      }
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();

    const onSigcont = () => {
      lastTick = Date.now();
      repaintRef.current();
    };
    process.on('SIGCONT', onSigcont);

    return () => {
      clearInterval(timer);
      process.removeListener('SIGCONT', onSigcont);
    };
  }, []);
}
