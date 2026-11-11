/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { AgentToolConstraints } from '../tools/agent-tool-constraints.js';
import type { QueryEvent } from '../core/query-event.js';
import type { CompletionBehavior } from '../services/executionLifecycleService.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import {
  getSubagentTranscriptPath,
  getSubagentArtifactContext,
  readSubagentTranscript,
} from '../services/subagent-transcript.js';
import type { AgentUnifiedTask } from '../tasks/unified-task.js';
import type { AnyDeclarativeTool, ToolLiveOutput } from '../tools/tools.js';
import type { BusinessInfo } from '../qoder/business-info.js';
import type { InternalExecutionOwner } from '../tools/tool-types.js';
import { createAgentId } from '../utils/agentId.js';
import { getAgentContext } from '../utils/agentContext.js';
import { snapshotCustomContext } from '../utils/sessionIdContext.js';
import { sanitizeErrorMessage } from '../utils/agent-sanitization-utils.js';
import {
  flushTaskOutput,
  initTaskOutputAsSymlink,
} from '../utils/task/diskOutput.js';
import { registerAgentTask } from './agent-task-runtime.js';
import { isAgentSessionsEnabled } from './agent-session-feature.js';
import { ProgressTracker } from './progressTracker.js';
import {
  resolveAgentModel,
  runAgent,
  toAgentResumeState,
  type RunAgentResult,
} from './run-agent.js';
import {
  AgentTerminateMode,
  type AgentInputs,
  type LocalAgentDefinition,
  type SubagentProgress,
} from './types.js';

export interface RunLocalAgentInvocationParams {
  definition: LocalAgentDefinition;
  context: AgentLoopContext;
  agentArgs: AgentInputs;
  signal: AbortSignal;
  description: string;
  invocationName?: string;
  teamName?: string;
  cwdOverride?: string;
  isolationOverride?: string;
  modelOverride?: string;
  querySelection?: Parameters<typeof runAgent>[0]['querySelection'];
  parentModel?: string;
  parentToolUseId?: string;
  parentRequestSetId?: string;
  parentBusinessInfo?: Readonly<BusinessInfo>;
  /** Opaque SDK context inherited from the parent turn. */
  customContext?: Readonly<Record<string, string>>;
  updateOutput?: (output: ToolLiveOutput) => void;
  onQueryEvent?: (event: QueryEvent) => void;
  completionBehavior?: CompletionBehavior;
  emitSdkSideEvents?: boolean;
  emitSdkTaskNotification?: boolean;
  registerTask?: boolean;
  agentId?: string;
  resumeFromTranscript?: boolean;
  additionalTools?: AnyDeclarativeTool[];
  toolConstraints?: AgentToolConstraints;
  subscribeMcpProgress?: boolean;
  internalExecutionOwner?: InternalExecutionOwner;
  taskType?: AgentUnifiedTask['type'];
  preserveTaskOnTeammateIdle?: boolean;
  terminationBarrier?: Promise<void>;
  onTaskRegistered?: (task: {
    taskId: string;
    agentId: string;
    outputPath: string;
    transcriptPath: string;
  }) => void;
}

export async function runLocalAgentInvocation(
  params: RunLocalAgentInvocationParams,
): Promise<RunAgentResult> {
  const {
    definition,
    context,
    agentArgs,
    signal,
    description,
    invocationName,
    teamName,
    cwdOverride,
    isolationOverride,
    modelOverride,
    querySelection,
    parentModel,
    parentToolUseId,
    parentRequestSetId,
    parentBusinessInfo,
    customContext,
    updateOutput,
    onQueryEvent,
    completionBehavior = 'notify',
    emitSdkSideEvents = true,
    emitSdkTaskNotification = emitSdkSideEvents,
    registerTask = true,
    agentId: requestedAgentId,
    resumeFromTranscript = false,
    additionalTools,
    toolConstraints,
    subscribeMcpProgress,
    internalExecutionOwner,
    taskType = 'local_agent',
    preserveTaskOnTeammateIdle = false,
    terminationBarrier,
    onTaskRegistered,
  } = params;

  const resolvedModel = await resolveAgentModel(
    context,
    definition,
    modelOverride,
    parentModel,
  );

  const executionAbortController = new AbortController();
  const runLifecycle: { settlement?: Promise<void> } = {};
  const queryText = getAgentQueryText(agentArgs);
  const label = invocationName?.trim() || description.trim() || definition.name;
  const executionHandle = ExecutionLifecycleService.createExecution(
    '',
    async () => {
      executionAbortController.abort('execution-abort');
      await runLifecycle.settlement;
      await terminationBarrier;
    },
    'none',
    undefined,
    label,
    completionBehavior,
    {
      sessionId: context.config.getSessionId(),
      customContext: snapshotCustomContext(customContext),
    },
  );
  const executionId = executionHandle.pid;
  if (executionId === undefined) {
    throw new Error('Failed to allocate an execution ID for subagent task');
  }

  const agentId = requestedAgentId ?? createAgentId(definition.name);
  const taskId = createAgentId();
  const sessionPersistence = context.config.getSessionPersistence();
  const artifactContext = getSubagentArtifactContext(context.config);
  const transcriptPath = sessionPersistence
    ? getSubagentTranscriptPath(
        artifactContext,
        context.config.getSessionId(),
        agentId,
      )
    : '';
  const resumeState = toAgentResumeState(
    sessionPersistence && resumeFromTranscript
      ? await readSubagentTranscript(
          artifactContext,
          context.config.getSessionId(),
          agentId,
        )
      : undefined,
  );
  const outputPath = transcriptPath
    ? await initTaskOutputAsSymlink(taskId, transcriptPath)
    : '';

  if (sessionPersistence) {
    await registerAgentTask({
      projectRoot: artifactContext,
      sessionId: context.config.getSessionId(),
      taskId,
      executionId,
      agentId,
      agentType: definition.name,
      resolvedModel,
      description,
      invocationName,
      teamName,
      parentToolUseId,
      outputPath,
      transcriptPath,
      completionBehavior,
      summary: `Agent "${label}" started`,
    });
  }

  const taskRegistry =
    registerTask && isAgentSessionsEnabled() ? context.taskRegistry : undefined;
  if (taskRegistry) {
    const agentTask: AgentUnifiedTask = {
      id: `a-${agentId}`,
      publicId: taskId,
      type: taskType,
      status: 'running',
      description,
      startTime: Date.now(),
      notified: completionBehavior === 'silent',
      executionId,
      outputPath,
      completionBehavior,
      agentId,
      agentName: invocationName?.trim() || definition.name,
      agentType: definition.name,
      resolvedModel,
      teamName,
      prompt: queryText ?? '',
      color: definition.color,
      isBackgrounded: false,
      taskId,
      abortController: executionAbortController,
    };
    taskRegistry.register(agentTask);
  }
  onTaskRegistered?.({ taskId, agentId, outputPath, transcriptPath });

  const wrappedUpdateOutput = (output: ToolLiveOutput) => {
    updateOutput?.(output);
    if (isSubagentProgressLike(output)) {
      taskRegistry?.updateProgress(`a-${agentId}`, output);
    }
  };
  const tracker = new ProgressTracker({
    agentName: definition.name,
    agentId,
    prompt: queryText ?? '',
    color: definition.color,
    targetDir: context.config.getTargetDir(),
    updateOutput: wrappedUpdateOutput,
    resolveToolDisplayName: (apiName: string) =>
      context.toolRegistry.getTool(apiName)?.displayName,
    publishActivity: (activity) => {
      ExecutionLifecycleService.appendOutput(
        executionId,
        formatActivityForExecutionOutput(activity),
      );
    },
  });

  ExecutionLifecycleService.appendOutput(
    executionId,
    `Launching agent '${definition.name}'\n`,
  );

  const onParentAbort = () => executionAbortController.abort(signal.reason);
  signal.addEventListener('abort', onParentAbort, { once: true });
  let resolveRunSettlement: (() => void) | undefined;
  runLifecycle.settlement = new Promise<void>((resolve) => {
    resolveRunSettlement = resolve;
  });
  try {
    const ownerAgentContext = getAgentContext();
    const outcome = await runAgent({
      definition,
      context,
      agentArgs,
      tracker,
      signal: executionAbortController.signal,
      taskId,
      taskType,
      agentId,
      outputPath,
      description,
      invocationName,
      teamName,
      cwdOverride,
      isolationOverride,
      modelOverride,
      querySelection,
      parentModel,
      resolvedModel,
      isForkPath: false,
      parentToolUseId,
      appendOutput: (chunk) =>
        ExecutionLifecycleService.appendOutput(executionId, chunk),
      updateOutput: wrappedUpdateOutput,
      onQueryEvent,
      emitSdkSideEvents,
      emitSdkTaskNotification,
      resumeState,
      preserveTaskOnTeammateIdle,
      additionalTools,
      toolConstraints,
      subscribeMcpProgress,
      parentRequestSetId,
      ownerAgentId: ownerAgentContext?.agentId,
      runInBackground: completionBehavior === 'notify',
      parentBusinessInfo,
      customContext,
      internalExecutionOwner,
    });

    const isGoal = outcome.terminateReason === AgentTerminateMode.GOAL;
    taskRegistry?.update(
      `a-${agentId}`,
      preserveTaskOnTeammateIdle && isGoal
        ? {
            status: 'running',
            isIdle: true,
            result: outcome.finalResult,
            worktreePath: outcome.worktreePath,
          }
        : {
            status: isGoal ? 'completed' : 'failed',
            endTime: Date.now(),
            notified: completionBehavior === 'silent',
            result: outcome.finalResult,
            worktreePath: outcome.worktreePath,
          },
    );
    ExecutionLifecycleService.completeExecution(executionId, {
      exitCode: isGoal ? 0 : 1,
      error: isGoal ? null : new Error(outcome.finalResult),
    });
    return outcome;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isAbort =
      (error instanceof Error && error.name === 'AbortError') ||
      errorMessage.includes('Aborted');
    taskRegistry?.update(`a-${agentId}`, {
      status: isAbort ? 'killed' : 'failed',
      endTime: Date.now(),
      notified: completionBehavior === 'silent',
      error: errorMessage,
    } as Partial<AgentUnifiedTask>);
    ExecutionLifecycleService.completeExecution(executionId, {
      aborted: isAbort,
      exitCode: isAbort ? 130 : 1,
      error: error instanceof Error ? error : new Error(errorMessage),
    });
    tracker.markRunningAs(isAbort ? 'cancelled' : 'error');
    if (!isAbort) {
      tracker.addErrorActivity(`Error: ${sanitizeErrorMessage(errorMessage)}`);
    }
    wrappedUpdateOutput(tracker.makeProgress(isAbort ? 'cancelled' : 'error'));
    ExecutionLifecycleService.appendOutput(
      executionId,
      `${isAbort ? 'Cancelled' : 'Error'}: ${sanitizeErrorMessage(errorMessage)}\n`,
    );
    await flushTaskOutput(taskId);
    throw error;
  } finally {
    signal.removeEventListener('abort', onParentAbort);
    resolveRunSettlement?.();
  }
}

function isSubagentProgressLike(value: unknown): value is SubagentProgress {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isSubagentProgress?: unknown }).isSubagentProgress === true
  );
}

function getAgentQueryText(agentArgs: AgentInputs): string | undefined {
  const value = agentArgs['query'];
  return typeof value === 'string' ? value : undefined;
}

function formatActivityForExecutionOutput(
  activity: SubagentProgress['recentActivity'][number],
): string {
  if (activity.type === 'thought') {
    return `${activity.content}\n`;
  }

  const toolLabel = activity.displayName ?? activity.content;
  const argsSuffix = activity.args ? ` ${activity.args}` : '';
  switch (activity.status) {
    case 'completed':
      return `Completed ${toolLabel}${argsSuffix}\n`;
    case 'error':
      return `Failed ${toolLabel}${argsSuffix}\n`;
    case 'cancelled':
      return `Cancelled ${toolLabel}${argsSuffix}\n`;
    default:
      return `Running ${toolLabel}${argsSuffix}\n`;
  }
}
