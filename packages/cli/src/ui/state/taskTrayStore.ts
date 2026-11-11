/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isInternalTask,
  runLogger,
  type TaskListItem,
  type TaskStore,
} from '@qwen-code/core';

const CHANGE_DEBOUNCE_MS = 50;
const WATCHDOG_INTERVAL_MS = 5_000;
const COMPLETED_TASK_CLEANUP_DELAY_MS = 5_000;
const EMPTY_TASKS: readonly TaskListItem[] = Object.freeze([]);

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function taskTraySnapshotsEqual(
  left: readonly TaskListItem[],
  right: readonly TaskListItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every((task, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        task.id === candidate.id &&
        task.subject === candidate.subject &&
        task.description === candidate.description &&
        task.activeForm === candidate.activeForm &&
        task.owner === candidate.owner &&
        task.status === candidate.status &&
        arraysEqual(task.blocks, candidate.blocks) &&
        arraysEqual(task.blockedBy, candidate.blockedBy)
      );
    })
  );
}

export class TaskTrayStore {
  private readonly listeners = new Set<() => void>();
  private readonly backgroundErrors = new Map<string, string>();
  private snapshot: readonly TaskListItem[] = EMPTY_TASKS;
  private active = false;
  private generation = 0;
  private refreshRunning = false;
  private refreshRequested = false;
  private watchFailed = false;
  private stopLocalChanges: (() => void) | undefined;
  private stopWatching: (() => void) | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly taskStore: TaskStore) {}

  readonly getSnapshot = (): readonly TaskListItem[] => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.active) {
      this.start();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  };

  private start(): void {
    this.active = true;
    const generation = ++this.generation;
    this.stopLocalChanges = this.taskStore.onDidChange(() => {
      this.scheduleRefresh();
    });
    void this.taskStore
      .watch(() => {
        this.scheduleRefresh();
      })
      .then((stop) => {
        this.clearBackgroundError('watch');
        if (!this.active || generation !== this.generation) {
          stop();
          return;
        }
        this.watchFailed = false;
        this.stopWatching = stop;
      })
      .catch((error: unknown) => {
        if (!this.active || generation !== this.generation) {
          return;
        }
        this.watchFailed = true;
        this.recordBackgroundError('watch', error);
        this.scheduleWatchdog(true);
      });
    this.requestRefresh();
  }

  private stop(): void {
    this.active = false;
    this.generation += 1;
    this.refreshRequested = false;
    this.clearTimer('debounce');
    this.clearTimer('watchdog');
    this.clearTimer('cleanup');
    this.stopLocalChanges?.();
    this.stopLocalChanges = undefined;
    this.stopWatching?.();
    this.stopWatching = undefined;
  }

  private clearTimer(
    timer: 'debounce' | 'watchdog' | 'cleanup',
  ): void {
    const key = `${timer}Timer` as const;
    const handle = this[key];
    if (handle) {
      clearTimeout(handle);
      this[key] = undefined;
    }
  }

  private scheduleRefresh(): void {
    if (!this.active) {
      return;
    }
    this.clearTimer('debounce');
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.requestRefresh();
    }, CHANGE_DEBOUNCE_MS);
    unrefTimer(this.debounceTimer);
  }

  private requestRefresh(): void {
    this.refreshRequested = true;
    if (this.refreshRunning) {
      return;
    }
    void this.refresh(this.generation);
  }

  private async refresh(generation: number): Promise<void> {
    this.refreshRunning = true;
    try {
      while (
        this.refreshRequested &&
        this.active &&
        generation === this.generation
      ) {
        this.refreshRequested = false;
        const allTasks = await this.taskStore.listTasks();
        if (
          !this.active ||
          generation !== this.generation ||
          this.refreshRequested
        ) {
          continue;
        }

        this.clearBackgroundError('refresh');
        const visibleTasks = allTasks.filter((task) => !isInternalTask(task));
        this.updateCleanupSchedule(allTasks, visibleTasks);
        this.scheduleWatchdog(
          this.watchFailed ||
            allTasks.some((task) => task.status !== 'completed'),
        );
        if (!taskTraySnapshotsEqual(this.snapshot, visibleTasks)) {
          this.snapshot =
            visibleTasks.length === 0 ? EMPTY_TASKS : visibleTasks;
          this.emitChange();
        }
      }
    } catch (error) {
      this.refreshRequested = false;
      if (this.active && generation === this.generation) {
        this.recordBackgroundError('refresh', error);
        this.scheduleWatchdog(true);
      }
    } finally {
      this.refreshRunning = false;
      if (this.refreshRequested && this.active) {
        this.requestRefresh();
      }
    }
  }

  private scheduleWatchdog(needed: boolean): void {
    this.clearTimer('watchdog');
    if (!this.active || !needed) {
      return;
    }
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = undefined;
      this.requestRefresh();
    }, WATCHDOG_INTERVAL_MS);
    unrefTimer(this.watchdogTimer);
  }

  private updateCleanupSchedule(
    allTasks: readonly TaskListItem[],
    visibleTasks: readonly TaskListItem[],
  ): void {
    const shouldSchedule =
      visibleTasks.length > 0 &&
      allTasks.every((task) => task.status === 'completed');
    if (!shouldSchedule) {
      this.clearTimer('cleanup');
      return;
    }
    if (this.cleanupTimer) {
      return;
    }
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      void this.taskStore
        .clearCompletedTasks()
        .then(() => {
          this.clearBackgroundError('cleanup');
          this.requestRefresh();
        })
        .catch((error: unknown) => {
          this.recordBackgroundError('cleanup', error);
          // Re-read the task set before retrying. If every visible task is
          // still completed, updateCleanupSchedule() installs a fresh
          // five-second timer; if the task set changed, cleanup stays off.
          this.requestRefresh();
        });
    }, COMPLETED_TASK_CLEANUP_DELAY_MS);
    unrefTimer(this.cleanupTimer);
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private recordBackgroundError(operation: string, error: unknown): void {
    const message =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (this.backgroundErrors.get(operation) === message) {
      return;
    }
    this.backgroundErrors.set(operation, message);
    runLogger.warn(`[TaskTray] ${operation} failed: ${message}`);
  }

  private clearBackgroundError(operation: string): void {
    this.backgroundErrors.delete(operation);
  }
}

const taskTrayStores = new WeakMap<TaskStore, TaskTrayStore>();

export function getTaskTrayStore(taskStore: TaskStore): TaskTrayStore {
  const existing = taskTrayStores.get(taskStore);
  if (existing) {
    return existing;
  }
  const created = new TaskTrayStore(taskStore);
  taskTrayStores.set(taskStore, created);
  return created;
}

export const emptyTaskTrayStore = {
  getSnapshot: () => EMPTY_TASKS,
  subscribe: () => () => {},
};
