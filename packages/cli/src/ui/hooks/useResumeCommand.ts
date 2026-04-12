/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import {
  SessionService,
  type Config,
  type SessionListItem,
  SessionStartSource,
  type PermissionMode,
} from '@qwen-code/qwen-code-core';
import { buildResumedHistoryItems } from '../utils/resumeHistoryUtils.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';

export interface UseResumeCommandOptions {
  config: Config | null;
  historyManager: Pick<UseHistoryManagerReturn, 'clearItems' | 'loadHistory'>;
  startNewSession: (sessionId: string) => void;
  setSessionName?: (name: string | null) => void;
  remount?: () => void;
}

export interface UseResumeCommandResult {
  isResumeDialogOpen: boolean;
  /** Pre-filtered sessions for the picker (when multiple title matches). */
  resumeMatchedSessions: SessionListItem[] | undefined;
  openResumeDialog: (matchedSessions?: SessionListItem[]) => void;
  closeResumeDialog: () => void;
  handleResume: (sessionId: string) => void;
}

export function useResumeCommand(
  options?: UseResumeCommandOptions,
): UseResumeCommandResult {
  const [isResumeDialogOpen, setIsResumeDialogOpen] = useState(false);
  const [resumeMatchedSessions, setResumeMatchedSessions] = useState<
    SessionListItem[] | undefined
  >();

  const openResumeDialog = useCallback(
    (matchedSessions?: SessionListItem[]) => {
      setResumeMatchedSessions(matchedSessions);
      setIsResumeDialogOpen(true);
    },
    [],
  );

  const closeResumeDialog = useCallback(() => {
    setIsResumeDialogOpen(false);
    setResumeMatchedSessions(undefined);
  }, []);

  const { config, historyManager, startNewSession, setSessionName, remount } =
    options ?? {};

  const handleResume = useCallback(
    async (sessionId: string) => {
      if (!config || !historyManager || !startNewSession) {
        return;
      }

      // Close dialog immediately to prevent input capture during async operations.
      closeResumeDialog();

      const cwd = config.getTargetDir();
      const sessionService = new SessionService(cwd);
      const sessionData = await sessionService.loadSession(sessionId);

      if (!sessionData) {
        return;
      }

      // Start new session in UI context.
      startNewSession(sessionId);

      // Restore session name tag from custom title.
      const customTitle = sessionService.getSessionTitle(sessionId);
      setSessionName?.(customTitle ?? null);

      // Reset UI history.
      const uiHistoryItems = buildResumedHistoryItems(sessionData, config);
      historyManager.clearItems();
      historyManager.loadHistory(uiHistoryItems);

      // Update session history core.
      config.startNewSession(sessionId, sessionData);
      await config.getGeminiClient()?.initialize?.();

      // Fire SessionStart event after resuming session
      try {
        await config
          .getHookSystem()
          ?.fireSessionStartEvent(
            SessionStartSource.Resume,
            config.getModel() ?? '',
            String(config.getApprovalMode()) as PermissionMode,
          );
      } catch (err) {
        config.getDebugLogger().warn(`SessionStart hook failed: ${err}`);
      }

      // Refresh terminal UI.
      remount?.();
    },
    [
      closeResumeDialog,
      config,
      historyManager,
      startNewSession,
      setSessionName,
      remount,
    ],
  );

  return {
    isResumeDialogOpen,
    resumeMatchedSessions,
    openResumeDialog,
    closeResumeDialog,
    handleResume,
  };
}
