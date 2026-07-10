/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createFifoTaskQueue } from './extension-operation-scheduler.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('createFifoTaskQueue', () => {
  it('runs at most the configured number of tasks', async () => {
    const queue = createFifoTaskQueue(2);
    const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
    let active = 0;
    let peak = 0;
    const tasks = releases.map((release) =>
      queue.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await release.promise;
        active -= 1;
      }),
    );

    await vi.waitFor(() => expect(active).toBe(2));
    releases[0]!.resolve();
    await vi.waitFor(() => expect(active).toBe(2));
    releases[1]!.resolve();
    releases[2]!.resolve();
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });

  it('starts queued tasks in FIFO order', async () => {
    const queue = createFifoTaskQueue(1);
    const release = deferred<void>();
    const started: number[] = [];
    const first = queue.run(async () => {
      started.push(1);
      await release.promise;
    });
    const second = queue.run(async () => {
      started.push(2);
    });
    const third = queue.run(async () => {
      started.push(3);
    });

    await vi.waitFor(() => expect(started).toEqual([1]));
    release.resolve();
    await Promise.all([first, second, third]);
    expect(started).toEqual([1, 2, 3]);
  });

  it('removes an aborted queued task without starting it', async () => {
    const queue = createFifoTaskQueue(1);
    const release = deferred<void>();
    const controller = new AbortController();
    let started = false;
    const first = queue.run(async () => await release.promise);
    const queued = queue.run(
      async () => {
        started = true;
      },
      { signal: controller.signal },
    );

    controller.abort(new Error('deadline'));
    await expect(queued).rejects.toThrow('deadline');
    release.resolve();
    await first;
    expect(started).toBe(false);
  });

  it('holds an active slot until a non-cooperative task settles', async () => {
    const queue = createFifoTaskQueue(1);
    const controller = new AbortController();
    const release = deferred<void>();
    let secondStarted = false;
    const first = queue.run(async () => await release.promise, {
      signal: controller.signal,
    });
    const second = queue.run(async () => {
      secondStarted = true;
    });

    controller.abort(new Error('deadline'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondStarted).toBe(false);
    release.resolve();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });

  it('calls onStart only when the task acquires a slot', async () => {
    const queue = createFifoTaskQueue(1);
    const release = deferred<void>();
    const onStart = vi.fn();
    const first = queue.run(async () => await release.promise);
    const second = queue.run(async () => undefined, { onStart });

    expect(onStart).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, second]);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('releases the slot when onStart throws', async () => {
    const queue = createFifoTaskQueue(1);
    let secondStarted = false;
    const first = queue.run(async () => undefined, {
      onStart: () => {
        throw new Error('start failed');
      },
    });
    const second = queue.run(async () => {
      secondStarted = true;
    });

    await expect(first).rejects.toThrow('start failed');
    await second;
    expect(secondStarted).toBe(true);
  });
});
