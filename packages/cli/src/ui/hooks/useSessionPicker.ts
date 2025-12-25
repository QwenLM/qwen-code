/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified session picker hook for both dialog and standalone modes.
 *
 * IMPORTANT:
 * - Uses KeypressContext (`useKeypress`) so it behaves correctly inside the main app.
 * - Standalone mode should wrap the picker in `<KeypressProvider>` when rendered
 *   outside the main app.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ListSessionsResult,
  SessionListItem,
  SessionService,
} from '@qwen-code/qwen-code-core';
import {
  filterSessions,
  SESSION_PAGE_SIZE,
  type SessionState,
} from '../utils/sessionPickerUtils.js';
import { useKeypress } from './useKeypress.js';

export interface UseSessionPickerOptions {
  sessionService: SessionService | null;
  currentBranch?: string;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
  maxVisibleItems: number;
  /**
   * If true, computes centered scroll offset (keeps selection near middle).
   * If false, uses follow mode (scrolls when selection reaches edge).
   */
  centerSelection?: boolean;
  /**
   * Enable/disable input handling.
   */
  isActive?: boolean;
}

export interface UseSessionPickerResult {
  selectedIndex: number;
  sessionState: SessionState;
  filteredSessions: SessionListItem[];
  filterByBranch: boolean;
  isLoading: boolean;
  scrollOffset: number;
  visibleSessions: SessionListItem[];
  showScrollUp: boolean;
  showScrollDown: boolean;
  loadMoreSessions: () => Promise<void>;
}

export function useSessionPicker({
  sessionService,
  currentBranch,
  onSelect,
  onCancel,
  maxVisibleItems,
  centerSelection = false,
  isActive = true,
}: UseSessionPickerOptions): UseSessionPickerResult {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [sessionState, setSessionState] = useState<SessionState>({
    sessions: [],
    hasMore: true,
    nextCursor: undefined,
  });
  const [filterByBranch, setFilterByBranch] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // For follow mode (non-centered)
  const [followScrollOffset, setFollowScrollOffset] = useState(0);

  const isLoadingMoreRef = useRef(false);

  const filteredSessions = useMemo(
    () => filterSessions(sessionState.sessions, filterByBranch, currentBranch),
    [sessionState.sessions, filterByBranch, currentBranch],
  );

  const scrollOffset = useMemo(() => {
    if (centerSelection) {
      if (filteredSessions.length <= maxVisibleItems) {
        return 0;
      }
      const halfVisible = Math.floor(maxVisibleItems / 2);
      let offset = selectedIndex - halfVisible;
      offset = Math.max(0, offset);
      offset = Math.min(filteredSessions.length - maxVisibleItems, offset);
      return offset;
    }
    return followScrollOffset;
  }, [
    centerSelection,
    filteredSessions.length,
    followScrollOffset,
    maxVisibleItems,
    selectedIndex,
  ]);

  const visibleSessions = useMemo(
    () => filteredSessions.slice(scrollOffset, scrollOffset + maxVisibleItems),
    [filteredSessions, maxVisibleItems, scrollOffset],
  );
  const showScrollUp = scrollOffset > 0;
  const showScrollDown =
    scrollOffset + maxVisibleItems < filteredSessions.length;

  // Initial load
  useEffect(() => {
    if (!sessionService) {
      return;
    }

    const loadInitialSessions = async () => {
      try {
        const result: ListSessionsResult = await sessionService.listSessions({
          size: SESSION_PAGE_SIZE,
        });
        setSessionState({
          sessions: result.items,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        });
      } finally {
        setIsLoading(false);
      }
    };

    void loadInitialSessions();
  }, [sessionService]);

  const loadMoreSessions = useCallback(async () => {
    if (!sessionService || !sessionState.hasMore || isLoadingMoreRef.current) {
      return;
    }

    isLoadingMoreRef.current = true;
    try {
      const result: ListSessionsResult = await sessionService.listSessions({
        size: SESSION_PAGE_SIZE,
        cursor: sessionState.nextCursor,
      });
      setSessionState((prev) => ({
        sessions: [...prev.sessions, ...result.items],
        hasMore: result.hasMore && result.nextCursor !== undefined,
        nextCursor: result.nextCursor,
      }));
    } finally {
      isLoadingMoreRef.current = false;
    }
  }, [sessionService, sessionState.hasMore, sessionState.nextCursor]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
    setFollowScrollOffset(0);
  }, [filterByBranch]);

  // Ensure selectedIndex is valid when filtered sessions change
  useEffect(() => {
    if (
      selectedIndex >= filteredSessions.length &&
      filteredSessions.length > 0
    ) {
      setSelectedIndex(filteredSessions.length - 1);
    }
  }, [filteredSessions.length, selectedIndex]);

  // Auto-load more when centered mode hits the sentinel or list is empty.
  useEffect(() => {
    if (
      isLoading ||
      !sessionState.hasMore ||
      isLoadingMoreRef.current ||
      !centerSelection
    ) {
      return;
    }

    const sentinelVisible =
      scrollOffset + maxVisibleItems >= filteredSessions.length;
    const shouldLoadMore = filteredSessions.length === 0 || sentinelVisible;

    if (shouldLoadMore) {
      void loadMoreSessions();
    }
  }, [
    centerSelection,
    filteredSessions.length,
    isLoading,
    loadMoreSessions,
    maxVisibleItems,
    scrollOffset,
    sessionState.hasMore,
  ]);

  // Key handling (KeypressContext)
  useKeypress(
    (key) => {
      const { name, sequence, ctrl } = key;

      if (name === 'escape' || (ctrl && name === 'c')) {
        onCancel();
        return;
      }

      if (name === 'return') {
        const session = filteredSessions[selectedIndex];
        if (session) {
          onSelect(session.sessionId);
        }
        return;
      }

      if (name === 'up' || name === 'k') {
        setSelectedIndex((prev) => {
          const newIndex = Math.max(0, prev - 1);
          if (!centerSelection && newIndex < followScrollOffset) {
            setFollowScrollOffset(newIndex);
          }
          return newIndex;
        });
        return;
      }

      if (name === 'down' || name === 'j') {
        if (filteredSessions.length === 0) {
          return;
        }

        setSelectedIndex((prev) => {
          const newIndex = Math.min(filteredSessions.length - 1, prev + 1);

          if (
            !centerSelection &&
            newIndex >= followScrollOffset + maxVisibleItems
          ) {
            setFollowScrollOffset(newIndex - maxVisibleItems + 1);
          }

          // Follow mode: load more when near the end.
          if (!centerSelection && newIndex >= filteredSessions.length - 3) {
            void loadMoreSessions();
          }

          return newIndex;
        });
        return;
      }

      if (sequence === 'b' || sequence === 'B') {
        if (currentBranch) {
          setFilterByBranch((prev) => !prev);
        }
      }
    },
    { isActive },
  );

  return {
    selectedIndex,
    sessionState,
    filteredSessions,
    filterByBranch,
    isLoading,
    scrollOffset,
    visibleSessions,
    showScrollUp,
    showScrollDown,
    loadMoreSessions,
  };
}
