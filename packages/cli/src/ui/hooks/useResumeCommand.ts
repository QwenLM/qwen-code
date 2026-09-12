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
import {
  isManagedAgentViewResumeBlocked,
  MANAGED_AGENT_VIEW_RESUME_MESSAGE,
} from '../../startup/agent-view-resume-guard.js';

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

      // Open the telemetry swap transaction BEFORE touching the outgoing
      // session. Opening takes the session-switch latch and captures the
      // outgoing session for the undo snapshot; see the lifetime contract
      // in beginTelemetrySwap's JSDoc in core client.ts (#9833, #9844).
      // A false return means another /resume or /branch already holds the
      // single swap slot — reject instead of entangling; the in-flight swap
      // settles the slot itself. Opening before the outgoing-session
      // capture and the incoming loadSession await also means a failure of
      // that pre-swap work can never settle a transaction this attempt did
      // not open.
      let swapOpened = false;
      const telemetrySwapOpened =
        config.getLlmClient()?.beginTelemetrySwap?.() ?? true;
      if (!telemetrySwapOpened) {
        addItem(
          {
            type: MessageType.ERROR,
            text: 'A session switch is already in progress. Try again in a moment.',
          } as HistoryItemWithoutId,
          Date.now(),
        );
        return;
      }
      swapOpened = true;

      // Capture the outgoing session under the latch: before this point a
      // concurrent picker swap could still roll back and change the session
      // the user is on, and rolling back against that stale id would land
      // on a session the UI never shows (#9844).
      const oldSessionId = config.getSessionId();
      let coreSwapped = false;
      let uiSwapped = false;
      let recoveredBackgroundAgentsNotice: string | null = null;

      try {
        if (await isManagedAgentViewResumeBlocked(sessionId)) {
          addItem(
            {
              type: MessageType.ERROR,
              text: MANAGED_AGENT_VIEW_RESUME_MESSAGE,
            } as HistoryItemWithoutId,
            Date.now(),
          );
          config.getLlmClient()?.commitTelemetrySwap?.();
          return;
        }

        const cwd = config.getTargetDir();
        const sessionService = new SessionService(cwd);
        const sessionData = await sessionService.loadSession(sessionId);

        if (!sessionData) {
          // Close the transaction this attempt opened; nothing was replayed.
          // Forgetting this would leave the single slot occupied and every
          // later swap rejected (#9844).
          config.getLlmClient()?.commitTelemetrySwap?.();
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

        // 1. Swap core first. Matches useBranchCommand's core-before-UI
        //    pattern: if anything fails between core swap and UI swap,
        //    the catch block rolls core back to the old session so the
        //    user is not stranded with a half-live client. The transaction
        //    opened above covers the initialize() replay (#9833; see
        //    beginTelemetrySwap's JSDoc in core client.ts).
        resetBackgroundStateForSessionSwitch(config);
        config.startNewSession(sessionId, sessionData);
        coreSwapped = true;
        await waitForGoalRuntime(config);
        // Rebuild turn boundary tracking so rewind works within resumed sessions.
        config
          .getChatRecordingService()
          ?.rebuildTurnBoundaries(sessionData.conversation.messages);
        await config.getLlmClient()?.initialize?.();

        const recovered = await config.loadPausedBackgroundAgents(sessionId);
        if (recovered.length > 0) {
          recoveredBackgroundAgentsNotice = config
            .getBackgroundAgentResumeService()
            .buildRecoveredBackgroundAgentsNotice(recovered.length);
        }

        // 2. Swap UI. Once this commits, rolling core back is unsafe —
        //    it would leave UI on the resumed session but recorder writing
        //    into the old JSONL (split-brain). The commit point is the
        //    stats-provider re-key itself: from here on a failure must not
        //    roll core back OR undo the telemetry replay — the re-keyed
        //    display would read the abandoned session's dropped bucket as
        //    zeros, and core would be split-brained against the UI key.
        //    The remaining steps (name, history items, notice) are display
        //    state for a swap that has already committed.
        startNewSession(sessionId);
        uiSwapped = true;
        config.getLlmClient()?.commitTelemetrySwap?.();
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
            // Best-effort snapshot of the old session's persisted state so
            // the re-initialize below re-hydrates the chat history from its
            // replay branch. undefined still rolls back sessionId +
            // recorder (the load-bearing invariant); the re-initialize then
            // starts an empty chat on the old session — still safer than
            // leaving the client on the abandoned session's replayed
            // history.
            let prevSessionData: ResumedSessionData | undefined;
            try {
              prevSessionData = await new SessionService(
                config.getTargetDir(),
              ).loadSession(oldSessionId);
            } catch {
              // Best-effort — see above.
            }
            config.startNewSession(oldSessionId, prevSessionData);
            // Re-hydrate the client against the restored session, mirroring
            // /branch's rollback: without it the client's chat stays on the
            // abandoned session's replayed history, and the abort below
            // clears initializedSessionId (it names the abandoned session) —
            // a same-session /resume of the old session would then skip
            // initialize()'s early return, whose replay wipes the old
            // session's live bucket (skill invocations are never persisted)
            // and re-adds its stored telemetry on top of the aggregate that
            // already contains it (#9844 review). Best-effort: if this
            // throws too, sessionId + recorder are still back on the old
            // session, which is the load-bearing invariant.
            await config.getLlmClient()?.initialize?.();
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
          // Core is back on the old session: put the usage aggregate (and
          // the two affected session buckets) back to pre-swap state,
          // dropping the abandoned session's replayed history. Must run
          // AFTER the rollback's re-initialize above — that re-initialize
          // replays the old session's history on top of the abandoned
          // session's replay, and restore overwrites rather than subtracts,
          // so the final state is exactly pre-swap (#9833).
          config.getLlmClient()?.abortTelemetrySwap?.();
        } else if (swapOpened) {
          // Either the core swap never happened (nothing was replayed — the
          // transaction is unarmed) or the UI already committed (the replay
          // belongs to the session the user is on): close THIS attempt's
          // transaction without restoring. Never settle a transaction this
          // attempt did not open — the shared slot may hold a different
          // in-flight swap (#9844). See beginTelemetrySwap's JSDoc in core
          // client.ts.
          config.getLlmClient()?.commitTelemetrySwap?.();
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
