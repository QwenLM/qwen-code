/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * Drop-in replacement for `useStateAndRef` that caps React re-render frequency
 * to one per `intervalMs`. The ref is updated synchronously on every call so
 * synchronous readers (finalize paths that do `addItem(ref.current)` etc.)
 * always see the latest value. Only the React state — which drives Ink render
 * frequency — is throttled.
 *
 * Streaming gemini chunks arrive faster than a terminal can paint a fresh
 * multi-line frame. Without throttling, every chunk triggers a React commit
 * → Ink write → "erase N lines + write N lines" terminal IO. The terminal
 * shows the in-between state as flicker. With a 16ms cap, chunks that arrive
 * in the same frame window coalesce into one write.
 *
 * A nullish value (`null`/`undefined`) bypasses throttling so finalize's
 * `setState(null)` clears the pending render immediately — without this,
 * after `addItem(...); setState(null)` the committed content would remain
 * visible in the pending area for up to `intervalMs`, showing duplicated.
 */
export function useRenderThrottledStateAndRef<
  T extends object | null | undefined | number | string,
>(
  initialValue: T,
  intervalMs: number,
): readonly [
  T,
  React.MutableRefObject<T>,
  (value: T | ((prev: T) => T)) => void,
  () => void,
] {
  const [state, setState] = React.useState<T>(initialValue);
  const ref = React.useRef<T>(initialValue);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFireRef = React.useRef(0);

  React.useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  const flush = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setState(ref.current);
    lastFireRef.current = Date.now();
  }, []);

  const throttledSet = React.useCallback(
    (valueOrFn: T | ((prev: T) => T)) => {
      const next =
        typeof valueOrFn === 'function'
          ? (valueOrFn as (prev: T) => T)(ref.current)
          : valueOrFn;
      ref.current = next;

      // Nullish: flush immediately so a cleared pending doesn't linger past
      // the throttle window while history already shows the committed content.
      if (next === null || next === undefined) {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        setState(next);
        lastFireRef.current = Date.now();
        return;
      }

      const now = Date.now();
      const elapsed = now - lastFireRef.current;
      if (elapsed >= intervalMs) {
        setState(next);
        lastFireRef.current = now;
        return;
      }
      if (timerRef.current) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setState(ref.current);
        lastFireRef.current = Date.now();
      }, intervalMs - elapsed);
    },
    [intervalMs],
  );

  return [state, ref, throttledSet, flush] as const;
}
