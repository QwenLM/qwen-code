/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import {
  SessionService,
  buildSessionRecoveryPlan,
  type Config,
  type ResumedSessionData,
  type SessionListItem,
} from '@qwen-code/qwen-code-core';
import {
  buildResumedHistoryItems,
  applyCollapsePolicyAndSummary,
} from '../utils/resumeHistoryUtils.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import {
  hasBlockingBackgroundWork,
  buildBackgroundWorkBlockedMessage,
  resetBackgroundStateForSessionSwitch,
} from '../utils/backgroundWorkUtils.js';
import type { LoadedSettings } from '../../config/settings.js';
import { waitForGoalRuntime } from '../utils/goal-runtime.js';

export interface UseResumeCommandOptions {
  config: Config | null;
  settings: LoadedSettings;
  historyManager: Pick<
    UseHistoryManagerReturn,
    'addItem' | 'clearItems' | 'loadHistory'
  >;
  /**
   * Optional override for history replacement. AppContainer passes a
   * latch-reconciling wrapper here so same-id resume (which changes no
   * sessionId the re-arm effect could observe) still reconciles the
   * context-files announcement latch. Defaults to historyManager.loadHistory.
   */
  loadHistory?: UseHistoryManagerReturn['loadHistory'];
  startNewSession: (sessionId: string) => void;
  clearPendingState?: () => void;
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
    loadHistory: loadHistoryOverride,
    startNewSession,
    clearPendingState,
    setSessionName,
    remount,
  } = options;

  const { addItem, clearItems } = historyManager;
  const loadHistory = loadHistoryOverride ?? historyManager.loadHistory;
  const handleResume = useCallback(
    async (sessionId: string) => {
      if (!config) {
        return;
      }

      if (hasBlockingBackgroundWork(config)) {
        const blockedMessage: HistoryItemWithoutId = {
          type: MessageType.ERROR,
          text: buildBackgroundWorkBlockedMessage(
            config,
            BACKGROUND_WORK_SWITCH_BLOCKED_MESSAGE,
          ),
        };
        addItem(blockedMessage, Date.now());
        closeResumeDialog();
        return;
      }

      // Close dialog immediately to prevent input capture during async operations.
      closeResumeDialog();

      const oldSessionId = config.getSessionId();
      let coreSwapped = false;
      let uiSwapped = false;
      let clientInitializationAttempted = false;
      let prevSessionData: ResumedSessionData | undefined;
      // The incoming session's stored telemetry is replayed by the client's
      // `initialize()` below, straight into the process-wide usage aggregate.
      // The service has no subtraction API, so a resume abandoned after that
      // point would leave the whole abandoned history in the aggregate that
      // `persistSessionUsage` writes out. The client holds the snapshot and
      // restores it on the rollback path below.
      let recoveredBackgroundAgentsNotice: string | null = null;

      try {
        const cwd = config.getTargetDir();
        const sessionService = new SessionService(cwd);
        const sessionData = await sessionService.loadSession(sessionId);

        if (!sessionData) {
          return;
        }

        // Restore session name tag from custom title.
        const customTitle = sessionService.getSessionTitle(sessionId);

        // Build UI history items.
        const recoveryPlan = buildSessionRecoveryPlan({
          sessionId,
          conversation: sessionData.conversation,
          historyGaps: sessionData.historyGaps,
        });
        const rawItems = buildResumedHistoryItems(sessionData, config);
        const collapseOnResume =
          settings.merged.ui?.history?.collapseOnResume ?? false;
        const collapsePreviewCount =
          settings.merged.ui?.history?.collapsePreviewCount ?? 0;

        const uiHistoryItems = applyCollapsePolicyAndSummary(
          rawItems,
          collapseOnResume,
          collapsePreviewCount,
        );
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

        // Snapshot the old session for the rollback's re-initialize,
        // mirroring useBranchCommand: finalize + flush the outgoing recorder
        // first so the load sees the live session's trailing records.
        // Best-effort — without it the rollback still restores sessionId and
        // recorder, but the re-initialize restarts the old session blank.
        const outgoingRecording = config.getChatRecordingService();
        outgoingRecording?.finalize();
        await outgoingRecording?.flush();
        try {
          prevSessionData = await sessionService.loadSession(oldSessionId);
        } catch {
          // Best-effort snapshot (see above).
        }

        // 1. Swap core first. Matches useBranchCommand's core-before-UI
        //    pattern: if anything fails between core swap and UI swap,
        //    the catch block rolls core back to the old session so the
        //    user is not stranded with a half-live client.
        // Settle any undo armed by a replay outside a swap — e.g. the
        // startup `qwen --resume` replay — first: that replay now belongs to
        // the session the user is on, and leaving it pending would block the
        // forward initialize's own snapshot and make this swap's failure
        // restore a pre-startup state, wiping all usage accrued since.
        config.getGeminiClient()?.settleTelemetryReplay?.();
        resetBackgroundStateForSessionSwitch(config);
        config.startNewSession(sessionId, sessionData);
        coreSwapped = true;
        await waitForGoalRuntime(config);
        // Rebuild turn boundary tracking so rewind works within resumed sessions.
        config
          .getChatRecordingService()
          ?.rebuildTurnBoundaries(sessionData.conversation.messages);
        clientInitializationAttempted = true;
        await config.getGeminiClient()?.initialize?.();

        const recovered = await config.loadPausedBackgroundAgents(sessionId);
        if (recovered.length > 0) {
          recoveredBackgroundAgentsNotice = config
            .getBackgroundAgentResumeService()
            .buildRecoveredBackgroundAgentsNotice(recovered.length);
        }

        // 2. Swap UI. Once this commits, rolling core back is unsafe —
        //    it would leave UI on the resumed session but recorder writing
        //    into the old JSONL (split-brain).
        startNewSession(sessionId);
        setSessionName?.(customTitle ?? null);
        clearPendingState?.();
        clearItems();
        loadHistory(uiHistoryItems);
        if (recoveredBackgroundAgentsNotice) {
          addItem(
            {
              type: MessageType.INFO,
              text: recoveredBackgroundAgentsNotice,
            },
            Date.now(),
          );
        }
        uiSwapped = true;
        // The swap committed; the replayed history belongs to the session the
        // user is now on. Drop the undo.
        config.getGeminiClient()?.settleTelemetryReplay?.();

        // SessionStart hook is handled during chat initialization so its
        // additionalContext can be injected into the resumed model context.

        // Refresh terminal UI.
        remount?.();
      } catch (error) {
        if (coreSwapped && !uiSwapped) {
          // Core switched to the resumed session but UI hasn't swapped
          // yet — put core back on the old session, otherwise the
          // recorder would keep writing new user messages into the
          // orphaned session JSONL while UI still shows the old session.
          try {
            resetBackgroundStateForSessionSwitch(config);
            config.startNewSession(oldSessionId, prevSessionData);
            if (clientInitializationAttempted) {
              await config.getGeminiClient()?.initialize?.();
            }
            // The forward path cleared the old session's in-memory
            // background agents (resetBackgroundStateForSessionSwitch above,
            // ~L158) before swapping core. After rolling core back to the old
            // session, reload them so `list_agents` reflects the old session's
            // still-on-disk sidecars again; otherwise the user lands back on
            // the old session with an empty roster until the next process
            // start or successful /resume. Best-effort — the guard inside
            // loadPausedBackgroundAgents requires the session to already be
            // current, which the startNewSession above satisfies.
            await config
              .loadPausedBackgroundAgents(oldSessionId)
              .catch(() => {});
          } catch (rollbackErr) {
            config
              .getDebugLogger()
              .warn(
                `Rollback after failed /resume init failed: ${rollbackErr}`,
              );
          }
          // Undo after the rollback re-initializes: that initialize can
          // replay the old session, and undoing first would leave the
          // duplicate it adds in the aggregate.
          config.getGeminiClient()?.undoTelemetryReplay?.();
          // Re-key the stats display back to the old session: the forward
          // path may already have keyed it to the incoming session, and
          // SessionStatsProvider seeds its session id once — left on the
          // abandoned session, every usage display reads a bucket the undo
          // just removed and renders zeros until the next successful swap.
          startNewSession(oldSessionId);
        }
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
      clearPendingState,
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
