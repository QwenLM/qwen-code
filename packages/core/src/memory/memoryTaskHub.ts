/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MemoryBackgroundTaskHub — single shared Registry + Drainer for all
 * memory background tasks (extract and dream).
 *
 * Both ManagedAutoMemoryExtractRuntime and ManagedAutoMemoryDreamRuntime
 * accept a hub instance via constructor injection, defaulting to the
 * module-level singleton `defaultMemoryTaskHub`.
 *
 * Benefits over two separate registries:
 * - status.ts queries one place instead of manually aggregating two
 * - drainAllMemoryTasks() works across both task types at once
 * - Single listener subscription covers all memory activity
 * - Tests receive a fresh hub per test suite (fully isolated)
 */

import {
  BackgroundTaskDrainer,
  type DrainBackgroundTasksOptions,
} from '../background/taskDrainer.js';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskState,
} from '../background/taskRegistry.js';

export const EXTRACT_TASK_TYPE = 'managed-auto-memory-extraction' as const;
export const DREAM_TASK_TYPE = 'managed-auto-memory-dream' as const;

export class MemoryBackgroundTaskHub {
  readonly registry: BackgroundTaskRegistry;
  readonly drainer: BackgroundTaskDrainer;

  constructor(
    registry = new BackgroundTaskRegistry(),
    drainer = new BackgroundTaskDrainer(),
  ) {
    this.registry = registry;
    this.drainer = drainer;
  }

  listExtractTasks(projectRoot?: string): BackgroundTaskState[] {
    return this.registry
      .list(projectRoot)
      .filter((t) => t.taskType === EXTRACT_TASK_TYPE);
  }

  listDreamTasks(projectRoot?: string): BackgroundTaskState[] {
    return this.registry
      .list(projectRoot)
      .filter((t) => t.taskType === DREAM_TASK_TYPE);
  }

  async drain(options?: DrainBackgroundTasksOptions): Promise<boolean> {
    return this.drainer.drain(options);
  }
}

/** Module-level singleton shared by all production extract/dream runtimes. */
export const defaultMemoryTaskHub = new MemoryBackgroundTaskHub();

/**
 * Drain all in-flight memory background tasks (extract + dream) for use in
 * tests or CLI shutdown.
 */
export async function drainAllMemoryBackgroundTasks(
  options?: DrainBackgroundTasksOptions,
): Promise<boolean> {
  return defaultMemoryTaskHub.drain(options);
}
