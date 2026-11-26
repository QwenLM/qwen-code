/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createTaskNotificationEvent,
  createTaskUpdatedEvent,
  enqueueBackgroundTasksChangedFromRegistry,
  enqueueSubagentSdkEvent,
} from '../agents/subagent-sdk-events.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import type { TaskRegistry } from './task-registry.js';
import type {
  AgentUnifiedTask,
  InternalAgentUnifiedTask,
  UnifiedTask,
} from './unified-task.js';

export type TaskControlErrorCode =
  | 'not_found'
  | 'not_running'
  | 'not_owner'
  | 'unsupported_type';

export class TaskControlError extends Error {
  constructor(
    message: string,
    readonly code: TaskControlErrorCode,
  ) {
    super(message);
    this.name = 'TaskControlError';
  }
}

export interface StopTaskResult {
  taskId: string;
  taskType: UnifiedTask['type'];
  command: string;
}

function findTask(
  registry: TaskRegistry,
  taskId: string,
): UnifiedTask | undefined {
  return (
    registry.getByPublicId(taskId) ??
    registry.get(taskId) ??
    registry
      .all()
      .find(
        (task) =>
          (task.type === 'local_agent' ||
            task.type === 'in_process_teammate') &&
          (task.agentId === taskId || task.agentName === taskId),
      )
  );
}

function assertTaskOwner(
  task: UnifiedTask,
  callerAgentId: string | undefined,
  publicTaskId: string,
): void {
  if (callerAgentId !== undefined && task.ownerAgentId !== callerAgentId) {
    throw new TaskControlError(
      `Task ${publicTaskId} is owned by ${task.ownerAgentId ?? 'main session'}; agent ${callerAgentId} cannot stop it.`,
      'not_owner',
    );
  }
}

function emitStoppedAgentEvents(
  registry: TaskRegistry,
  task: AgentUnifiedTask,
  sessionId: string,
  publicTaskId: string,
  endTime: number,
): void {
  registry.update(task.id, {
    status: 'killed',
    endTime,
    notified: true,
  });
  ExecutionLifecycleService.markNotified(task.executionId);
  enqueueSubagentSdkEvent(
    sessionId,
    createTaskUpdatedEvent({
      sessionId,
      taskId: publicTaskId,
      status: 'killed',
      endTime,
    }),
  );
  enqueueSubagentSdkEvent(
    sessionId,
    createTaskNotificationEvent({
      sessionId,
      taskId: publicTaskId,
      toolUseId: task.toolUseId,
      status: 'stopped',
      outputFile: task.outputPath ?? '',
      summary: task.description,
    }),
  );
  enqueueBackgroundTasksChangedFromRegistry(sessionId, registry);
}

function emitStoppedInternalAgentEvents(
  registry: TaskRegistry,
  task: InternalAgentUnifiedTask,
  sessionId: string,
  publicTaskId: string,
  endTime: number,
): void {
  registry.update(task.id, {
    status: 'killed',
    endTime,
    notified: true,
  });
  ExecutionLifecycleService.markNotified(task.executionId);
  enqueueSubagentSdkEvent(
    sessionId,
    createTaskUpdatedEvent({
      sessionId,
      taskId: publicTaskId,
      status: 'killed',
      endTime,
    }),
  );
  enqueueSubagentSdkEvent(
    sessionId,
    createTaskNotificationEvent({
      sessionId,
      taskId: publicTaskId,
      toolUseId: task.toolUseId,
      status: 'stopped',
      outputFile: task.outputPath ?? '',
      summary: task.description,
    }),
  );
  enqueueBackgroundTasksChangedFromRegistry(sessionId, registry);
}

/** Stop exactly one task without aborting the main session turn. */
export async function stopTask(options: {
  registry: TaskRegistry;
  sessionId: string;
  taskId: string;
  callerAgentId?: string;
}): Promise<StopTaskResult> {
  const task = findTask(options.registry, options.taskId);
  if (
    !task ||
    (task.sessionId !== undefined && task.sessionId !== options.sessionId)
  ) {
    throw new TaskControlError(
      `No task found with ID: ${options.taskId}`,
      'not_found',
    );
  }

  const publicTaskId = task.publicId ?? task.id;
  if (task.status !== 'running') {
    throw new TaskControlError(
      `Task ${publicTaskId} is not running (status: ${task.status})`,
      'not_running',
    );
  }
  assertTaskOwner(task, options.callerAgentId, publicTaskId);

  if (
    task.type !== 'local_bash' &&
    task.type !== 'local_video_gen' &&
    task.type !== 'local_agent' &&
    task.type !== 'in_process_teammate' &&
    task.type !== 'local_workflow' &&
    (task.type !== 'internal_agent' || !task.killable)
  ) {
    throw new TaskControlError(
      `Unsupported task type: ${task.type}`,
      'unsupported_type',
    );
  }

  let killPromise: Promise<void> | undefined;

  if (task.type === 'local_workflow') {
    options.registry.kill(task.id, 'task_stop');
    const killedTask = options.registry.get(task.id);
    if (!killedTask) {
      throw new TaskControlError(
        `No task found with ID: ${publicTaskId}`,
        'not_found',
      );
    }
    if (
      killedTask.type !== 'local_workflow' ||
      killedTask.status !== 'killed' ||
      killedTask.endTime === undefined
    ) {
      throw new TaskControlError(
        `Task ${publicTaskId} is not running (status: ${killedTask.status})`,
        'not_running',
      );
    }
    options.registry.update(killedTask.id, { notified: true });
    enqueueSubagentSdkEvent(
      options.sessionId,
      createTaskUpdatedEvent({
        sessionId: options.sessionId,
        taskId: publicTaskId,
        status: 'killed',
        endTime: killedTask.endTime,
      }),
    );
    enqueueSubagentSdkEvent(
      options.sessionId,
      createTaskNotificationEvent({
        sessionId: options.sessionId,
        taskId: publicTaskId,
        toolUseId: killedTask.toolUseId,
        status: 'stopped',
        outputFile: killedTask.outputPath ?? '',
        summary: killedTask.description,
      }),
    );
    enqueueBackgroundTasksChangedFromRegistry(
      options.sessionId,
      options.registry,
    );
  } else if (
    task.type === 'local_agent' ||
    task.type === 'in_process_teammate'
  ) {
    // Initiate the lifecycle abort before publishing the terminal UI events.
    // Keep the same promise so the stop request is never issued twice.
    killPromise = ExecutionLifecycleService.kill(task.executionId);
    emitStoppedAgentEvents(
      options.registry,
      task,
      options.sessionId,
      publicTaskId,
      Date.now(),
    );
  } else if (task.type === 'internal_agent') {
    killPromise = ExecutionLifecycleService.kill(task.executionId, 'task_stop');
    emitStoppedInternalAgentEvents(
      options.registry,
      task,
      options.sessionId,
      publicTaskId,
      Date.now(),
    );
  }

  if (killPromise) {
    await killPromise;
  } else if (task.type === 'local_workflow') {
    await ExecutionLifecycleService.kill(task.executionId, 'task_stop');
  } else {
    await ExecutionLifecycleService.kill(task.executionId);
  }

  return {
    taskId: publicTaskId,
    taskType: task.type,
    command: task.type === 'local_bash' ? task.command : task.description,
  };
}
