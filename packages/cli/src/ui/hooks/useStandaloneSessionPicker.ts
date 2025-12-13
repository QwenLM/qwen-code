/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session picker hook for standalone mode (fullscreen CLI picker).
 * Uses useInput (ink) instead of useKeypress (KeypressContext).
 * For dialog mode within the main app, use useDialogSessionPicker instead.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useInput } from 'ink';
import type {
  SessionService,
  SessionListItem,
  ListSessionsResult,
} from '@qwen-code/qwen-code-core';
import {
  SESSION_PAGE_SIZE,
  filterSessions,
  type SessionState,
} from '../utils/sessionPickerUtils.js';

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
   * Optional callback when exiting (for standalone mode).
   */
  onExit?: () => void;
  /**
   * Enable/disable input handling.
   */
  isActive?: boolean;
}

export interface UseSessionPickerResult {
  // State
  selectedIndex: number;
  sessionState: SessionState;
  filteredSessions: SessionListItem[];
  filterByBranch: boolean;
  isLoading: boolean;
  scrollOffset: number;
  visibleSessions: SessionListItem[];
  showScrollUp: boolean;
  showScrollDown: boolean;

  // Actions
  loadMoreSessions: () => Promise<void>;
}

export function useSessionPicker({
  sessionService,
  currentBranch,
  onSelect,
  onCancel,
  maxVisibleItems,
  centerSelection = false,
  onExit,
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

  // Filter sessions
  const filteredSessions = filterSessions(
    sessionState.sessions,
    filterByBranch,
    currentBranch,
  );

  // Calculate scroll offset based on mode
  const scrollOffset = centerSelection
    ? (() => {
        if (filteredSessions.length <= maxVisibleItems) {
          return 0;
        }
        const halfVisible = Math.floor(maxVisibleItems / 2);
        let offset = selectedIndex - halfVisible;
        offset = Math.max(0, offset);
        offset = Math.min(filteredSessions.length - maxVisibleItems, offset);
        return offset;
      })()
    : followScrollOffset;

  const visibleSessions = filteredSessions.slice(
    scrollOffset,
    scrollOffset + maxVisibleItems,
  );
  const showScrollUp = scrollOffset > 0;
  const showScrollDown =
    scrollOffset + maxVisibleItems < filteredSessions.length;

  // Load initial sessions
  useEffect(() => {
    // Guard: don't load if sessionService is not ready
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
    loadInitialSessions();
  }, [sessionService]);

  // Load more sessions
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

  // Auto-load more when list is empty or near end (for centered mode)
  useEffect(() => {
    // Don't auto-load during initial load or if not in centered mode
    if (
      isLoading ||
      !sessionState.hasMore ||
      isLoadingMoreRef.current ||
      !centerSelection
    ) {
      return;
    }

    const sentinelVisible =
      sessionState.hasMore &&
      scrollOffset + maxVisibleItems >= filteredSessions.length;
    const shouldLoadMore = filteredSessions.length === 0 || sentinelVisible;

    if (shouldLoadMore) {
      void loadMoreSessions();
    }
  }, [
    isLoading,
    filteredSessions.length,
    loadMoreSessions,
    sessionState.hasMore,
    scrollOffset,
    maxVisibleItems,
    centerSelection,
  ]);

  // Handle keyboard input
  useInput(
    (input, key) => {
      // Escape or Ctrl+C to cancel
      if (key.escape || (key.ctrl && input === 'c')) {
        onCancel();
        onExit?.();
        return;
      }

      // Enter to select
      if (key.return) {
        const session = filteredSessions[selectedIndex];
        if (session) {
          onSelect(session.sessionId);
          onExit?.();
        }
        return;
      }

      // Navigation up
      if (key.upArrow || input === 'k') {
        setSelectedIndex((prev) => {
          const newIndex = Math.max(0, prev - 1);
          // Adjust scroll offset if needed (for follow mode)
          if (!centerSelection && newIndex < followScrollOffset) {
            setFollowScrollOffset(newIndex);
          }
          return newIndex;
        });
        return;
      }

      // Navigation down
      if (key.downArrow || input === 'j') {
        if (filteredSessions.length === 0) {
          return;
        }

        setSelectedIndex((prev) => {
          const newIndex = Math.min(filteredSessions.length - 1, prev + 1);
          // Adjust scroll offset if needed (for follow mode)
          if (
            !centerSelection &&
            newIndex >= followScrollOffset + maxVisibleItems
          ) {
            setFollowScrollOffset(newIndex - maxVisibleItems + 1);
          }
          // Load more if near the end
          if (newIndex >= filteredSessions.length - 3 && sessionState.hasMore) {
            loadMoreSessions();
          }
          return newIndex;
        });
        return;
      }

      // Toggle branch filter
      if (input === 'b' || input === 'B') {
        if (currentBranch) {
          setFilterByBranch((prev) => !prev);
        }
        return;
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
