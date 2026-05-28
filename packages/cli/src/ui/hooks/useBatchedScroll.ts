/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef, useLayoutEffect, useCallback } from 'react';

/**
 * A hook to manage batched scroll state updates.
 * It allows multiple scroll operations within the same tick to accumulate
 * by keeping track of a 'pending' state that resets after render.
 */
export function useBatchedScroll(currentScrollTop: number) {
  const pendingScrollTopRef = useRef<number | null>(null);
  const currentScrollTopRef = useRef(currentScrollTop);

   
  useLayoutEffect(() => {
    currentScrollTopRef.current = currentScrollTop;
    pendingScrollTopRef.current = null;
  });

  const getScrollTop = useCallback(
    () => pendingScrollTopRef.current ?? currentScrollTopRef.current,
    [],
  );

  const setPendingScrollTop = useCallback((newScrollTop: number) => {
    pendingScrollTopRef.current = newScrollTop;
  }, []);

  return { getScrollTop, setPendingScrollTop };
}
