/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface DrainBackgroundTasksOptions {
  timeoutMs?: number;
}

export class BackgroundTaskDrainer {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  track<T>(taskId: string, promise: Promise<T>): Promise<T> {
    this.inFlight.set(taskId, promise);
    promise.finally(() => {
      this.inFlight.delete(taskId);
    });
    return promise;
  }

  getInFlightTaskIds(): string[] {
    return [...this.inFlight.keys()];
  }

  async drain(options: DrainBackgroundTasksOptions = {}): Promise<boolean> {
    const promises = [...this.inFlight.values()];
    if (promises.length === 0) {
      return true;
    }

    const waitForTasks = Promise.allSettled(promises).then(() => true);
    if (!options.timeoutMs || options.timeoutMs <= 0) {
      return waitForTasks;
    }

    return Promise.race<boolean>([
      waitForTasks,
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), options.timeoutMs);
      }),
    ]);
  }
}
