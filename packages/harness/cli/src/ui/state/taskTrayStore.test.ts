/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TaskListItem,
  TaskStore,
} from '@qwen-code/core';
import { TaskTrayStore } from './taskTrayStore.js';

function runningTask(): TaskListItem {
  return {
    id: '1',
    subject: 'Run checks',
    description: '',
    status: 'in_progress',
    blocks: [],
    blockedBy: [],
  };
}

function completedTask(): TaskListItem {
  return { ...runningTask(), status: 'completed' };
}

describe('TaskTrayStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces change signals and uses a five-second active-task watchdog', async () => {
    vi.useFakeTimers();
    let notifyLocalChange: (() => void) | undefined;
    let notifyFileChange: (() => void) | undefined;
    const store = {
      listTasks: vi.fn().mockResolvedValue([runningTask()]),
      onDidChange: vi.fn((listener: () => void) => {
        notifyLocalChange = listener;
        return vi.fn();
      }),
      watch: vi.fn(async (listener: () => void) => {
        notifyFileChange = listener;
        return vi.fn();
      }),
      clearCompletedTasks: vi.fn(),
    } as unknown as TaskStore;
    const taskTrayStore = new TaskTrayStore(store);
    const dispose = taskTrayStore.subscribe(vi.fn());

    await vi.advanceTimersByTimeAsync(0);
    expect(store.listTasks).toHaveBeenCalledTimes(1);

    notifyLocalChange?.();
    notifyFileChange?.();
    notifyLocalChange?.();
    await vi.advanceTimersByTimeAsync(49);
    expect(store.listTasks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.listTasks).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(store.listTasks).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.listTasks).toHaveBeenCalledTimes(3);

    dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.listTasks).toHaveBeenCalledTimes(3);
  });

  it('does not publish a new snapshot for metadata-only changes', async () => {
    let notifyLocalChange: (() => void) | undefined;
    const first = runningTask();
    const second = { ...first, metadata: { source: 'agent' } };
    const store = {
      listTasks: vi
        .fn()
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([second]),
      onDidChange: vi.fn((listener: () => void) => {
        notifyLocalChange = listener;
        return vi.fn();
      }),
      watch: vi.fn().mockResolvedValue(vi.fn()),
      clearCompletedTasks: vi.fn(),
    } as unknown as TaskStore;
    const listener = vi.fn();
    const taskTrayStore = new TaskTrayStore(store);
    const dispose = taskTrayStore.subscribe(listener);

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    const initialSnapshot = taskTrayStore.getSnapshot();
    notifyLocalChange?.();
    await vi.waitFor(() => expect(store.listTasks).toHaveBeenCalledTimes(2));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(taskTrayStore.getSnapshot()).toBe(initialSnapshot);
    dispose();
  });

  it('does not poll an empty task list while file watching is available', async () => {
    vi.useFakeTimers();
    const store = {
      listTasks: vi.fn().mockResolvedValue([]),
      onDidChange: vi.fn().mockReturnValue(vi.fn()),
      watch: vi.fn().mockResolvedValue(vi.fn()),
      clearCompletedTasks: vi.fn(),
    } as unknown as TaskStore;
    const taskTrayStore = new TaskTrayStore(store);
    const dispose = taskTrayStore.subscribe(vi.fn());

    await vi.advanceTimersByTimeAsync(60_000);

    expect(store.listTasks).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('clears the persisted task list five seconds after all tasks complete', async () => {
    vi.useFakeTimers();
    let persistedTasks: TaskListItem[] = [completedTask()];
    const clearCompletedTasks = vi.fn(async () => {
      persistedTasks = [];
      return 1;
    });
    const store = {
      listTasks: vi.fn(async () => persistedTasks),
      onDidChange: vi.fn().mockReturnValue(vi.fn()),
      watch: vi.fn().mockResolvedValue(vi.fn()),
      clearCompletedTasks,
    } as unknown as TaskStore;
    const taskTrayStore = new TaskTrayStore(store);
    const dispose = taskTrayStore.subscribe(vi.fn());

    await vi.advanceTimersByTimeAsync(4_999);
    expect(clearCompletedTasks).not.toHaveBeenCalled();
    expect(taskTrayStore.getSnapshot()).toEqual([completedTask()]);

    await vi.advanceTimersByTimeAsync(1);
    expect(clearCompletedTasks).toHaveBeenCalledTimes(1);
    expect(taskTrayStore.getSnapshot()).toEqual([]);
    dispose();
  });

  it('retries completed task cleanup after a failure', async () => {
    vi.useFakeTimers();
    let persistedTasks: TaskListItem[] = [completedTask()];
    const clearCompletedTasks = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('temporary cleanup failure'))
      .mockImplementationOnce(async () => {
        persistedTasks = [];
        return 1;
      });
    const store = {
      listTasks: vi.fn(async () => persistedTasks),
      onDidChange: vi.fn().mockReturnValue(vi.fn()),
      watch: vi.fn().mockResolvedValue(vi.fn()),
      clearCompletedTasks,
    } as unknown as TaskStore;
    const taskTrayStore = new TaskTrayStore(store);
    const dispose = taskTrayStore.subscribe(vi.fn());

    await vi.advanceTimersByTimeAsync(5_000);
    expect(clearCompletedTasks).toHaveBeenCalledTimes(1);
    expect(taskTrayStore.getSnapshot()).toEqual([completedTask()]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(clearCompletedTasks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(clearCompletedTasks).toHaveBeenCalledTimes(2);
    expect(taskTrayStore.getSnapshot()).toEqual([]);
    dispose();
  });

  it('discards a refresh that completes after the store restarts', async () => {
    let resolveStaleRefresh:
      | ((tasks: TaskListItem[]) => void)
      | undefined;
    const staleRefresh = new Promise<TaskListItem[]>((resolve) => {
      resolveStaleRefresh = resolve;
    });
    const store = {
      listTasks: vi
        .fn()
        .mockReturnValueOnce(staleRefresh)
        .mockResolvedValueOnce([
          {
            ...runningTask(),
            subject: 'Current snapshot',
          },
        ]),
      onDidChange: vi.fn().mockReturnValue(vi.fn()),
      watch: vi.fn().mockResolvedValue(vi.fn()),
      clearCompletedTasks: vi.fn(),
    } as unknown as TaskStore;
    const taskTrayStore = new TaskTrayStore(store);
    const disposeFirstSubscription = taskTrayStore.subscribe(vi.fn());
    disposeFirstSubscription();
    const currentListener = vi.fn();
    const disposeCurrentSubscription =
      taskTrayStore.subscribe(currentListener);

    resolveStaleRefresh?.([
      {
        ...runningTask(),
        subject: 'Stale snapshot',
      },
    ]);

    await vi.waitFor(() =>
      expect(store.listTasks).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(currentListener).toHaveBeenCalledTimes(1));

    expect(taskTrayStore.getSnapshot()[0]?.subject).toBe('Current snapshot');
    disposeCurrentSubscription();
  });
});
