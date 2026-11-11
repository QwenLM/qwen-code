/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * usePagination — Continuous-scroll pagination hook.
 *
 * Tracks a scroll offset that automatically adjusts when the selected
 * index moves outside the visible window. Used by ManagePlugins and
 * BrowseMarketplace for smooth list scrolling.
 */

import { useCallback, useMemo, useRef } from 'react';

const DEFAULT_MAX_VISIBLE = 5;

interface UsePaginationOptions {
  totalItems: number;
  maxVisible?: number;
  selectedIndex?: number;
}

export interface UsePaginationResult<T> {
  startIndex: number;
  endIndex: number;
  needsPagination: boolean;
  pageSize: number;
  /** Slice the full item array to the currently visible window. */
  getVisibleItems: (items: T[]) => T[];
  /** Convert a visible-window index to the actual array index. */
  toActualIndex: (visibleIndex: number) => number;
  /** Whether the given actual index is currently visible. */
  isVisible: (actualIndex: number) => boolean;
  /** Clamp and apply a new selection index. */
  handleSelectionChange: (
    newIndex: number,
    setSelectedIndex: (index: number) => void,
  ) => void;
  /** Scroll position info for rendering scroll indicators. */
  scrollPosition: {
    current: number;
    total: number;
    canScrollUp: boolean;
    canScrollDown: boolean;
  };
}

export function usePagination<T>({
  totalItems,
  maxVisible = DEFAULT_MAX_VISIBLE,
  selectedIndex = 0,
}: UsePaginationOptions): UsePaginationResult<T> {
  const needsPagination = totalItems > maxVisible;
  const scrollOffsetRef = useRef(0);

  // Compute scroll offset to keep selectedIndex visible
  const scrollOffset = useMemo(() => {
    if (!needsPagination) return 0;

    const prevOffset = scrollOffsetRef.current;

    // Selected above visible window → scroll up
    if (selectedIndex < prevOffset) {
      scrollOffsetRef.current = selectedIndex;
      return selectedIndex;
    }

    // Selected below visible window → scroll down
    if (selectedIndex >= prevOffset + maxVisible) {
      const newOffset = selectedIndex - maxVisible + 1;
      scrollOffsetRef.current = newOffset;
      return newOffset;
    }

    // Within window — keep current offset, but clamp to valid range
    const maxOffset = Math.max(0, totalItems - maxVisible);
    const clamped = Math.min(prevOffset, maxOffset);
    scrollOffsetRef.current = clamped;
    return clamped;
  }, [selectedIndex, maxVisible, needsPagination, totalItems]);

  const startIndex = scrollOffset;
  const endIndex = Math.min(scrollOffset + maxVisible, totalItems);

  const getVisibleItems = useCallback(
    (items: T[]): T[] => {
      if (!needsPagination) return items;
      return items.slice(startIndex, endIndex);
    },
    [needsPagination, startIndex, endIndex],
  );

  const toActualIndex = useCallback(
    (visibleIndex: number): number => startIndex + visibleIndex,
    [startIndex],
  );

  const isVisible = useCallback(
    (actualIndex: number): boolean =>
      actualIndex >= startIndex && actualIndex < endIndex,
    [startIndex, endIndex],
  );

  const handleSelectionChange = useCallback(
    (newIndex: number, setSelectedIndex: (index: number) => void) => {
      const clamped = Math.max(0, Math.min(newIndex, totalItems - 1));
      setSelectedIndex(clamped);
    },
    [totalItems],
  );

  return {
    startIndex,
    endIndex,
    needsPagination,
    pageSize: maxVisible,
    getVisibleItems,
    toActualIndex,
    isVisible,
    handleSelectionChange,
    scrollPosition: {
      current: selectedIndex + 1,
      total: totalItems,
      canScrollUp: scrollOffset > 0,
      canScrollDown: scrollOffset + maxVisible < totalItems,
    },
  };
}
