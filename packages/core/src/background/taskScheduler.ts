/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BackgroundTaskRegistry,
  type BackgroundTaskStatus,
  type BackgroundTaskState,
} from './taskRegistry.js';
import { BackgroundTaskDrainer } from './taskDrainer.js';

export interface ScheduleBackgroundTaskParams {
  taskType: string;
  title: string;
  projectRoot: string;
  sessionId?: string;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
  run: (task: BackgroundTaskState) => Promise<{
    status?: BackgroundTaskStatus;
    progressText?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  } | void>;
}

export interface ScheduledBackgroundTask {
  taskId: string;
  promise: Promise<BackgroundTaskState>;
}

export class BackgroundTaskScheduler {
  private readonly inFlightByDedupeKey = new Map<string, string>();

  constructor(
    private readonly registry: BackgroundTaskRegistry,
    private readonly drainer: BackgroundTaskDrainer,
  ) {}

  schedule(params: ScheduleBackgroundTaskParams): ScheduledBackgroundTask {
    if (params.dedupeKey) {
      const existingTaskId = this.inFlightByDedupeKey.get(params.dedupeKey);
      if (existingTaskId) {
        const skipped = this.registry.register({
          taskType: params.taskType,
          title: params.title,
          projectRoot: params.projectRoot,
          sessionId: params.sessionId,
          dedupeKey: params.dedupeKey,
          metadata: {
            ...(params.metadata ?? {}),
            skippedBecauseOf: existingTaskId,
          },
        });
        this.registry.update(skipped.id, {
          status: 'skipped',
          progressText: `Skipped duplicate background task; existing task ${existingTaskId} is still running.`,
        });
        return {
          taskId: skipped.id,
          promise: Promise.resolve(this.registry.get(skipped.id) as BackgroundTaskState),
        };
      }
    }

    const task = this.registry.register({
      taskType: params.taskType,
      title: params.title,
      projectRoot: params.projectRoot,
      sessionId: params.sessionId,
      dedupeKey: params.dedupeKey,
      metadata: params.metadata,
    });
    this.registry.update(task.id, { status: 'running' });
    if (params.dedupeKey) {
      this.inFlightByDedupeKey.set(params.dedupeKey, task.id);
    }

    const promise = this.drainer.track(
      task.id,
      (async () => {
        try {
          const result = await params.run(this.registry.get(task.id) as BackgroundTaskState);
          const finalTask = this.registry.update(task.id, {
            status: result?.status ?? 'completed',
            progressText: result?.progressText,
            error: result?.error,
            metadata: result?.metadata,
          });
          return finalTask;
        } catch (error) {
          return this.registry.update(task.id, {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (params.dedupeKey) {
            this.inFlightByDedupeKey.delete(params.dedupeKey);
          }
        }
      })(),
    );

    return {
      taskId: task.id,
      promise,
    };
  }
}
