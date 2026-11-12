/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';

export interface ScrollActions {
  scrollBy: (delta: number) => void;
  /**
   * Whether the transcript has any scrollable overflow at all. Callers routing
   * keys to the transcript use this to leave short conversations alone: with
   * nothing to scroll, ↑/↓ must keep doing input-history navigation instead of
   * becoming dead keys. Deliberately not delta-aware — at an edge of a
   * scrollable transcript the key is still consumed, so a wheel that runs past
   * the top cannot start replaying input history.
   */
  hasScrollableTranscript: () => boolean;
  /**
   * Scroll so `data[index]` lands at the top of the viewport (clamped at the
   * end of the transcript). Used by structure navigation and by transcript
   * search, which address items rather than scroll deltas.
   *
   * Returns false when item-level addressing is unavailable — the legacy
   * <Static> path (ui.useTerminalBuffer off) has no viewport to anchor — so
   * callers can say the feature is unavailable instead of failing silently.
   * Optional because only the virtual viewport can implement it.
   */
  scrollToIndex?: (index: number) => boolean;
  /** Follow the newest output again. No-op outside the virtual viewport. */
  scrollToEnd?: () => void;
  /**
   * Index of the item currently at the top of the viewport, or null when the
   * viewport is not virtualized or has not been measured yet.
   */
  getScrollIndex?: () => number | null;
}

export const ScrollContext = createContext<ScrollActions | null>(null);

export function useScrollActions(): ScrollActions | null {
  return useContext(ScrollContext);
}
