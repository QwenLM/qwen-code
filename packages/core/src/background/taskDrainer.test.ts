/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BackgroundTaskDrainer } from './taskDrainer.js';

describe('BackgroundTaskDrainer', () => {
  it('tracks tasks and drains successfully', async () => {
    const drainer = new BackgroundTaskDrainer();
    drainer.track('task-1', Promise.resolve('done'));

    await Promise.resolve();
    expect(await drainer.drain()).toBe(true);
    expect(drainer.getInFlightTaskIds()).toEqual([]);
  });

  it('returns false when drain times out', async () => {
    const drainer = new BackgroundTaskDrainer();
    let resolveTask: (() => void) | undefined;
    const blockingPromise = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });

    drainer.track('task-1', blockingPromise);

    await expect(drainer.drain({ timeoutMs: 10 })).resolves.toBe(false);
    resolveTask?.();
    await expect(drainer.drain()).resolves.toBe(true);
  });
});
