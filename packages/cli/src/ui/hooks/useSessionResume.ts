/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  coreEvents,
  type Config,
  type SessionResumeData,
  type Message,
  uiTelemetryService,
  SessionEndReason,
  runLogger,
  createSessionResumeWriterBinding,
  getResumeArtifactWorktreeStates,
  toTranscriptWorktreeSession,
} from '@qwen-code/core';
import type { HistoryItemWithoutId } from '../types.js';
import type { ReplaceMessagesFn } from './localSession.shared.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import {
  convertMessagesToHistoryFormats,
} from '../../utils/sessionUtils.js';
import {
  attachResumedSubagentTrace,
  loadResumedSubagentHistory,
  type ResumedSubagentTrace,
} from '../../utils/subagentResume.js';
import { restoreRuntimeConfigFromResumeData } from '../../utils/resumeModel.js';
import { needsProjectRebuild } from '../../interactiveProjectRuntime.js';
import {
  applyWorktreeStartupRequest,
  type WorktreeStartupRequest,
} from '../../utils/worktreeStartupRequest.js';

const WORKTREE_STARTUP_FAILURE_MESSAGE =
  'The requested worktree could not be entered. Automatic input is paused. Send a new prompt to continue in the current directory and resume queued input, or restart to retry. Resubmit the initial CLI prompt if you still want to run it.';

interface UseSessionResumeParams {
  config: Config;
  historyManager: UseHistoryManagerReturn;
  requestTranscriptReplacement: () => void;
  isRuntimeReady: boolean;
  setQuittingMessages: (messages: null) => void;
  resumedSessionData?: SessionResumeData;
  worktreeStartupRequest?: WorktreeStartupRequest;
  /** One-time startup actions (resume, worktree) wait while this is true. */
  isStartupHeld: boolean;
  replaceMessages?: ReplaceMessagesFn;
  /** Recount the installed history with the restored model and prompt context. */
  refreshContextTokenCount: () => Promise<void>;
  /**
   * Receives the resumed session's stored custom title (undefined when it has
   * none) once the runtime has switched to that session.
   */
  onResumedCustomTitle?: (title: string | undefined, sessionId: string) => void;
  onProjectResume?: ProjectResumeHandler;
  initialResumeOptions?: SessionResumeOptions;
  onInitialResumeComplete?: (success: boolean) => void | Promise<void>;
}

export type ProjectResumeHandler = (
  data: SessionResumeData,
  options: SessionResumeOptions,
) => Promise<boolean>;

export interface SessionResumeOptions {
  /** 浏览器选择会话时也必须在恢复事务内完成 Worktree 切换。 */
  worktreeStartupRequest?: WorktreeStartupRequest;
  /**
   * Fire SessionEnd(resume) for the outgoing session right before the
   * runtime switch. Only set for mid-session resume; the initial startup
   * resume has no live outgoing session to end.
   */
  endOutgoingSession?: boolean;
  initialSessionTitle?: string;
}

function logSessionResumeWarning(
  event: string,
  error: unknown,
  ...details: string[]
): void {
  try {
    runLogger.warn(event, error, ...details);
  } catch {
    // Session outcome must not depend on diagnostic logging availability.
  }
}

function emitSessionResumeFeedback(
  severity: 'warning' | 'error',
  message: string,
  error: unknown,
): void {
  try {
    coreEvents.emitFeedback(severity, message, error);
  } catch (feedbackError) {
    logSessionResumeWarning(
      '[session.resume] feedback_failed',
      feedbackError,
      `severity=${severity}`,
      `message=${message}`,
    );
  }
}

function collectVisibleToolCallIds(
  items: readonly HistoryItemWithoutId[],
): ReadonlySet<string> {
  const visibleToolCallIds = new Set<string>();

  for (const item of items) {
    if (item.type !== 'tool_group') {
      continue;
    }
    for (const tool of item.tools) {
      visibleToolCallIds.add(tool.callId);
    }
  }

  return visibleToolCallIds;
}

function summarizeMessageTypes(messages: readonly Message[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    counts.set(message.type, (counts.get(message.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => `${type}:${count}`)
    .join(',');
}

function summarizeHistoryTypes(items: readonly HistoryItemWithoutId[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => `${type}:${count}`)
    .join(',');
}

/**
 * Hook to handle session resumption logic.
 * Provides a callback to load history for resume and automatically
 * handles command-line resume on mount.
 */
export function useSessionResume({
  config,
  historyManager,
  requestTranscriptReplacement,
  isRuntimeReady,
  setQuittingMessages,
  resumedSessionData,
  worktreeStartupRequest,
  isStartupHeld,
  replaceMessages = async () => {},
  refreshContextTokenCount,
  onResumedCustomTitle,
  onProjectResume,
  initialResumeOptions,
  onInitialResumeComplete,
}: UseSessionResumeParams) {
  // 自动 Prompt/队列也会在首轮 effect 中检查此状态，不能等恢复 effect 才封锁输入。
  const [isResuming, setIsResuming] = useState(
    () => resumedSessionData !== undefined,
  );
  const [isApplyingInitialWorktree, setIsApplyingInitialWorktree] = useState(
    () =>
      worktreeStartupRequest !== undefined && resumedSessionData === undefined,
  );
  const worktreeStartupRequestRef = useRef(worktreeStartupRequest);
  const hasAppliedInitialWorktreeRequest = useRef(false);
  const [isAutomaticInputBlocked, setIsAutomaticInputBlocked] = useState(false);
  const resumeAutomaticInput = useCallback(() => {
    setIsAutomaticInputBlocked(false);
  }, []);
  const [isRestoringProject, setIsRestoringProject] = useState(
    () => onInitialResumeComplete !== undefined,
  );
  const resumeInFlightRef = useRef(false);
  // Held in a ref so an inline callback from the caller does not recreate
  // loadHistoryForResume on every render.
  const onResumedCustomTitleRef = useRef(onResumedCustomTitle);
  useEffect(() => {
    onResumedCustomTitleRef.current = onResumedCustomTitle;
  }, [onResumedCustomTitle]);

  const mergeResumedHistory = useCallback(
    (
      uiHistory: HistoryItemWithoutId[],
      resumedSubagentHistory: ResumedSubagentTrace[],
    ): HistoryItemWithoutId[] => {
      if (resumedSubagentHistory.length === 0) {
        return uiHistory;
      }

      const visibleToolCallIds = collectVisibleToolCallIds(uiHistory);

      const subagentByParentToolUseId = new Map<
        string,
        ResumedSubagentTrace[]
      >();

      for (const trace of resumedSubagentHistory) {
        if (
          !trace.parentToolUseId ||
          !visibleToolCallIds.has(trace.parentToolUseId)
        ) {
          continue;
        }

        const group = subagentByParentToolUseId.get(trace.parentToolUseId);
        if (group) {
          group.push(trace);
        } else {
          subagentByParentToolUseId.set(trace.parentToolUseId, [trace]);
        }
      }

      const merged: HistoryItemWithoutId[] = [];
      for (const item of uiHistory) {
        if (item.type !== 'tool_group') {
          merged.push(item);
          continue;
        }

        const nextTools = item.tools.map((tool) => {
          const matches = subagentByParentToolUseId.get(tool.callId);
          if (!matches) {
            return tool;
          }

          const latestTrace = matches[matches.length - 1];
          return attachResumedSubagentTrace(tool, latestTrace);
        });

        merged.push({
          ...item,
          tools: nextTools,
        });
      }

      return merged;
    },
    [],
  );

  // Use refs to avoid dependency chain that causes infinite loop
  const historyManagerRef = useRef(historyManager);
  const requestTranscriptReplacementRef = useRef(requestTranscriptReplacement);

  useEffect(() => {
    historyManagerRef.current = historyManager;
    requestTranscriptReplacementRef.current = requestTranscriptReplacement;
  });

  const loadHistoryForResume = useCallback(
    async (
      uiHistory: HistoryItemWithoutId[],
      resumedData: SessionResumeData,
      resumeOptions: SessionResumeOptions = {},
    ): Promise<boolean> => {
      if (!isRuntimeReady || resumeInFlightRef.current) {
        resumedData.resumeAttempt?.finish();
        return false;
      }

      resumeInFlightRef.current = true;
      setIsResuming(true);
      let runtimeSwitchCommitted = false;
      try {
        if (onProjectResume && needsProjectRebuild(config, resumedData)) {
          if (resumeOptions.endOutgoingSession) {
            await config
              .getHookSystem()
              ?.fireSessionEndEvent(SessionEndReason.Resume)
              .catch((error) =>
                logSessionResumeWarning(
                  '[session.resume] outgoing_session_end_failed',
                  error,
                ),
              );
          }
          return await onProjectResume(resumedData, {
            ...resumeOptions,
            worktreeStartupRequest:
              resumeOptions.worktreeStartupRequest ??
              worktreeStartupRequestRef.current,
          });
        }
        const resumeSourceSessionId =
          resumedData.sourceSessionId ?? resumedData.sessionId;
        const outgoingSessionId = config.getSessionId();
        runLogger.log(
          '[session.resume] load.start',
          `outgoing_session=${outgoingSessionId ?? 'none'}`,
          `target_session=${resumedData.sessionId}`,
          `source_session=${resumeSourceSessionId}`,
          `runtime_messages=${resumedData.messages.length}`,
          `runtime_message_types=${summarizeMessageTypes(resumedData.messages) || 'none'}`,
          `ui_history_items=${uiHistory.length}`,
          `ui_history_types=${summarizeHistoryTypes(uiHistory) || 'none'}`,
          `directories=${resumedData.directories?.length ?? 0}`,
          `file_history_snapshots=${resumedData.fileHistorySnapshots?.length ?? 0}`,
          `session_path=${resumedData.sessionPath ?? 'none'}`,
          `transcript_project_root=${resumedData.transcriptProjectRoot ?? 'none'}`,
          `project_root=${config.getProjectRoot()}`,
          `target_dir=${config.getTargetDir()}`,
        );
        uiTelemetryService.hydrateFromMessages(
          resumedData.sessionId,
          resumedData.messages,
        );

        if (resumeOptions.endOutgoingSession) {
          // The outgoing session is about to be replaced. Fire SessionEnd
          // while it is still the active session, mirroring ACP's
          // replaceSession teardown ordering.
          try {
            await config
              .getHookSystem()
              ?.fireSessionEndEvent(SessionEndReason.Resume);
          } catch (err) {
            logSessionResumeWarning(
              '[session.resume] outgoing_session_end_failed',
              err,
            );
          }
        }
        runLogger.log(
          '[session.resume] replace_messages.start',
          `target_session=${resumedData.sessionId}`,
          `runtime_messages=${resumedData.messages.length}`,
        );
        const startupWorktreeRequest = worktreeStartupRequestRef.current;
        const pendingWorktreeRequest =
          resumeOptions.worktreeStartupRequest ?? startupWorktreeRequest;
        const replaceOptions: import('./localSession.shared.js').ReplaceMessagesOptions =
          {
            restoreExistingSession: true,
            coldResume: resumedData.resumeAttempt ? { attempt: resumedData.resumeAttempt } : undefined,
            fileHistorySnapshots: resumedData.fileHistorySnapshots,
            sourceSessionId: resumedData.sourceSessionId,
            // fork transcript 由 ForkSessionService 一次写入快照；TUI resume 只恢复
            // 内存与备份，不再逐条补写。非 fork 仍按 source != target 决定。
            persistFileHistoryToTranscript:
              resumedData.forkTranscriptPath === undefined ? undefined : false,
            copyFileHistoryBackups:
              resumedData.forkTranscriptPath === undefined ? undefined : false,
            sessionPath: resumedData.sessionPath,
            setConfigSessionId: true,
            targetWorkspaceDirectories: resumedData.directories,
            transcriptProjectRoot: resumedData.transcriptProjectRoot,
            originalCwd: resumedData.originalCwd,
            worktreeSession: resumedData.worktreeSession,
          };
        const resumeBinding = createSessionResumeWriterBinding(
          resumedData,
          config.getSessionArtifactProjectRoot(),
        );
        if (resumeBinding)
          replaceOptions.resume = {
            ...resumeBinding,
            onRefresh: async (fresh, state) => {
              const commit = await resumeBinding.onRefresh(fresh, state);
              return () => {
                commit();
                replaceOptions.worktreeSession = resumedData.worktreeSession;
                replaceOptions.fileHistorySnapshots = resumedData.fileHistorySnapshots;
                uiHistory = convertMessagesToHistoryFormats(resumedData.messages).uiHistory;
              };
            },
          };
        await replaceMessages(
          resumedData.messages,
          resumedData.sessionId,
          replaceOptions,
        );
        runtimeSwitchCommitted = true;
        // 显式启动请求还可能进入另一个 checkout，先保留 Restore 推导的子目录。
        const restoredWorktreeSettings = config.getWorktreeSettings();
        onResumedCustomTitleRef.current?.(
          resumedData.customTitle,
          resumedData.sessionId,
        );
        runLogger.log(
          '[session.resume] replace_messages.done',
          `target_session=${resumedData.sessionId}`,
        );
        if (pendingWorktreeRequest) {
          try {
            await applyWorktreeStartupRequest(config, pendingWorktreeRequest);
            setIsAutomaticInputBlocked(false);
          } catch (error) {
            setIsAutomaticInputBlocked(true);
            logSessionResumeWarning(
              '[session.resume] requested_worktree_failed',
              error,
              `target_session=${resumedData.sessionId}`,
            );
            emitSessionResumeFeedback(
              'warning',
              WORKTREE_STARTUP_FAILURE_MESSAGE,
              error,
            );
          } finally {
            if (pendingWorktreeRequest === startupWorktreeRequest) {
              worktreeStartupRequestRef.current = undefined;
            }
          }
        }
        await restoreRuntimeConfigFromResumeData(config, resumedData);
        uiTelemetryService.setLastPromptTokenCount(0);
        try {
          await refreshContextTokenCount();
        } catch (error) {
          logSessionResumeWarning(
            '[session.resume] context_count_refresh_failed',
            error,
            `target_session=${resumedData.sessionId}`,
          );
        }
        if (resumeOptions.initialSessionTitle) {
          await config.persistSessionTitle(
            resumeOptions.initialSessionTitle,
          );
        }

        const resumedSubagentHistory = await loadResumedSubagentHistory(
          resumedData.worktreeSession?.originalCwd ??
            resumedData.transcriptProjectRoot ??
            config.getSessionArtifactProjectRoot(),
          resumeSourceSessionId,
          resumeSourceSessionId === resumedData.sessionId
            ? config.getActiveSessionTranscriptPath()
            : resumedData.sourceSessionPath,
        ).catch(() => [] as ResumedSubagentTrace[]);

        // Load the resumed state into the UI and runtime message chain.
        setQuittingMessages(null);
        // Bulk-load in one state update: a long resumed session can carry
        // 1000+ history items, and per-item addItem() calls would schedule
        // that many state updates (each copying the growing history array),
        // driving the CPU spike users see while a big session resumes.
        historyManagerRef.current.loadHistoryItems(
          mergeResumedHistory(uiHistory, resumedSubagentHistory),
        );
        runLogger.log(
          '[session.resume] ui_history.loaded',
          `target_session=${resumedData.sessionId}`,
          `ui_history_items=${uiHistory.length}`,
          `subagent_traces=${resumedSubagentHistory.length}`,
        );
        // Resume replaces the active session identity. Clear the old native
        // transcript so scrollback cannot mix rows from two different sessions.
        requestTranscriptReplacementRef.current();

        // Copy the plan file from the resumed session into the current session
        // so the model has access to the previously approved plan without re-reading.
        const plansDir = config.storage.getPlansDir();
        const currentSessionId = config.getSessionId();
        await config.planStateManager
          .copyPlanForResume(
            resumedData.messages,
            resumeSourceSessionId,
            currentSessionId,
            plansDir,
          )
          .catch(() => {
            // Non-fatal — plan copy failure should not block session resume.
          });

        const currentWorktreeSettings = config.getWorktreeSettings();
        config.setSessionArtifactWorktreeStates(
          getResumeArtifactWorktreeStates(resumedData, [
            restoredWorktreeSettings
              ? toTranscriptWorktreeSession(
                  restoredWorktreeSettings,
                  resumedData.sessionId,
                )
              : undefined,
            currentWorktreeSettings
              ? toTranscriptWorktreeSession(
                  currentWorktreeSettings,
                  config.getSessionId(),
                )
              : undefined,
          ]),
        );
        delete resumedData.transcriptReadState;
        runLogger.log(
          '[session.resume] load.done',
          `target_session=${resumedData.sessionId}`,
          `current_session=${config.getSessionId()}`,
        );
        return true;
      } catch (error) {
        if (runtimeSwitchCommitted) {
          logSessionResumeWarning(
            '[session.resume] post_commit_refresh_failed',
            error,
            `target_session=${resumedData.sessionId}`,
            `current_session=${config.getSessionId()}`,
          );
          emitSessionResumeFeedback(
            'warning',
            'The session resumed, but the interface could not finish refreshing.',
            error,
          );
          return true;
        }
        logSessionResumeWarning(
          '[session.resume] load.failed',
          error,
          `target_session=${resumedData.sessionId}`,
          `current_session=${config.getSessionId()}`,
        );
        emitSessionResumeFeedback(
          'error',
          'Failed to resume session. Please try again.',
          error,
        );
        return false;
      } finally {
        resumedData.resumeAttempt?.finish();
        resumeInFlightRef.current = false;
        setIsResuming(false);
      }
    },
    [
      config,
      isRuntimeReady,
      mergeResumedHistory,
      replaceMessages,
      refreshContextTokenCount,
      setQuittingMessages,
      onProjectResume,
    ],
  );

  // Handle interactive resume from the command line (-r/--resume without -p/--prompt-interactive).
  // Only once startup is no longer held and the client is initialized, though.
  const hasLoadedResumedSession = useRef(false);
  useEffect(() => {
    if (
      resumedSessionData &&
      !isStartupHeld &&
      isRuntimeReady &&
      !hasLoadedResumedSession.current
    ) {
      hasLoadedResumedSession.current = true;
      const historyData = convertMessagesToHistoryFormats(
        resumedSessionData.messages,
      );
      void loadHistoryForResume(historyData.uiHistory, resumedSessionData, {
        ...initialResumeOptions,
        endOutgoingSession: false,
      }).then(async (success) => {
        await onInitialResumeComplete?.(success);
        if (success) setIsRestoringProject(false);
      });
    }
  }, [
    resumedSessionData,
    isStartupHeld,
    isRuntimeReady,
    loadHistoryForResume,
    initialResumeOptions,
    onInitialResumeComplete,
  ]);

  useEffect(() => {
    const pendingWorktreeRequest = worktreeStartupRequestRef.current;
    if (resumedSessionData) {
      setIsApplyingInitialWorktree(false);
      return;
    }
    if (
      !pendingWorktreeRequest ||
      !isRuntimeReady ||
      isStartupHeld ||
      hasAppliedInitialWorktreeRequest.current
    ) {
      return;
    }
    hasAppliedInitialWorktreeRequest.current = true;

    void (async () => {
      try {
        // 先由编排器创建稳定归属的 Writer，再切换到 Worktree 运行根。
        await replaceMessages([], config.getSessionId(), {
          restoreExistingSession: false,
        });
        await applyWorktreeStartupRequest(config, pendingWorktreeRequest);
      } catch (error) {
        setIsAutomaticInputBlocked(true);
        runLogger.warn(
          '[session.startup] requested_worktree_failed',
          error,
          `session=${config.getSessionId()}`,
        );
        emitSessionResumeFeedback(
          'warning',
          WORKTREE_STARTUP_FAILURE_MESSAGE,
          error,
        );
      } finally {
        worktreeStartupRequestRef.current = undefined;
        setIsApplyingInitialWorktree(false);
      }
    })();
  }, [
    config,
    isStartupHeld,
    isRuntimeReady,
    replaceMessages,
    resumedSessionData,
  ]);

  return {
    loadHistoryForResume,
    isResuming: isResuming || isApplyingInitialWorktree || isRestoringProject,
    isAutomaticInputBlocked,
    resumeAutomaticInput,
  };
}
