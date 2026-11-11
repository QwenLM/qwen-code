/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getBusinessInfoFromContext } from '../../utils/sessionIdContext.js';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import type { AgentUnifiedTask } from '../../tasks/unified-task.js';
import { isAbortError } from '../../utils/errors.js';
import { runLogger } from '../../utils/runLogger.js';
import { tryRegisterTeammateController } from './agent-team-controller.js';
import { IN_PROCESS_TEAMMATE_TASK_TYPE } from './agent-teams-feature.js';
import {
  deriveTeammateIdleSummary,
  publishTeammateIdleNotification,
} from './agent-team-main-delivery.js';
import {
  claimAgentTeamMemberWake,
  readTeamInbox,
  TEAM_LEAD_MEMBER_NAME,
  type TeamMailboxMessage,
  updateAgentTeamMemberStatus,
} from './agent-team-runtime.js';
import { runLocalAgentInvocation } from '../local-agent-runner.js';
import { formatTeammateMessage } from './agent-team-peer-message.js';
import { AgentTerminateMode } from '../types.js';
import {
  getSubagentArtifactContext,
  readSubagentTranscript,
} from '../../services/subagent-transcript.js';


export type WakeTeamMemberReason =
  | 'team_lead'
  | 'team_not_found'
  | 'member_not_found'
  | 'already_running'
  | 'missing_task_id'
  | 'agent_not_found'
  | 'not_local_agent'
  | 'missing_context';

export interface WakeTeamMemberResult {
  woken: boolean;
  reason?: WakeTeamMemberReason;
  agentId?: string;
  taskId?: string;
  outputPath?: string;
}

export async function wakeTeamMemberIfIdle(params: {
  context: AgentLoopContext | undefined;
  teamName: string;
  memberName: string;
  senderName: string;
  message: string;
  parentToolUseId?: string;
  customContext?: Readonly<Record<string, string>>;
  allowStaleRunning?: boolean;
}): Promise<WakeTeamMemberResult> {
  const callerBusiness = getBusinessInfoFromContext();
  const {
    context,
    teamName,
    memberName,
    senderName,
    message,
    parentToolUseId,
    customContext,
    allowStaleRunning = false,
  } = params;
  if (memberName === TEAM_LEAD_MEMBER_NAME) {
    return { woken: false, reason: 'team_lead' };
  }
  if (!context) {
    return { woken: false, reason: 'missing_context' };
  }

  const claimed = await claimAgentTeamMemberWake({
    teamName,
    memberName,
    allowStaleRunning,
  });
  if (!claimed.claimed) {
    return { woken: false, reason: claimed.reason };
  }
  const memberTaskId = claimed.member.taskId;
  if (!memberTaskId) {
    await updateAgentTeamMemberStatus({
      teamName,
      memberName,
      status: 'stopped',
    });
    return { woken: false, reason: 'missing_task_id' };
  }

  const definition = context.config
    .getAgentRegistry()
    .getDefinition(claimed.member.agentType);
  if (!definition) {
    await updateAgentTeamMemberStatus({
      teamName,
      memberName,
      status: 'stopped',
    });
    return { woken: false, reason: 'agent_not_found' };
  }
  if (definition.kind !== 'local') {
    await updateAgentTeamMemberStatus({
      teamName,
      memberName,
      status: 'stopped',
    });
    return { woken: false, reason: 'not_local_agent' };
  }
  const unregisterController = tryRegisterTeammateController(
    claimed.member.agentId,
  );
  if (!unregisterController) {
    return {
      woken: false,
      reason: 'already_running',
      agentId: claimed.member.agentId,
      taskId: memberTaskId,
    };
  }

  let pendingMessages: TeamMailboxMessage[];
  try {
    pendingMessages = await readTeamInbox({
      teamName,
      memberName,
      unreadOnly: true,
      markRead: true,
      oneBusinessBatch: true,
    });
  } catch (error) {
    unregisterController();
    throw error;
  }
  const businessInfo = pendingMessages[0]?.businessInfo ?? callerBusiness;
  const messageCustomContext =
    pendingMessages[0]?.customContext ?? customContext;
  const resumePrompt =
    pendingMessages.length > 0
      ? pendingMessages
          .map((pending) =>
            formatTeammateMessage({
              from: pending.from,
              text: pending.text,
              summary: pending.summary,
              color: pending.color,
            }),
          )
          .join('\n\n')
      : formatTeammateMessage({ from: senderName, text: message });

  let registeredTask:
    | {
        taskId: string;
        agentId: string;
        outputPath: string;
      }
    | undefined;
  let markTaskRegistered: (() => void) | undefined;
  const taskRegistered = new Promise<void>((resolve) => {
    markTaskRegistered = resolve;
  });
  let resolveWakeSettlement: (() => void) | undefined;
  const wakeSettlement = new Promise<void>((resolve) => {
    resolveWakeSettlement = resolve;
  });
  const lifecycleAbortController = new AbortController();
  const wakeRun = runLocalAgentInvocation({
    parentBusinessInfo: businessInfo,
    customContext: messageCustomContext,
    definition,
    context,
    agentArgs: { query: resumePrompt },
    signal: lifecycleAbortController.signal,
    description: claimed.member.description ?? `Wake teammate ${memberName}`,
    invocationName: memberName,
    teamName,
    cwdOverride: claimed.member.cwd,
    modelOverride: claimed.member.resolvedModel,
    parentToolUseId,
    completionBehavior: 'notify',
    emitSdkSideEvents: true,
    emitSdkTaskNotification: false,
    agentId: claimed.member.agentId,
    resumeFromTranscript: true,
    taskType: IN_PROCESS_TEAMMATE_TASK_TYPE,
    preserveTaskOnTeammateIdle: true,
    terminationBarrier: wakeSettlement,
    onTaskRegistered: (task) => {
      registeredTask = task;
      context.taskRegistry?.update(`a-${task.agentId}`, {
        isBackgrounded: true,
        isIdle: false,
        abortController: lifecycleAbortController,
      } as Partial<AgentUnifiedTask>);
      markTaskRegistered?.();
    },
  });

  const wakeFinalization = wakeRun
    .then(async (outcome) => {
      const completed = outcome.terminateReason === AgentTerminateMode.GOAL;

      let transcript:
        | Awaited<ReturnType<typeof readSubagentTranscript>>
        | undefined;
      if (completed) {
        try {
          transcript = await readSubagentTranscript(
            getSubagentArtifactContext(context.config),
            context.config.getSessionId(),
            outcome.agentId,
          );
        } catch (error) {
          runLogger.warn(
            `[AgentTeamWakeup] Could not read transcript for idle summary from "${memberName}":`,
            error,
          );
        }
      }
      await updateAgentTeamMemberStatus({
        teamName,
        memberName,
        status: completed ? 'idle' : 'stopped',
      });
      context.taskRegistry?.update(`a-${outcome.agentId}`, {
        status: completed ? 'running' : 'failed',
        isIdle: true,
        result: outcome.finalResult,
        ...(completed ? {} : { endTime: Date.now() }),
      } as Partial<AgentUnifiedTask>);
      await publishTeammateIdleNotification({
        config: context.config,
        teamName,
        memberName,
        agentId: outcome.agentId,
        taskId: outcome.taskId,
        idleReason: completed ? 'available' : 'failed',
        summary: completed
          ? outcome.teammateIdleSummary ??
            deriveTeammateIdleSummary(transcript?.messages ?? [])
          : undefined,
        failureReason: completed ? undefined : outcome.finalResult,
      });
    })
    .catch(async (error) => {
      const aborted = isAbortError(error);

      await updateAgentTeamMemberStatus({
        teamName,
        memberName,
        status: 'stopped',
      }).catch(() => {});
      if (!aborted) {
        await publishTeammateIdleNotification({
          config: context.config,
          teamName,
          memberName,
          agentId: claimed.member.agentId,
          taskId: registeredTask?.taskId ?? memberTaskId,
          idleReason: 'failed',
          failureReason: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
        runLogger.warn(
          `[AgentTeamWakeup] Teammate "${memberName}" in team "${teamName}" failed after message from "${senderName}":`,
          error,
        );
      }
    })
    .finally(async () => {
      unregisterController();
      resolveWakeSettlement?.();
      if (lifecycleAbortController.signal.aborted) return;
      try {
        const remaining = await readTeamInbox({
          teamName,
          memberName,
          unreadOnly: true,
        });
        if (remaining.length > 0) {
          await wakeTeamMemberIfIdle({
            context,
            teamName,
            memberName,
            senderName: remaining[0].from,
            message: remaining[0].text,
            customContext,
          });
        }
      } catch (error) {
        runLogger.warn(
          '[AgentTeamWakeup] Failed to schedule remaining inbox batch',
          error,
        );
      }
    });
  void wakeFinalization;
  await Promise.race([
    taskRegistered,
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);

  return {
    woken: true,
    agentId: registeredTask?.agentId ?? claimed.member.agentId,
    taskId: registeredTask?.taskId ?? memberTaskId,
    outputPath: registeredTask?.outputPath,
  };
}
