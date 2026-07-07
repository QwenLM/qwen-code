/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

/**
 * The width at or above which the app is considered a "large screen". The
 * Session Overview panel is only offered past this point: below it there is no
 * horizontal room to make managing several sessions at once worthwhile, and the
 * sidebar collapses to a mobile drawer (see the 760px breakpoint in App.tsx).
 */
export const LARGE_SCREEN_QUERY = '(min-width: 1024px)';

/**
 * Tracks whether the viewport currently matches a large-screen media query.
 *
 * Mirrors the inline `matchMedia` pattern already used for the mobile drawer:
 * seed synchronously from `matchMedia().matches` so the first render is correct
 * (no flash), then subscribe to `change`. Degrades to `false` when `matchMedia`
 * is unavailable (SSR / the jsdom test default), which keeps large-screen-only
 * entry points hidden unless a test explicitly opts in.
 */
export function useIsLargeScreen(query: string = LARGE_SCREEN_QUERY): boolean {
  const [isLarge, setIsLarge] = useState<boolean>(() => matchesQuery(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(query);
    // Re-sync in case the viewport changed between the initial render and this
    // effect running (e.g. a resize during hydration).
    setIsLarge(mql.matches);
    const handler = (event: MediaQueryListEvent) => setIsLarge(event.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return isLarge;
}

function matchesQuery(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(query).matches;
}
