/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { useState, useCallback } from 'react';
import type { HistoryItemWithoutId } from '../types.js';
import {
  coreEvents,
  type Config,
  ForkSessionService,
  TranscriptStore,
  type SessionResumeData,
  extractLastAssistantModelFromTranscript,
  toAttachedForkWorktreeSession,
  ResumeReadError,
} from '@qwen-code/core';
import {
  SessionSelector,
  SessionError,
  type SessionInfo,
  type SessionSelectionResult,
  convertMessagesToHistoryFormats,
} from '../../utils/sessionUtils.js';
import { deleteSessionTranscript } from '../../utils/sessionTranscriptDeletion.js';
import type { SessionResumeOptions } from './useSessionResume.js';
import {
  type WorktreeStartupRequest,
} from '../../utils/worktreeStartupRequest.js';

export interface SessionBrowserOpenOptions {
  continueLatest?: boolean;
  forkSession?: boolean;
  initialSearchQuery?: string;
  initialSessionTitle?: string;
  resumeTarget?: string;
  targetSessionId?: string;
  worktreeStartupRequest?: WorktreeStartupRequest;
}

export const useSessionBrowser = (
  config: Config,
  onLoadHistory: (
    uiHistory: HistoryItemWithoutId[],
    resumedSessionData: SessionResumeData,
    resumeOptions?: SessionResumeOptions,
  ) => Promise<boolean>,
  onResumeError?: (error: unknown) => void,
) => {
  const [isSessionBrowserOpen, setIsSessionBrowserOpen] = useState(false);
  const [sessionBrowserOptions, setSessionBrowserOptions] =
    useState<SessionBrowserOpenOptions>({});

  const loadResolvedSession = useCallback(
    async (
      resolved: SessionSelectionResult,
      sessionId: string,
      options: Pick<
        SessionBrowserOpenOptions,
        | 'forkSession'
        | 'initialSessionTitle'
        | 'targetSessionId'
        | 'worktreeStartupRequest'
      > = {},
    ) => {
      try {
      // 当前会话的 Writer 仍持有 transcript 状态，冷恢复会以 RESUME_READ_CONFLICT
      // 失败。SessionBrowser 早已把当前会话排除出可选范围，/continue 与
      // /resume <当前 id> 必须遵守同一条规则；fork 走的是新 sessionId，不受影响。
      if (
        !options.forkSession &&
        resolved.sessionInfo.isCurrentSession === true
      ) {
        setIsSessionBrowserOpen(false);
        coreEvents.emitFeedback('info', 'This session is already open.');
        return;
      }
      let resumedSessionData: SessionResumeData;
      let cleanupFork: ((originalError?: unknown) => Promise<void>) | undefined;
      if (options.forkSession) {
        if (resolved.resumeCandidate && resolved.resumeAttempt) {
          if (resolved.resumeCandidate.snapshot.size > resolved.resumeAttempt.limits.maxRetainedBytes) {
            throw new ResumeReadError('unsafe');
          }
          resolved.resumeAttempt.finish();
        }
        const sourceWorktree = resolved.sessionInfo.worktreeSession;
        const artifactProjectRoot =
          sourceWorktree?.originalCwd ??
          resolved.sessionInfo.originalCwd ??
          config.getSessionArtifactProjectRoot();
        const forkService = new ForkSessionService(config.getTranscriptStore());
        const targetSessionId = options.targetSessionId ?? randomUUID();
        const targetWorktreeSession = sourceWorktree
          ? toAttachedForkWorktreeSession(sourceWorktree, targetSessionId)
          : null;
        const fork = await forkService.createFork({
          projectRoot: artifactProjectRoot,
          targetCwd:
            targetWorktreeSession?.worktreeCwd ??
            targetWorktreeSession?.worktreePath ??
            artifactProjectRoot,
          sourceSessionId: sessionId,
          sourceSessionPath: resolved.sessionPath,
          sourceProjectRoot:
            resolved.sessionInfo.transcriptProjectRoot ?? artifactProjectRoot,
          targetSessionId,
          targetWorktreeSession,
        });
        cleanupFork = async (originalError) => {
          // 跨项目恢复会关闭原 Config 的 Store，失败补偿不能再借用它。
          const cleanupStore = new TranscriptStore();
          try {
            await new ForkSessionService(cleanupStore).deleteForkArtifacts({
              projectRoot: artifactProjectRoot,
              sessionId: fork.sessionId,
              sessionPath: fork.sessionPath,
              ...(originalError !== undefined ? { originalError } : {}),
            });
          } finally {
            await cleanupStore.close();
          }
        };
        resumedSessionData = {
          sessionId: fork.sessionId,
          sourceSessionId: sessionId,
          sourceSessionPath: resolved.sessionPath,
          messages: fork.messages,
          directories: fork.directories,
          fileHistorySnapshots: fork.fileHistorySnapshots,
          model:
            fork.runtimeConfig?.model ??
            extractLastAssistantModelFromTranscript(fork.messages),
          reasoningEffort: fork.runtimeConfig?.reasoningEffort,
          contextWindow: fork.runtimeConfig?.contextWindow,
          generation: fork.runtimeConfig?.generation,
          sessionPath: fork.sessionPath,
          transcriptProjectRoot: artifactProjectRoot,
          originalCwd: artifactProjectRoot,
          worktreeSession: fork.worktreeSession,
        };
      } else {
        resumedSessionData = {
          sessionId: resolved.sessionInfo.id ?? sessionId,
          messages: resolved.messages,
          directories: resolved.directories,
          fileHistorySnapshots: resolved.fileHistorySnapshots,
          model:
            resolved.runtimeConfig?.model ??
            extractLastAssistantModelFromTranscript(resolved.messages),
          reasoningEffort: resolved.runtimeConfig?.reasoningEffort,
          contextWindow: resolved.runtimeConfig?.contextWindow,
          generation: resolved.runtimeConfig?.generation,
          sessionPath: resolved.sessionPath,
          transcriptProjectRoot: resolved.sessionInfo.transcriptProjectRoot,
          originalCwd: resolved.sessionInfo.originalCwd,
          worktreeSession: resolved.sessionInfo.worktreeSession,
          customTitle: resolved.sessionInfo.customTitle,
          transcriptReadState: resolved.transcriptReadState,
          resumeAttempt: resolved.resumeAttempt,
        };
      }

      setIsSessionBrowserOpen(false);
      const historyData = convertMessagesToHistoryFormats(
        resumedSessionData.messages,
      );
      let didResume = false;
      let resumeError: unknown;
      try {
        didResume = await onLoadHistory(
          historyData.uiHistory,
          resumedSessionData,
          {
            worktreeStartupRequest: options.worktreeStartupRequest,
            initialSessionTitle: options.initialSessionTitle,
          },
        );
      } catch (error) {
        resumeError = error;
        throw error;
      } finally {
        if (!didResume) {
          await cleanupFork?.(resumeError);
        }
      }
      } finally {
        resolved.resumeAttempt?.finish();
      }
    },
    [config, onLoadHistory],
  );

  const resumeSessionByIdentifier = useCallback(
    async (
      identifier: string,
      options: Pick<
        SessionBrowserOpenOptions,
        | 'forkSession'
        | 'initialSessionTitle'
        | 'targetSessionId'
        | 'worktreeStartupRequest'
      > = {},
    ) => {
      const trimmed = identifier.trim();
      if (!trimmed) {
        setSessionBrowserOptions(options);
        setIsSessionBrowserOpen(true);
        return;
      }

      try {
        const sessionSelector = new SessionSelector(config);
        const resolved = await sessionSelector.resolveSession(trimmed);
        await loadResolvedSession(resolved, resolved.sessionInfo.id, {
          forkSession: options.forkSession,
          initialSessionTitle: options.initialSessionTitle,
          targetSessionId: options.targetSessionId,
          worktreeStartupRequest: options.worktreeStartupRequest,
        });
      } catch (error) {
        if (
          error instanceof SessionError &&
          (error.code === 'INVALID_SESSION_IDENTIFIER' ||
            error.code === 'NO_SESSIONS_FOUND')
        ) {
          setSessionBrowserOptions({
            initialSearchQuery: trimmed,
            forkSession: options.forkSession,
            initialSessionTitle: options.initialSessionTitle,
            targetSessionId: options.targetSessionId,
            worktreeStartupRequest: options.worktreeStartupRequest,
          });
          setIsSessionBrowserOpen(true);
          return;
        }

        coreEvents.emitFeedback('error', 'Error resuming session:', error);
        onResumeError?.(error);
      }
    },
    [config, loadResolvedSession, onResumeError],
  );

  const continueLatestSession = useCallback(
    async (
      options: Pick<
        SessionBrowserOpenOptions,
        | 'forkSession'
        | 'initialSessionTitle'
        | 'targetSessionId'
        | 'worktreeStartupRequest'
      > = {},
    ) => {
      try {
        const sessionSelector = new SessionSelector(config);
        const resolved = await sessionSelector.resolveLatestSession();
        await loadResolvedSession(resolved, resolved.sessionInfo.id, {
          forkSession: options.forkSession,
          initialSessionTitle: options.initialSessionTitle,
          targetSessionId: options.targetSessionId,
          worktreeStartupRequest: options.worktreeStartupRequest,
        });
      } catch (error) {
        if (
          error instanceof SessionError &&
          error.code === 'NO_SESSIONS_FOUND'
        ) {
          coreEvents.emitFeedback('error', 'No conversation found to continue');
          return;
        }

        coreEvents.emitFeedback('error', 'Error continuing session:', error);
      }
    },
    [config, loadResolvedSession],
  );

  return {
    isSessionBrowserOpen,
    sessionBrowserOptions,

    openSessionBrowser: useCallback(
      (options: SessionBrowserOpenOptions = {}) => {
        const {
          continueLatest,
          forkSession,
          resumeTarget,
          initialSearchQuery,
          initialSessionTitle,
          targetSessionId,
          worktreeStartupRequest,
        } = options;
        if (continueLatest) {
          void continueLatestSession({
            forkSession,
            initialSessionTitle,
            targetSessionId,
            worktreeStartupRequest,
          });
          return;
        }

        if (resumeTarget) {
          void resumeSessionByIdentifier(resumeTarget, {
            forkSession,
            initialSessionTitle,
            targetSessionId,
            worktreeStartupRequest,
          });
          return;
        }

        setSessionBrowserOptions({
          forkSession,
          initialSearchQuery: initialSearchQuery?.trim() || undefined,
          initialSessionTitle,
          targetSessionId,
          worktreeStartupRequest,
        });
        setIsSessionBrowserOpen(true);
      },
      [continueLatestSession, resumeSessionByIdentifier],
    ),

    closeSessionBrowser: useCallback(() => {
      setSessionBrowserOptions({});
      setIsSessionBrowserOpen(false);
    }, []),

    /**
     * Loads a conversation by ID, and reinitializes the chat recording service with it.
     */
    handleResumeSession: useCallback(
      async (
        session: SessionInfo,
        resolvedSession?: SessionSelectionResult,
      ) => {
        try {
          const resolved =
            resolvedSession ??
            (await new SessionSelector(config).resolveSelectedSession(session));
          await loadResolvedSession(resolved, session.id, {
            forkSession: sessionBrowserOptions.forkSession,
            initialSessionTitle: sessionBrowserOptions.initialSessionTitle,
            targetSessionId: sessionBrowserOptions.targetSessionId,
            worktreeStartupRequest:
              sessionBrowserOptions.worktreeStartupRequest,
          });
        } catch (error) {
          // 预览解析携带的租约在恢复失败时必须归还；成功路径由承接方释放，幂等。
          resolvedSession?.resumeAttempt?.finish();
          coreEvents.emitFeedback('error', 'Error resuming session:', error);
          setIsSessionBrowserOpen(false);
          onResumeError?.(error);
        }
      },
      [config, loadResolvedSession, onResumeError, sessionBrowserOptions],
    ),

    /**
     * Deletes a session transcript file by ID.
     */
    handleDeleteSession: useCallback(
      async (session: SessionInfo) => {
        try {
          const sessionPath = session.sessionPath;
          if (!sessionPath) {
            throw new Error(`Missing session path for session ${session.id}`);
          }
          await deleteSessionTranscript({
            transcriptStore: config.getTranscriptStore(),
            sessionPath,
            sessionId: session.id,
            sessionArtifactProjectRoot:
              session.transcriptProjectRoot ??
              config.getSessionArtifactProjectRoot(),
            ...(session.worktreeSession !== undefined
              ? { worktreeSession: session.worktreeSession }
              : {}),
          });
        } catch (error) {
          coreEvents.emitFeedback('error', 'Error deleting session:', error);
          throw error;
        }
      },
      [config],
    ),
  };
};
