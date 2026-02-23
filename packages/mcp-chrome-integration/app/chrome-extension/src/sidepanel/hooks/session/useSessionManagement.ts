/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo } from 'react';
import type { VSCodeAPI } from '../../hooks/useVSCode.js';

/**
 * Session management Hook
 * Manages session list, current session, session switching, and search
 */
export const useSessionManagement = (vscode: VSCodeAPI) => {
  const [qwenSessions, setQwenSessions] = useState<
    Array<Record<string, unknown>>
  >([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentSessionTitle, setCurrentSessionTitle] =
    useState<string>('Past Conversations');
  const [showSessionSelector, setShowSessionSelector] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [savedSessionTags, setSavedSessionTags] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<number | undefined>(undefined);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const PAGE_SIZE = 20;

  /**
   * Filter session list
   */
  const filteredSessions = useMemo(() => {
    if (!sessionSearchQuery.trim()) {
      return qwenSessions;
    }
    const query = sessionSearchQuery.toLowerCase();
    return qwenSessions.filter((session) => {
      const title = (
        (session.title as string) ||
        (session.name as string) ||
        ''
      ).toLowerCase();
      return title.includes(query);
    });
  }, [qwenSessions, sessionSearchQuery]);

  /**
   * Load session list
   */
  const handleLoadQwenSessions = useCallback(() => {
    // Reset pagination state and load first page
    setQwenSessions([]);
    setNextCursor(undefined);
    setHasMore(true);
    setIsLoading(true);
    vscode.postMessage({ type: 'getQwenSessions', data: { size: PAGE_SIZE } });
    setShowSessionSelector(true);
  }, [vscode]);

  const handleLoadMoreSessions = useCallback(() => {
    if (!hasMore || isLoading || nextCursor === undefined) {
      return;
    }
    setIsLoading(true);
    vscode.postMessage({
      type: 'getQwenSessions',
      data: { cursor: nextCursor, size: PAGE_SIZE },
    });
  }, [hasMore, isLoading, nextCursor, vscode]);

  /**
   * Create new session
   */
  const handleNewQwenSession = useCallback(() => {
    vscode.postMessage({ type: 'openNewChatTab', data: {} });
    setShowSessionSelector(false);
  }, [vscode]);

  /**
   * Switch session
   */
  const handleSwitchSession = useCallback(
    (sessionId: string) => {
      if (sessionId === currentSessionId) {
        console.log('[useSessionManagement] Already on this session, ignoring');
        setShowSessionSelector(false);
        return;
      }

      console.log('[useSessionManagement] Switching to session:', sessionId);
      vscode.postMessage({
        type: 'switchQwenSession',
        data: { sessionId },
      });
    },
    [currentSessionId, vscode],
  );

  /**
   * Save session
   */
  const handleSaveSession = useCallback(
    (tag: string) => {
      vscode.postMessage({
        type: 'saveSession',
        data: { tag },
      });
    },
    [vscode],
  );

  /**
   * Handle Save session response
   */
  const handleSaveSessionResponse = useCallback(
    (response: { success: boolean; message?: string }) => {
      if (response.success) {
        if (response.message) {
          const tagMatch = response.message.match(/tag: (.+)$/);
          if (tagMatch) {
            setSavedSessionTags((prev) => [...prev, tagMatch[1]]);
          }
        }
      } else {
        console.error('Failed to save session:', response.message);
      }
    },
    [],
  );

  return {
    // State
    qwenSessions,
    currentSessionId,
    currentSessionTitle,
    showSessionSelector,
    sessionSearchQuery,
    filteredSessions,
    savedSessionTags,
    nextCursor,
    hasMore,
    isLoading,

    // State setters
    setQwenSessions,
    setCurrentSessionId,
    setCurrentSessionTitle,
    setShowSessionSelector,
    setSessionSearchQuery,
    setSavedSessionTags,
    setNextCursor,
    setHasMore,
    setIsLoading,

    // Operations
    handleLoadQwenSessions,
    handleNewQwenSession,
    handleSwitchSession,
    handleSaveSession,
    handleSaveSessionResponse,
    handleLoadMoreSessions,
  };
};
