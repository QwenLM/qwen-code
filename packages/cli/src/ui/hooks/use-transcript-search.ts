/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScrollActions } from '../contexts/ScrollContext.js';
import type { VpItem } from '../utils/virtual-items.js';
import {
  searchTranscriptItems,
  type TranscriptSearchMatch,
  type TranscriptSearchResult,
} from '../utils/transcript-search.js';

const EMPTY_RESULT: TranscriptSearchResult = { matches: [], truncated: false };

/**
 * Which match to show first for a fresh query: the closest one at or above
 * the current viewport top, falling back to the oldest match. Reading a long
 * session usually means "the most recent occurrence before where I am", and
 * this makes repeated Alt+S + typing feel like searching backwards from the
 * live tail instead of always teleporting to the session's first line.
 */
export function pickInitialMatchPosition(
  matches: readonly TranscriptSearchMatch[],
  referenceIndex: number | null,
): number {
  if (matches.length === 0) return -1;
  if (referenceIndex === null) return matches.length - 1;
  let position = -1;
  for (let i = 0; i < matches.length; i += 1) {
    if (matches[i].index <= referenceIndex) {
      position = i;
    } else {
      break;
    }
  }
  return position === -1 ? 0 : position;
}

export interface UseTranscriptSearchOptions {
  isActive: boolean;
  /** Live query, normally the composer's buffer text while search is open. */
  query: string;
  /** The viewport's item array (see buildVirtualItems). */
  items: readonly VpItem[];
  scrollActions: ScrollActions | null;
}

export interface UseTranscriptSearchResult {
  matches: readonly TranscriptSearchMatch[];
  truncated: boolean;
  /** Index into `matches`; -1 when there is nothing to show. */
  activeMatchPosition: number;
  activeMatch: TranscriptSearchMatch | null;
  nextMatch: () => void;
  previousMatch: () => void;
  /**
   * True when a jump was requested but the transcript could not be addressed
   * (legacy <Static> mode, or the viewport is not mounted yet).
   */
  jumpUnsupported: boolean;
}

export function useTranscriptSearch({
  isActive,
  query,
  items,
  scrollActions,
}: UseTranscriptSearchOptions): UseTranscriptSearchResult {
  const result = useMemo(
    () => (isActive ? searchTranscriptItems(items, query) : EMPTY_RESULT),
    [isActive, items, query],
  );
  const { matches, truncated } = result;

  const scrollActionsRef = useRef(scrollActions);
  scrollActionsRef.current = scrollActions;

  // Lazy initial selection: the reset below only fires on *changes* of
  // isActive/query, so mounting an already-open search must pick its starting
  // match here (otherwise every search would start at the oldest hit).
  const [requestedPosition, setRequestedPosition] = useState(() =>
    isActive
      ? pickInitialMatchPosition(
          matches,
          scrollActions?.getScrollIndex?.() ?? null,
        )
      : 0,
  );
  const [jumpUnsupported, setJumpUnsupported] = useState(false);

  // Reset the cursor only when the search opens or the query changes. New
  // history arriving mid-search merely reclamps the cursor (below) so
  // streaming output cannot yank the user away from the match they are on.
  const [resetKey, setResetKey] = useState({ isActive, query });
  if (resetKey.isActive !== isActive || resetKey.query !== query) {
    setResetKey({ isActive, query });
    setRequestedPosition(
      pickInitialMatchPosition(
        matches,
        scrollActions?.getScrollIndex?.() ?? null,
      ),
    );
    setJumpUnsupported(false);
  }

  const activeMatchPosition =
    matches.length === 0
      ? -1
      : Math.max(0, Math.min(requestedPosition, matches.length - 1));
  const activeMatch =
    activeMatchPosition === -1 ? null : matches[activeMatchPosition];
  const activeMatchIndex = activeMatch?.index;

  useEffect(() => {
    if (!isActive || activeMatchIndex === undefined) return;
    const supported =
      scrollActionsRef.current?.scrollToIndex?.(activeMatchIndex) ?? false;
    setJumpUnsupported(!supported);
  }, [isActive, activeMatchIndex, matches, scrollActionsRef]);

  return {
    matches,
    truncated,
    activeMatchPosition,
    activeMatch,
    nextMatch: () =>
      setRequestedPosition((position) =>
        matches.length === 0 ? -1 : (position + 1) % matches.length,
      ),
    previousMatch: () =>
      setRequestedPosition((position) =>
        matches.length === 0
          ? -1
          : (position - 1 + matches.length) % matches.length,
      ),
    jumpUnsupported,
  };
}
