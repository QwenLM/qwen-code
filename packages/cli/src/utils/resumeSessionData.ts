/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  extractLastAssistantModelFromTranscript,
  ForkSessionService,
  type Message,
  type SessionResumeData,
  createBoundedResumeReadState,
  ResumeReadError,
  sameTranscriptSnapshots,
  selectSessionResumePoint,
  toAttachedForkWorktreeSession,
  type TranscriptStore,
} from '@qwen-code/core';
import { registerSyncCleanup } from './cleanup.js';
import type { resolveSameRepoTranscriptSession } from '@qwen-code/core';

type ResolvedTranscriptSession = Awaited<
  ReturnType<typeof resolveSameRepoTranscriptSession>
>;

export interface ResumeSessionDeps {
  readonly transcriptStore: TranscriptStore;
  readonly sessionId: string;
  readonly sessionArtifactProjectRoot: string;
  /** fork 的计划文件迁移；由拥有 PlanStateManager 的一方提供。 */
  readonly copyPlanForResume?: (input: {
    messages: readonly Message[];
    sourceSessionId: string;
    targetSessionId: string;
  }) => Promise<void>;
}

export interface ResumeBuildOptions {
  forkSession?: boolean;
  sessionMirror?: boolean;
  targetSessionId?: string;
  resumeSessionAt?: string;
  resumeDropsTurn?: string;
}

export async function buildResumedSessionData(
  deps: ResumeSessionDeps,
  resolvedSession: ResolvedTranscriptSession,
  options: ResumeBuildOptions = {},
): Promise<SessionResumeData> {
  const attempt = resolvedSession.resumeAttempt;
  registerSyncCleanup(() => attempt?.finish());
  if (options.forkSession) attempt?.finish();
  if (!options.forkSession) {
    let selected;
    let resumeCandidate = resolvedSession.resumeCandidate;
    let transcriptReadState = resolvedSession.transcriptReadState;
    if (options.resumeSessionAt) {
      if (!attempt) throw new ResumeReadError('unsafe');
      const candidate = await deps.transcriptStore
        .repository()
        .readForResume(resolvedSession.sessionPath, {
          consistency: 'flush-pending',
          sessionId: resolvedSession.sessionInfo.id,
          attempt,
          resumeSessionAt: options.resumeSessionAt,
          resumeDropsTurn: options.resumeDropsTurn,
        });
      if (!candidate) throw new ResumeReadError('snapshot');
      const selectedSnapshot = resolvedSession.transcriptReadState?.snapshot;
      if (
        selectedSnapshot &&
        !sameTranscriptSnapshots(selectedSnapshot, candidate.snapshot)
      )
        throw new ResumeReadError('snapshot');
      selected = {
        messages: [...candidate.messages],
        fileHistorySnapshots: [...candidate.fileHistorySnapshots],
      };
      transcriptReadState = createBoundedResumeReadState(candidate);
      resumeCandidate = candidate;
    } else {
      selected = selectSessionResumePoint(
        resolvedSession.messages,
        resolvedSession.fileHistorySnapshots,
        undefined,
        options.resumeDropsTurn,
      );
    }
    return {
      sessionId:
        resolvedSession.messages[0]?.sessionId ??
        resolvedSession.sessionInfo.id,
      messages: selected.messages,
      directories: resolvedSession.sessionInfo.directories,
      fileHistorySnapshots: selected.fileHistorySnapshots,
      model:
        resolvedSession.runtimeConfig?.model ??
        extractLastAssistantModelFromTranscript(selected.messages),
      reasoningEffort: resolvedSession.runtimeConfig?.reasoningEffort,
      contextWindow: resolvedSession.runtimeConfig?.contextWindow,
      generation: resolvedSession.runtimeConfig?.generation,
      sessionPath: resolvedSession.sessionPath,
      transcriptProjectRoot: resolvedSession.sessionInfo.transcriptProjectRoot,
      originalCwd: resolvedSession.sessionInfo.originalCwd,
      worktreeSession: resolvedSession.sessionInfo.worktreeSession,
      customTitle: resolvedSession.sessionInfo.customTitle,
      transcriptReadState,
      resumeAttempt: attempt,
      resumeCandidate,
    };
  }

  const targetSessionId = options.targetSessionId ?? deps.sessionId;
  const sourceWorktree = resolvedSession.sessionInfo.worktreeSession;
  const artifactProjectRoot =
    sourceWorktree?.originalCwd ??
    resolvedSession.sessionInfo.originalCwd ??
    deps.sessionArtifactProjectRoot;
  const targetWorktreeSession = sourceWorktree
    ? toAttachedForkWorktreeSession(sourceWorktree, targetSessionId)
    : null;
  const forkService = new ForkSessionService(deps.transcriptStore);
  const fork = await forkService.createFork({
    projectRoot: artifactProjectRoot,
    targetCwd:
      targetWorktreeSession?.worktreeCwd ??
      targetWorktreeSession?.worktreePath ??
      artifactProjectRoot,
    targetWorktreeSession,
    sourceSessionId: resolvedSession.sessionInfo.id,
    sourceSessionPath: resolvedSession.sessionPath,
    sourceProjectRoot:
      resolvedSession.sessionInfo.transcriptProjectRoot ?? artifactProjectRoot,
    sourceSessionInfo: resolvedSession.sessionInfo,
    targetSessionId,
    resumeSessionAt: options.resumeSessionAt,
    resumeDropsTurn: options.resumeDropsTurn,
  });

  await deps
    .copyPlanForResume?.({
      messages: fork.messages,
      sourceSessionId: resolvedSession.sessionInfo.id,
      targetSessionId: fork.sessionId,
    })
    .catch(() => {
      // Non-fatal — missing plan state must not block branch creation.
    });

  return {
    sessionId: fork.sessionId,
    sourceSessionId: resolvedSession.sessionInfo.id,
    sourceSessionPath: resolvedSession.sessionPath,
    forkTranscriptPath: fork.sessionPath,
    ...(options.sessionMirror ? { forkTranscriptEntries: fork.entries } : {}),
    transcriptReadState: fork.resumeState,
    sessionPath: fork.sessionPath,
    transcriptProjectRoot: artifactProjectRoot,
    originalCwd: artifactProjectRoot,
    worktreeSession: fork.worktreeSession,
    strictFileHistoryRestore: true,
    messages: fork.messages,
    directories: fork.directories,
    fileHistorySnapshots: fork.fileHistorySnapshots,
    model:
      fork.runtimeConfig?.model ??
      extractLastAssistantModelFromTranscript(fork.messages),
    reasoningEffort: fork.runtimeConfig?.reasoningEffort,
    contextWindow: fork.runtimeConfig?.contextWindow,
    generation: fork.runtimeConfig?.generation,
  };
}

export function resumeSessionDepsFromConfig(config: Config): ResumeSessionDeps {
  return {
    transcriptStore: config.getTranscriptStore(),
    sessionId: config.getSessionId(),
    sessionArtifactProjectRoot: config.getSessionArtifactProjectRoot(),
    copyPlanForResume: ({ messages, sourceSessionId, targetSessionId }) =>
      config.planStateManager
        .copyPlanForResume(
          messages,
          sourceSessionId,
          targetSessionId,
          config.storage.getPlansDir(),
        )
        .catch(() => {}),
  };
}
