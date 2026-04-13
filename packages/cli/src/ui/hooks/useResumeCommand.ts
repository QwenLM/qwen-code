/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import {
  SessionService,
  type Config,
  SessionStartSource,
  type PermissionMode,
} from '@qwen-code/qwen-code-core';
import { buildResumedHistoryItems } from '../utils/resumeHistoryUtils.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';

export interface UseResumeCommandOptions {
  config: Config | null;
  historyManager: Pick<UseHistoryManagerReturn, 'clearItems' | 'loadHistory'>;
  startNewSession: (sessionId: string) => void;
  remount?: () => void;
}

export interface UseResumeCommandResult {
  isResumeDialogOpen: boolean;
  openResumeDialog: () => void;
  closeResumeDialog: () => void;
  /**
   * Resumes a session by ID. Returns true if the session was actually
   * loaded and applied; false if the call short-circuited (missing config,
   * loadSession returned no data, etc.). Callers that want to know whether
   * the resume succeeded — e.g., the welcome-back fallback — must check
   * the return value.
   */
  handleResume: (sessionId: string) => Promise<boolean>;
}

export function useResumeCommand(
  options?: UseResumeCommandOptions,
): UseResumeCommandResult {
  const [isResumeDialogOpen, setIsResumeDialogOpen] = useState(false);

  const openResumeDialog = useCallback(() => {
    setIsResumeDialogOpen(true);
  }, []);

  const closeResumeDialog = useCallback(() => {
    setIsResumeDialogOpen(false);
  }, []);

  const { config, historyManager, startNewSession, remount } = options ?? {};

  const handleResume = useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (!config || !historyManager || !startNewSession) {
        return false;
      }

      // Close dialog immediately to prevent input capture during async operations.
      closeResumeDialog();

      const cwd = config.getTargetDir();
      const sessionService = new SessionService(cwd);
      const sessionData = await sessionService.loadSession(sessionId);

      if (!sessionData) {
        return false;
      }

      // Start new session in UI context.
      startNewSession(sessionId);

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
      return true;
    },
    [closeResumeDialog, config, historyManager, startNewSession, remount],
  );

  return {
    isResumeDialogOpen,
    openResumeDialog,
    closeResumeDialog,
    handleResume,
  };
}
