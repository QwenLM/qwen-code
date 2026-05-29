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
} from '@qwen-code/qwen-code-core';
import {
  buildResumedHistoryItems,
  applyCollapsePolicyAndSummary,
} from '../utils/resumeHistoryUtils.js';
import { restoreGoalFromHistory } from '../utils/restoreGoal.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import {
  hasBlockingBackgroundWork,
  resetBackgroundStateForSessionSwitch,
} from '../utils/backgroundWorkUtils.js';
import type { LoadedSettings } from '../../config/settings.js';

export interface UseResumeCommandOptions {
  config: Config | null;
  settings: LoadedSettings;
  historyManager: Pick<
    UseHistoryManagerReturn,
    'addItem' | 'clearItems' | 'loadHistory'
  >;
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
  /**
   * Async — the implementation awaits SessionService and SessionStart hooks.
   * Callers that need to chain post-resume work should `await` it; pure
   * fire-and-forget callers (the resume dialog's `onSelect`) can ignore the
   * promise.
   */
  handleResume: (sessionId: string) => Promise<void>;
}

const BACKGROUND_WORK_SWITCH_BLOCKED_MESSAGE =
  "Stop the current session's running background tasks before resuming another session.";

export function useResumeCommand(
  options: UseResumeCommandOptions,
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

  const {
    config,
    settings,
    historyManager,
    startNewSession,
    setSessionName,
    remount,
  } = options;

  const { addItem, clearItems, loadHistory } = historyManager;
  const handleResume = useCallback(
    async (sessionId: string) => {
      if (!config || !startNewSession) {
        return;
      }

      if (hasBlockingBackgroundWork(config)) {
        const blockedMessage: HistoryItemWithoutId = {
          type: MessageType.ERROR,
          text: BACKGROUND_WORK_SWITCH_BLOCKED_MESSAGE,
        };
        addItem?.(blockedMessage, Date.now());
        closeResumeDialog();
        return;
      }

      // Close dialog immediately to prevent input capture during async operations.
      closeResumeDialog();

      try {
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
        const rawItems = buildResumedHistoryItems(sessionData, config);
        const collapseOnResume =
          settings.merged.ui?.history?.collapseOnResume ?? false;

        const uiHistoryItems = applyCollapsePolicyAndSummary(
          rawItems,
          collapseOnResume,
        );

        clearItems?.();
        loadHistory?.(uiHistoryItems);

        // Update session history core.
        resetBackgroundStateForSessionSwitch(config);
        config.startNewSession(sessionId, sessionData);
        // Re-arm /goal: the in-memory activeGoalStore entry (if any) is stale
        // after `config.startNewSession` rebuilds the hook system — its
        // `setAt` was captured before /new, and its `hookId` points to a
        // hook that no longer exists. The cold-boot path runs this same
        // call in AppContainer; the runtime /resume path needs it too,
        // otherwise the footer pill keeps ticking from the original setAt
        // (visible as "几十秒" elapsed immediately after /new + /resume) and
        // the Stop hook is silently dead until the user re-issues /goal.
        try {
          if (addItem) restoreGoalFromHistory(uiHistoryItems, config, addItem);
        } catch {
          // Best-effort — never block resume on goal restoration.
        }
        // Rebuild turn boundary tracking so rewind works within resumed sessions.
        config
          .getChatRecordingService()
          ?.rebuildTurnBoundaries(sessionData.conversation.messages);
        await config.getGeminiClient()?.initialize?.();

        const recovered = await config.loadPausedBackgroundAgents(sessionId);
        if (recovered.length > 0) {
          const recoveredMessage: HistoryItemWithoutId = {
            type: MessageType.INFO,
            text: config
              .getBackgroundAgentResumeService()
              .buildRecoveredBackgroundAgentsNotice(recovered.length),
          };
          addItem?.(recoveredMessage, Date.now());
        }

        // SessionStart hook is handled during chat initialization so its
        // additionalContext can be injected into the resumed model context.

        // Refresh terminal UI.
        remount?.();
      } catch (error) {
        addItem?.(
          {
            type: MessageType.ERROR,
            text: `Failed to resume session: ${error instanceof Error ? error.message : String(error)}`,
          } as HistoryItemWithoutId,
          Date.now(),
        );
        closeResumeDialog();
        remount?.();
      }
    },
    [
      closeResumeDialog,
      config,
      addItem,
      clearItems,
      loadHistory,
      startNewSession,
      setSessionName,
      remount,
      settings.merged.ui?.history?.collapseOnResume,
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

export { BACKGROUND_WORK_SWITCH_BLOCKED_MESSAGE };
