/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type { Config } from '../config/config.js';
import {
  BackgroundTaskDrainer,
  type DrainBackgroundTasksOptions,
} from '../background/taskDrainer.js';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskState,
} from '../background/taskRegistry.js';
import {
  type AutoMemoryExtractResult,
  runAutoMemoryExtract,
} from './extract.js';
import {
  clearExtractRunning,
  isExtractRunning,
  markExtractRunning,
} from './state.js';
import { isAutoMemPath } from './paths.js';

export interface ScheduleAutoMemoryExtractParams {
  projectRoot: string;
  sessionId: string;
  history: Content[];
  now?: Date;
  config?: Config;
}

interface QueuedExtractionRequest {
  taskId: string;
  params: ScheduleAutoMemoryExtractParams;
}

function buildSkippedExtractResult(
  params: ScheduleAutoMemoryExtractParams,
  skippedReason: AutoMemoryExtractResult['skippedReason'],
): AutoMemoryExtractResult {
  return {
    patches: [],
    touchedTopics: [],
    skippedReason,
    cursor: {
      sessionId: params.sessionId,
      updatedAt: (params.now ?? new Date()).toISOString(),
    },
  };
}

/**
 * Returns true if the part is a write-tool call targeting a file path inside
 * the auto-memory directory (write_file / edit / replace / create_file).
 */
function partWritesToMemory(part: Part, projectRoot: string): boolean {
  // Direct write_file or edit tool calls to a memory path
  const writeToolNames = new Set(['write_file', 'edit', 'replace', 'create_file']);
  const name = part.functionCall?.name;
  if (name && writeToolNames.has(name)) {
    const args = part.functionCall?.args as Record<string, unknown> | undefined;
    const filePath = args?.['file_path'] ?? args?.['path'] ?? args?.['target_file'];
    if (typeof filePath === 'string' && isAutoMemPath(filePath, projectRoot)) {
      return true;
    }
  }
  return false;
}

function historySliceUsesMemoryTool(history: Content[], projectRoot: string): boolean {
  return history.some((message) =>
    (message.parts ?? []).some((part) => partWritesToMemory(part, projectRoot)),
  );
}

export class ManagedAutoMemoryExtractRuntime {
  readonly registry = new BackgroundTaskRegistry();
  readonly drainer = new BackgroundTaskDrainer();

  private readonly currentTaskIdByProject = new Map<string, string>();
  private readonly queuedByProject = new Map<string, QueuedExtractionRequest>();

  async schedule(
    params: ScheduleAutoMemoryExtractParams,
  ): Promise<AutoMemoryExtractResult> {
    if (historySliceUsesMemoryTool(params.history, params.projectRoot)) {
      const task = this.registry.register({
        taskType: 'managed-auto-memory-extraction',
        title: 'Managed auto-memory extraction',
        projectRoot: params.projectRoot,
        sessionId: params.sessionId,
        metadata: {
          skippedReason: 'memory_tool',
          historyLength: params.history.length,
        },
      });
      this.registry.update(task.id, {
        status: 'skipped',
        progressText:
          'Skipped managed auto-memory extraction: main agent wrote to memory files this turn.',
      });
      return buildSkippedExtractResult(params, 'memory_tool');
    }

    if (isExtractRunning(params.projectRoot)) {
      const currentTaskId = this.currentTaskIdByProject.get(params.projectRoot);
      if (!currentTaskId) {
        return buildSkippedExtractResult(params, 'already_running');
      }

      const queued = this.queuedByProject.get(params.projectRoot);
      if (queued) {
        queued.params = params;
        this.registry.update(queued.taskId, {
          status: 'pending',
          progressText:
            'Updated trailing managed auto-memory extraction request while another extraction is running.',
          metadata: {
            queuedBehindTaskId: currentTaskId,
            historyLength: params.history.length,
            supersededAt: new Date().toISOString(),
          },
        });
      } else {
        const pendingTask = this.registry.register({
          taskType: 'managed-auto-memory-extraction',
          title: 'Managed auto-memory extraction',
          projectRoot: params.projectRoot,
          sessionId: params.sessionId,
          metadata: {
            trailing: true,
            queuedBehindTaskId: currentTaskId,
            historyLength: params.history.length,
          },
        });
        this.registry.update(pendingTask.id, {
          status: 'pending',
          progressText:
            'Queued trailing managed auto-memory extraction until the active extraction completes.',
        });
        this.queuedByProject.set(params.projectRoot, {
          taskId: pendingTask.id,
          params,
        });
      }

      return buildSkippedExtractResult(params, 'queued');
    }

    const task = this.registry.register({
      taskType: 'managed-auto-memory-extraction',
      title: 'Managed auto-memory extraction',
      projectRoot: params.projectRoot,
      sessionId: params.sessionId,
      metadata: {
        historyLength: params.history.length,
      },
    });

    return this.drainer.track(task.id, this.runTask(task.id, params));
  }

  listTasks(projectRoot?: string): BackgroundTaskState[] {
    return this.registry.list(projectRoot);
  }

  drain(options?: DrainBackgroundTasksOptions): Promise<boolean> {
    return this.drainer.drain(options);
  }

  resetForTests(): void {
    this.currentTaskIdByProject.clear();
    this.queuedByProject.clear();
  }

  private async runTask(
    taskId: string,
    params: ScheduleAutoMemoryExtractParams,
  ): Promise<AutoMemoryExtractResult> {
    this.currentTaskIdByProject.set(params.projectRoot, taskId);
    markExtractRunning(params.projectRoot);
    this.registry.update(taskId, {
      status: 'running',
      progressText: 'Running managed auto-memory extraction.',
      metadata: {
        historyLength: params.history.length,
      },
    });

    try {
      const result = await runAutoMemoryExtract(params);
      this.registry.update(taskId, {
        status: result.skippedReason ? 'skipped' : 'completed',
        progressText:
          result.systemMessage ??
          (result.patches.length > 0
            ? `Planned ${result.patches.length} managed auto-memory patch${result.patches.length === 1 ? '' : 'es'}.`
            : 'Managed auto-memory extraction completed without durable changes.'),
        metadata: {
          patchCount: result.patches.length,
          touchedTopics: result.touchedTopics,
          processedOffset: result.cursor.processedOffset,
          skippedReason: result.skippedReason,
        },
      });
      return result;
    } catch (error) {
      this.registry.update(taskId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.currentTaskIdByProject.delete(params.projectRoot);
      clearExtractRunning(params.projectRoot);
      void this.startQueuedIfNeeded(params.projectRoot);
    }
  }

  private async startQueuedIfNeeded(projectRoot: string): Promise<void> {
    if (isExtractRunning(projectRoot)) {
      return;
    }

    const queued = this.queuedByProject.get(projectRoot);
    if (!queued) {
      return;
    }

    this.queuedByProject.delete(projectRoot);
    await this.drainer.track(
      queued.taskId,
      this.runTask(queued.taskId, queued.params),
    );
  }
}

const defaultManagedAutoMemoryExtractRuntime =
  new ManagedAutoMemoryExtractRuntime();

export async function scheduleManagedAutoMemoryExtract(
  params: ScheduleAutoMemoryExtractParams,
): Promise<AutoMemoryExtractResult> {
  return defaultManagedAutoMemoryExtractRuntime.schedule(params);
}

export function getManagedAutoMemoryExtractTaskRegistry(): BackgroundTaskRegistry {
  return defaultManagedAutoMemoryExtractRuntime.registry;
}

export async function drainManagedAutoMemoryExtractTasks(
  options?: DrainBackgroundTasksOptions,
): Promise<boolean> {
  return defaultManagedAutoMemoryExtractRuntime.drain(options);
}

export function createManagedAutoMemoryExtractRuntimeForTests(): ManagedAutoMemoryExtractRuntime {
  return new ManagedAutoMemoryExtractRuntime();
}

export function resetManagedAutoMemoryExtractRuntimeForTests(): void {
  defaultManagedAutoMemoryExtractRuntime.resetForTests();
}