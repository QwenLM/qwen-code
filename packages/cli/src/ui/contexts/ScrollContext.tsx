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
}

export const ScrollContext = createContext<ScrollActions | null>(null);

export function useScrollActions(): ScrollActions | null {
  return useContext(ScrollContext);
}
