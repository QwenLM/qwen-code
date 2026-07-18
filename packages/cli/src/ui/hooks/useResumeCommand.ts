/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import {
  buildSessionRecoveryPlan,
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
      if (!config) {
        return;
      }

      if (sessionId === config.getSessionId?.()) {
        closeResumeDialog();
        return;
      }

      if (hasBlockingBackgroundWork(config)) {
        const blockedMessage: HistoryItemWithoutId = {
          type: MessageType.ERROR,
          text: BACKGROUND_WORK_SWITCH_BLOCKED_MESSAGE,
        };
        addItem(blockedMessage, Date.now());
        closeResumeDialog();
        return;
      }

      // Close dialog immediately to prevent input capture during async operations.
      closeResumeDialog();

      try {
        const hadUnpersistedRecording =
          config.getChatRecordingService?.()?.hasWriteFailure?.() ?? false;
        const sessionService = config.getSessionService();
        const sessionData = await sessionService.loadSession(sessionId);

        if (!sessionData) {
          return;
        }

        if (hasBlockingBackgroundWork(config)) {
          addItem(
            {
              type: MessageType.ERROR,
              text: BACKGROUND_WORK_SWITCH_BLOCKED_MESSAGE,
            },
            Date.now(),
          );
          return;
        }

        const transition = await config.prepareSessionTransition(
          sessionId,
          sessionData,
        );
        try {
          const authoritativeSessionData = transition.sessionData;
          if (!authoritativeSessionData) {
            await transition.rollback();
            throw new Error('Failed to load session under write ownership');
          }

          const customTitle = config
            .getChatRecordingService()
            ?.getCurrentCustomTitle();
          const recoveryPlan = buildSessionRecoveryPlan({
            sessionId,
            conversation: authoritativeSessionData.conversation,
            historyGaps: authoritativeSessionData.historyGaps,
          });
          const rawItems = buildResumedHistoryItems(
            authoritativeSessionData,
            config,
          );
          const collapseOnResume =
            settings.merged.ui?.history?.collapseOnResume ?? false;
          const collapsePreviewCount =
            settings.merged.ui?.history?.collapsePreviewCount ?? 0;

          const uiHistoryItems = applyCollapsePolicyAndSummary(
            rawItems,
            collapseOnResume,
            collapsePreviewCount,
          );
          if (hadUnpersistedRecording) {
            uiHistoryItems.push({
              id: (uiHistoryItems.at(-1)?.id ?? 0) + 1,
              type: MessageType.INFO,
              text: 'The previous session had changes that could not be saved to its transcript.',
            });
          }
          if (
            recoveryPlan.kind !== 'clean' &&
            recoveryPlan.kind !== 'degraded_history' &&
            recoveryPlan.visibleNotice
          ) {
            const nextId = (uiHistoryItems.at(-1)?.id ?? 0) + 1;
            uiHistoryItems.push({
              id: nextId,
              type: MessageType.INFO,
              text: recoveryPlan.visibleNotice,
            });
          }

          await transition.commit(() => {
            startNewSession(sessionId);
            setSessionName?.(customTitle ?? null);
            clearItems();
            loadHistory(uiHistoryItems);
          });
          try {
            restoreGoalFromHistory(uiHistoryItems, config, addItem);
          } catch {
            // Best-effort — never block resume on goal restoration.
          }
        } catch (error) {
          await transition.rollback();
          throw error;
        }

        try {
          resetBackgroundStateForSessionSwitch(config);
        } catch (error) {
          config
            .getDebugLogger()
            .warn(
              `Failed to reset background state after session resume: ${error}`,
            );
        }

        try {
          const recovered = await config.loadPausedBackgroundAgents(sessionId);
          if (recovered.length > 0) {
            addItem(
              {
                type: MessageType.INFO,
                text: config
                  .getBackgroundAgentResumeService()
                  .buildRecoveredBackgroundAgentsNotice(recovered.length),
              },
              Date.now(),
            );
          }
        } catch (error) {
          config
            .getDebugLogger()
            .warn(`Failed to restore paused background agents: ${error}`);
        }

        // SessionStart hook is handled during chat initialization so its
        // additionalContext can be injected into the resumed model context.

        // Refresh terminal UI.
        remount?.();
      } catch (error) {
        addItem(
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
      settings.merged.ui?.history?.collapsePreviewCount,
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
