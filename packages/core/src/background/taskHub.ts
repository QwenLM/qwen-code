/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BackgroundTaskHub — a general-purpose container that groups one
 * BackgroundTaskRegistry and one BackgroundTaskDrainer into a single
 * injectable unit.
 *
 * Design goals:
 * - Zero knowledge of any specific task type (extract, dream, …).
 *   Task-type constants live in the runtimes that own them.
 * - Any future background task runtime plugs in by accepting a
 *   `hub: BackgroundTaskHub = globalBackgroundTaskHub` parameter —
 *   no new infrastructure needed.
 * - Tests receive a `new BackgroundTaskHub()` for full isolation;
 *   production runtimes share `globalBackgroundTaskHub`.
 */

import { BackgroundTaskDrainer } from './taskDrainer.js';
import type { DrainBackgroundTasksOptions } from './taskDrainer.js';
import { BackgroundTaskRegistry } from './taskRegistry.js';
import type { BackgroundTaskState } from './taskRegistry.js';
import { BackgroundTaskScheduler } from './taskScheduler.js';

export class BackgroundTaskHub {
  readonly registry: BackgroundTaskRegistry;
  readonly drainer: BackgroundTaskDrainer;

  constructor(
    registry = new BackgroundTaskRegistry(),
    drainer = new BackgroundTaskDrainer(),
  ) {
    this.registry = registry;
    this.drainer = drainer;
  }

  /**
   * Create a BackgroundTaskScheduler wired to this hub's shared registry and
   * drainer. Each runtime that needs deduplication should call this once at
   * construction time rather than instantiating a scheduler directly.
   */
  createScheduler(): BackgroundTaskScheduler {
    return new BackgroundTaskScheduler(this.registry, this.drainer);
  }

  /**
   * Return all tasks whose `taskType` matches, optionally scoped to a
   * projectRoot. Use this to build typed views without coupling the hub to
   * any specific task domain.
   *
   * @example
   *   hub.listByType(EXTRACT_TASK_TYPE, projectRoot)
   *   hub.listByType(DREAM_TASK_TYPE)
   */
  listByType(taskType: string, projectRoot?: string): BackgroundTaskState[] {
    return this.registry
      .list(projectRoot)
      .filter((t) => t.taskType === taskType);
  }

  async drain(options?: DrainBackgroundTasksOptions): Promise<boolean> {
    return this.drainer.drain(options);
  }
}

/**
 * Application-wide singleton — shared by all background task runtimes in
 * production. Each runtime accepts a hub via constructor injection and defaults
 * to this value, so tests can pass a fresh `new BackgroundTaskHub()` without
 * touching the global state.
 */
export const globalBackgroundTaskHub = new BackgroundTaskHub();
