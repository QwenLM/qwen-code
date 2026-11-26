/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  extractLastAssistantModelFromTranscript,
  ForkSessionService,
  getDisplayablePromptText,
  toAttachedForkWorktreeSession,
  type Message,
} from '@qwen-code/core';
import {
  getPreferredContextWindow,
  getPreferredGeneration,
  getPreferredReasoningEffort,
} from '../../utils/modelPreference.js';
import { extractFirstUserMessage } from '../../utils/sessionUtils.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from './types.js';

export const branchCommand: SlashCommand = {
  name: 'branch',
  description: 'Create a new session branch from the current conversation',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  omitInputFromTranscript: true,
  action: async (context: CommandContext, args: string) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Session context not available.',
      };
    }

    const sourceSessionId = config.getSessionId();
    const artifactProjectRoot = config.getSessionArtifactProjectRoot();
    if (!sourceSessionId || !artifactProjectRoot) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No conversation to branch.',
      };
    }

    const messages = (context.messages ?? []) as Message[];
    const visibleMessages = messages.filter(
      (message) => message.type === 'user' || message.type === 'assistant',
    );
    if (visibleMessages.length === 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No conversation to branch.',
      };
    }

    try {
      const sourceSessionPath = config.getActiveSessionTranscriptPath();
      const forkService = new ForkSessionService(config.getTranscriptStore());
      const modelKey = config.getModel();
      const identity = config.getModelRequestIdentity();
      const listed = await config.getModelProviderManager().getModel(modelKey);
      if (
        modelKey !== config.getModel() ||
        identity !== config.getModelRequestIdentity() ||
        sourceSessionId !== config.getSessionId()
      )
        throw new Error('会话目标已变化，分支已取消。');
      const runtimeSnapshot = await forkService.captureActiveSessionSnapshot({
        projectRoot: artifactProjectRoot,
        sourceSessionId,
        sourceSessionPath,
        messages,
        directories: config.getWorkspaceContext().getDirectories(),
        fileHistorySnapshots:
          config.getFileHistoryManager()?.getSnapshots() ?? [],
        runtimeConfig: {
          model: modelKey,
          reasoningEffort: getPreferredReasoningEffort(config, listed) ?? null,
          contextWindow: getPreferredContextWindow(config, listed) ?? null,
          generation: getPreferredGeneration(config, listed) ?? null,
        },
      });
      const titleBase =
        args.trim() ||
        runtimeSnapshot.customTitle ||
        runtimeSnapshot.aiTitle ||
        getDisplayablePromptText(runtimeSnapshot.lastPrompt) ||
        extractFirstUserMessage(visibleMessages);
      const targetTitle = await forkService.generateUniqueBranchTitle(
        artifactProjectRoot,
        titleBase,
        { excludeSessionIds: [sourceSessionId] },
      );
      const targetSessionId = randomUUID();
      const activeWorktree = config.getWorktreeSettings?.();
      const fork = await forkService.createFork({
        projectRoot: artifactProjectRoot,
        sourceSessionId,
        targetSessionId,
        targetTitle,
        runtimeSnapshot,
        targetWorktreeSession: activeWorktree
          ? toAttachedForkWorktreeSession(activeWorktree, targetSessionId)
          : null,
      });

      const removeForkAndThrow = async (error: unknown): Promise<never> => {
        await forkService.deleteForkArtifacts({
          projectRoot: artifactProjectRoot,
          sessionId: fork.sessionId,
          sessionPath: fork.sessionPath,
          originalError: error,
        });
        throw error;
      };
      let didResume: boolean;
      try {
        didResume = await context.ui.resumeSession({
          sessionId: fork.sessionId,
          sourceSessionId,
          sourceSessionPath,
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
          forkTranscriptPath: fork.sessionPath,
          transcriptProjectRoot: artifactProjectRoot,
          worktreeSession: fork.worktreeSession,
          customTitle: targetTitle,
        });
      } catch (error) {
        return await removeForkAndThrow(error);
      }
      if (!didResume) {
        return await removeForkAndThrow(
          new Error('Failed to resume the branched conversation.'),
        );
      }

      return {
        type: 'local_command_result',
        text: `Branched conversation. You are now in the branch. To resume the original: /resume ${sourceSessionId}`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          error instanceof Error
            ? `Failed to branch conversation: ${error.message}`
            : 'Failed to branch conversation.',
      };
    }
  },
};
