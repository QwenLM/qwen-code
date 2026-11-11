/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExecutionLifecycleService,
  type BackgroundStartInfo,
  type BackgroundCompletionInfo,
} from '../services/executionLifecycleService.js';
import type { TaskRegistry } from './task-registry.js';
import type { BashUnifiedTask } from './unified-task.js';
import type { Config } from '../config/config.js';



import {
  createTaskUpdatedEvent,
  createTaskStartedEvent,
  enqueueBackgroundTasksChangedFromRegistry,
  enqueueSubagentSdkEvent,
} from '../agents/subagent-sdk-events.js';

/**
 * Bridge ExecutionLifecycleService events to a TaskRegistry.
 *
 * When a shell execution is backgrounded, automatically creates a BashUnifiedTask.
 * Agent executions are NOT handled here — they register themselves via subagent-tool.ts.
 *
 * @returns Cleanup function to remove all listeners.
 */
export function bridgeExecutionLifecycleToRegistry(
  registry: TaskRegistry,
  options?: { sessionId?: string; config?: Config },
): () => void {
  const subscriptionCleanups = new Map<number, () => void>();

  const onBackground = (info: BackgroundStartInfo): void => {
    if (
      options?.sessionId !== undefined &&
      info.sessionId !== options.sessionId
    ) {
      return;
    }

    // If already tracked (e.g. agent self-registered), just update isBackgrounded
    const existing = registry.getByExecutionId(info.executionId);
    if (existing) {
      if ('isBackgrounded' in existing && !existing.isBackgrounded) {
        registry.update(existing.id, {
          isBackgrounded: true,
        } as Partial<BashUnifiedTask>);
        const sessionId = info.sessionId ?? options?.sessionId;
        if (sessionId) {
          enqueueSubagentSdkEvent(
            sessionId,
            createTaskUpdatedEvent({
              sessionId,
              taskId: existing.publicId ?? existing.id,
              patch: { is_backgrounded: true },
            }),
          );
          enqueueBackgroundTasksChangedFromRegistry(sessionId, registry);
        }
      }
      return;
    }

    // Only auto-create tasks for child_process (shell) executions
    if (info.executionMethod !== 'child_process') return;

    const publicId = info.taskId ?? String(info.executionId);
    const taskId = `b-${publicId}`;
    const task: BashUnifiedTask = {
      id: taskId,
      publicId,
      sessionId: info.sessionId ?? 'default',
      ownerAgentId: info.ownerAgentId,
      type: 'local_bash',
      kind: info.taskKind ?? 'bash',
      status: 'running',
      description: info.label || 'Background command',
      startTime: Date.now(),
      notified: false,
      executionId: info.executionId,
      toolUseId: info.toolUseId,
      outputPath: info.outputPath,
      completionBehavior: info.completionBehavior,
      command: info.command ?? info.label ?? '',
      isBackgrounded: true,
      output: info.output || '',
    };

    registry.register(task);

    if (info.sessionId && info.taskId) {
      enqueueSubagentSdkEvent(
        info.sessionId,
        createTaskStartedEvent({
          sessionId: info.sessionId,
          taskId: info.taskId,
          toolUseId: info.toolUseId,
          description: task.description,
          taskType: 'local_bash',
        }),
      );
    }
    const sessionId = info.sessionId ?? options?.sessionId;
    if (sessionId) {
      enqueueBackgroundTasksChangedFromRegistry(sessionId, registry);
    }

    // Subscribe to output events
    const unsubOutput = ExecutionLifecycleService.subscribe(
      info.executionId,
      (event) => {
        if (event.type === 'data') {
          if (event.isSnapshot) {
            registry.updateBashOutput(taskId, event.chunk, true);
          } else {
            registry.appendBashOutput(taskId, event.chunk, true);
          }
        }
      },
    );

    // Subscribe to exit events
    const unsubExit = ExecutionLifecycleService.onExit(
      info.executionId,
      (exitCode, signal) => {
        const status =
          info.shellType === 'powershell' &&
          signal !== undefined &&
          signal !== null
            ? 'killed'
            : exitCode === 0
              ? 'completed'
              : exitCode === 130
                ? 'killed'
                : 'failed';
        registry.update(taskId, {
          status,
          endTime: Date.now(),
          exitCode,
          notified: true,
        } as Partial<BashUnifiedTask>);
        if (sessionId) {
          enqueueBackgroundTasksChangedFromRegistry(sessionId, registry);
        }

        // Cleanup subscriptions for this execution
        const cleanup = subscriptionCleanups.get(info.executionId);
        if (cleanup) {
          cleanup();
          subscriptionCleanups.delete(info.executionId);
        }
      },
    );

    subscriptionCleanups.set(info.executionId, () => {
      unsubOutput();
      unsubExit();
    });
  };

  const onComplete = (info: BackgroundCompletionInfo): void => {
    const task = registry.getByExecutionId(info.executionId);
    if (!task) return;

    if (task.type === 'local_bash') {
      registry.update(task.id, {
        notified: true,
        output: info.output,
      } as Partial<BashUnifiedTask>);
    }
  };

  ExecutionLifecycleService.onBackground(onBackground);
  ExecutionLifecycleService.onBackgroundComplete(onComplete);

  return () => {
    ExecutionLifecycleService.offBackground(onBackground);
    ExecutionLifecycleService.offBackgroundComplete(onComplete);
    for (const cleanup of subscriptionCleanups.values()) {
      cleanup();
    }
    subscriptionCleanups.clear();
  };
}
