/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';

// Trailing-edge debounce for resize-triggered static repaints (#4891).
export const RESIZE_REPAINT_SETTLE_MS = 200;

/**
 * Repaint the static history once the terminal width settles (#4891).
 *
 * A window drag fires dozens of `resize` events. Per-event repainting restarted
 * the progressive <Static> replay (#3899) mid-flight, and the viewport-only
 * cursorTo+eraseDown erase introduced by #3967 (4bab7a1a) cannot reach output
 * that has already scrolled into the scrollback, so each event stranded a
 * fragment at that instant's width. Debouncing to the trailing edge and issuing
 * one full `refreshStatic` (clearTerminal incl. ESC[3J + remount) wipes the
 * fragments and re-emits the history once at the final width. The cleanup
 * cancels the pending timer on the next width change or unmount, so a drag
 * returning to the start width is a no-op.
 *
 * Trade-off: the full-screen flash #3967 removed returns, but at most once per
 * resize gesture; the settle-time ESC[3J clears pre-session scrollback — the
 * same as the pre-#3967 per-event behavior and today's /clear.
 *
 * `refreshStatic` must be referentially stable (e.g. `useCallback`) so an
 * unrelated re-render does not cancel an in-flight settle.
 */
export function useResizeSettleRepaint(
  terminalWidth: number,
  refreshStatic: () => void,
): void {
  // Width at the last settled repaint; starts at mount width (first mount is a
  // no-op) and only advances when a repaint actually fires.
  const settledTerminalWidthRef = useRef(terminalWidth);

  useEffect(() => {
    if (settledTerminalWidthRef.current === terminalWidth) {
      return;
    }
    const timer = setTimeout(() => {
      settledTerminalWidthRef.current = terminalWidth;
      refreshStatic();
    }, RESIZE_REPAINT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [terminalWidth, refreshStatic]);
}
