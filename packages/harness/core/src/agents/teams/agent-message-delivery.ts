/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import type { MessageOrigin } from '../../input/types.js';
import { wrapTextByOrigin } from '../../input/origin-content-wrapping.js';
import { enqueue, enqueuePendingNotification } from '../../services/messageQueueManager.js';
import { buildTaskNotificationXml } from '../../services/taskNotification.js';
import type { AgentUnifiedTask } from '../../tasks/unified-task.js';
import { runLogger } from '../../utils/runLogger.js';
import { runLocalAgentInvocation } from '../local-agent-runner.js';
import { snapshotCustomContext } from '../../utils/sessionIdContext.js';
import { AgentTerminateMode } from '../types.js';

export function queueMessageForRunningAgent(params: {
  context: AgentLoopContext;
  recipient: AgentUnifiedTask;
  message: string;
  origin: MessageOrigin;
}): void {
  enqueue({
    prompt: params.message,
    commandMode: 'prompt',
    priority: 'next',
    isMeta: true,
    sessionId: params.context.config.getSessionId(),
    targetAgentId: params.recipient.agentId,
    origin: params.origin,
  });
}

export async function resumeBackgroundAgentWithMessage(params: {
  context: AgentLoopContext;
  recipient: AgentUnifiedTask;
  message: string;
  origin: MessageOrigin;
  parentToolUseId?: string;
  customContext?: Readonly<Record<string, string>>;
}): Promise<{
  agentId: string;
  taskId: string;
  outputPath?: string;
}> {
  const definition = params.context.config
    .getAgentRegistry()
    .getDefinition(params.recipient.agentType);
  if (!definition || definition.kind !== 'local') {
    throw new Error(
      `Agent type "${params.recipient.agentType}" is not available for local resume.`,
    );
  }

  let registered:
    | { agentId: string; taskId: string; outputPath: string }
    | undefined;
  let resolveRegistered: (() => void) | undefined;
  const taskRegistered = new Promise<void>((resolve) => {
    resolveRegistered = resolve;
  });
  const resumed = runLocalAgentInvocation({
    definition,
    context: params.context,
    agentArgs: {
      query: wrapTextByOrigin(params.message, params.origin),
    },
    signal: new AbortController().signal,
    description: params.recipient.description,
    invocationName: params.recipient.agentName,
    cwdOverride: params.recipient.worktreePath,
    modelOverride: params.recipient.resolvedModel,
    parentToolUseId: params.parentToolUseId,
    customContext: params.customContext,
    completionBehavior: 'notify',
    emitSdkSideEvents: true,
    emitSdkTaskNotification: true,
    agentId: params.recipient.agentId,
    resumeFromTranscript: true,
    taskType: 'local_agent',
    onTaskRegistered: (task) => {
      registered = task;
      params.context.taskRegistry?.update(`a-${task.agentId}`, {
        isBackgrounded: true,
      } as Partial<AgentUnifiedTask>);
      resolveRegistered?.();
    },
  });

  void resumed
    .then((outcome) => {
      const completed = outcome.terminateReason === AgentTerminateMode.GOAL;
      enqueuePendingNotification({
        prompt: buildTaskNotificationXml({
          taskId: outcome.taskId,
          outputPath: outcome.outputPath ?? '',
          status: completed ? 'completed' : 'failed',
          summary: completed
            ? `Agent "${params.recipient.agentName}" finished`
            : `Agent "${params.recipient.agentName}" failed`,
          toolUseId: params.parentToolUseId,
          result: outcome.finalResult,
          usage: {
            totalTokens: outcome.totalTokens ?? 0,
            toolUses: outcome.toolCalls ?? 0,
            durationMs: outcome.durationMs ?? 0,
          },
        }),
        commandMode: 'task-notification',
        priority: 'next',
        sessionId: params.context.config.getSessionId(),
        targetAgentId: params.recipient.ownerAgentId,
        ...(params.customContext !== undefined
          ? { customContext: snapshotCustomContext(params.customContext) }
          : {}),
      });
      params.context.taskRegistry?.markNotified(`a-${outcome.agentId}`);
    })
    .catch((error) => {
      enqueuePendingNotification({
        prompt: buildTaskNotificationXml({
          taskId: params.recipient.taskId,
          outputPath: registered?.outputPath ?? params.recipient.outputPath ?? '',
          status: 'failed',
          summary: `Agent "${params.recipient.agentName}" failed`,
          toolUseId: params.parentToolUseId,
          result: error instanceof Error ? error.message : String(error),
        }),
        commandMode: 'task-notification',
        priority: 'next',
        sessionId: params.context.config.getSessionId(),
        targetAgentId: params.recipient.ownerAgentId,
        ...(params.customContext !== undefined
          ? { customContext: snapshotCustomContext(params.customContext) }
          : {}),
      });
      params.context.taskRegistry?.markNotified(
        `a-${params.recipient.agentId}`,
      );
      runLogger.warn(
        `[AgentMessageDelivery] Agent "${params.recipient.agentName}" failed after resume:`,
        error,
      );
    });

  await Promise.race([
    taskRegistered,
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);

  return {
    agentId: registered?.agentId ?? params.recipient.agentId,
    taskId: registered?.taskId ?? params.recipient.taskId,
    outputPath: registered?.outputPath ?? params.recipient.outputPath,
  };
}
