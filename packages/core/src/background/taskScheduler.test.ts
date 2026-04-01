/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { BackgroundTaskDrainer } from './taskDrainer.js';
import { BackgroundTaskRegistry } from './taskRegistry.js';
import { BackgroundTaskScheduler } from './taskScheduler.js';

describe('BackgroundTaskScheduler', () => {
  it('runs a background task and marks it completed', async () => {
    const registry = new BackgroundTaskRegistry();
    const drainer = new BackgroundTaskDrainer();
    const scheduler = new BackgroundTaskScheduler(registry, drainer);
    const run = vi.fn().mockResolvedValue({
      progressText: 'Finished extraction',
      metadata: { touchedTopics: ['user'] },
    });

    const scheduled = scheduler.schedule({
      taskType: 'memory-extract',
      title: 'Extract memory',
      projectRoot: '/tmp/project',
      run,
    });
    const finalTask = await scheduled.promise;

    expect(run).toHaveBeenCalledTimes(1);
    expect(finalTask.status).toBe('completed');
    expect(finalTask.progressText).toBe('Finished extraction');
    expect(finalTask.metadata).toEqual({ touchedTopics: ['user'] });
    expect(await drainer.drain()).toBe(true);
  });

  it('skips duplicate tasks that share a dedupe key while one is running', async () => {
    const registry = new BackgroundTaskRegistry();
    const drainer = new BackgroundTaskDrainer();
    const scheduler = new BackgroundTaskScheduler(registry, drainer);

    let resolveFirst: (() => void) | undefined;
    const first = scheduler.schedule({
      taskType: 'memory-dream',
      title: 'Dream memory',
      projectRoot: '/tmp/project',
      dedupeKey: 'dream:/tmp/project',
      run: () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    });

    const second = scheduler.schedule({
      taskType: 'memory-dream',
      title: 'Dream memory duplicate',
      projectRoot: '/tmp/project',
      dedupeKey: 'dream:/tmp/project',
      run: vi.fn(),
    });

    const skippedTask = await second.promise;
    expect(skippedTask.status).toBe('skipped');
    expect(skippedTask.metadata).toEqual(
      expect.objectContaining({
        skippedBecauseOf: first.taskId,
      }),
    );

    resolveFirst?.();
    const completedTask = await first.promise;
    expect(completedTask.status).toBe('completed');
  });
});
