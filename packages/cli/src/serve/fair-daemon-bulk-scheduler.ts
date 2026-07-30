/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const DAEMON_BULK_GLOBAL_ACTIVE_LIMIT = 4;
export const DAEMON_BULK_GLOBAL_WAIT_LIMIT = 128;
export const DAEMON_BULK_WORKSPACE_ACTIVE_LIMIT = 1;
export const DAEMON_BULK_WORKSPACE_WAIT_LIMIT = 16;
export const DAEMON_SPAWN_GLOBAL_ACTIVE_LIMIT = 4;
export const DAEMON_SPAWN_GLOBAL_WAIT_LIMIT = 128;
export const DAEMON_SPAWN_WORKSPACE_WAIT_LIMIT = 16;
export const DAEMON_PROCESS_GLOBAL_ACTIVE_LIMIT = 4;
export const DAEMON_PROCESS_GLOBAL_WAIT_LIMIT = 128;
export const DAEMON_PROCESS_WORKSPACE_WAIT_LIMIT = 16;
export const DAEMON_SCHEDULER_WAIT_TIMEOUT_MS = 30_000;

interface FairDaemonSchedulerOptions {
  globalActiveLimit?: number;
  globalWaitLimit?: number;
  workspaceActiveLimit?: number;
  workspaceWaitLimit?: number;
  waitTimeoutMs?: number;
  lane?: 'daemon_bulk' | 'daemon_spawn' | 'daemon_process';
}

interface QueueItem {
  readonly workspaceCwd: string;
  readonly operation: string;
  readonly task: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
  waitTimer?: NodeJS.Timeout;
}

interface DaemonSchedulerExecution {
  readonly scheduler: FairDaemonBulkScheduler;
  readonly lane: 'daemon_bulk' | 'daemon_spawn' | 'daemon_process';
  active: boolean;
}

const runningScheduler = new AsyncLocalStorage<DaemonSchedulerExecution>();

export class DaemonBulkAdmissionError extends Error {
  readonly data: {
    errorKind: string;
    httpStatus: 503;
    actualBytesKnown: false;
    retryable: true;
  };

  constructor(errorKind = 'daemon_bulk_queue_full') {
    super('Daemon bulk-operation capacity is temporarily exhausted');
    this.name = 'DaemonBulkAdmissionError';
    this.data = {
      errorKind,
      httpStatus: 503,
      actualBytesKnown: false,
      retryable: true,
    };
  }
}

export class FairDaemonBulkScheduler {
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly workspaceOrder: string[] = [];
  private readonly activeByWorkspace = new Map<string, number>();
  private active = 0;
  private waiting = 0;
  private sealed = false;
  private readonly globalActiveLimit: number;
  private readonly globalWaitLimit: number;
  private readonly workspaceActiveLimit: number;
  private readonly workspaceWaitLimit: number;
  private readonly waitTimeoutMs: number;
  private readonly lane: 'daemon_bulk' | 'daemon_spawn' | 'daemon_process';

  constructor(options: FairDaemonSchedulerOptions = {}) {
    this.globalActiveLimit =
      options.globalActiveLimit ?? DAEMON_BULK_GLOBAL_ACTIVE_LIMIT;
    this.globalWaitLimit =
      options.globalWaitLimit ?? DAEMON_BULK_GLOBAL_WAIT_LIMIT;
    this.workspaceActiveLimit =
      options.workspaceActiveLimit ?? DAEMON_BULK_WORKSPACE_ACTIVE_LIMIT;
    this.workspaceWaitLimit =
      options.workspaceWaitLimit ?? DAEMON_BULK_WORKSPACE_WAIT_LIMIT;
    this.waitTimeoutMs =
      options.waitTimeoutMs ?? DAEMON_SCHEDULER_WAIT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.waitTimeoutMs) || this.waitTimeoutMs < 1) {
      throw new TypeError('waitTimeoutMs must be a positive safe integer');
    }
    this.lane = options.lane ?? 'daemon_bulk';
  }

  run<T>(
    workspaceCwd: string,
    operation: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const running = runningScheduler.getStore();
    if (running?.active) {
      const errorKind =
        running.scheduler === this
          ? `nested_${this.lane}_operation`
          : `nested_${running.lane}_to_${this.lane}_operation`;
      return Promise.reject(new DaemonBulkAdmissionError(errorKind));
    }
    if (this.sealed) {
      return Promise.reject(
        new DaemonBulkAdmissionError(`${this.lane}_admission_closed`),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(this.abortReason(signal));
    }

    const queue = this.queues.get(workspaceCwd);
    if (
      this.waiting >= this.globalWaitLimit ||
      (queue?.length ?? 0) >= this.workspaceWaitLimit
    ) {
      return Promise.reject(
        new DaemonBulkAdmissionError(`${this.lane}_queue_full`),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        workspaceCwd,
        operation,
        task,
        resolve: (value) => resolve(value as T),
        reject,
        signal,
      };
      if (signal) {
        item.abortListener = () => {
          if (!this.removeQueuedItem(item)) return;
          reject(this.abortReason(signal));
          this.drain();
        };
        signal.addEventListener('abort', item.abortListener, { once: true });
      }
      item.waitTimer = setTimeout(() => {
        if (!this.removeQueuedItem(item)) return;
        reject(new DaemonBulkAdmissionError(`${this.lane}_queue_timeout`));
        this.drain();
      }, this.waitTimeoutMs);
      item.waitTimer.unref?.();

      if (queue) {
        queue.push(item);
      } else {
        this.queues.set(workspaceCwd, [item]);
        this.workspaceOrder.push(workspaceCwd);
      }
      this.waiting++;
      this.drain();
    });
  }

  seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    const error = new DaemonBulkAdmissionError(`${this.lane}_admission_closed`);
    for (const queue of this.queues.values()) {
      for (const item of queue) {
        this.removeQueueHooks(item);
        item.reject(error);
      }
    }
    this.queues.clear();
    this.workspaceOrder.length = 0;
    this.waiting = 0;
  }

  snapshot(): {
    active: number;
    waiting: number;
    workspacesWaiting: number;
    sealed: boolean;
  } {
    return {
      active: this.active,
      waiting: this.waiting,
      workspacesWaiting: this.queues.size,
      sealed: this.sealed,
    };
  }

  private drain(): void {
    while (
      !this.sealed &&
      this.active < this.globalActiveLimit &&
      this.workspaceOrder.length > 0
    ) {
      const candidates = this.workspaceOrder.length;
      let selected: QueueItem | undefined;
      for (let index = 0; index < candidates; index++) {
        const workspaceCwd = this.workspaceOrder.shift();
        if (workspaceCwd === undefined) break;
        const queue = this.queues.get(workspaceCwd);
        if (!queue || queue.length === 0) {
          this.queues.delete(workspaceCwd);
          continue;
        }
        if (
          (this.activeByWorkspace.get(workspaceCwd) ?? 0) >=
          this.workspaceActiveLimit
        ) {
          this.workspaceOrder.push(workspaceCwd);
          continue;
        }

        selected = queue.shift();
        if (queue.length === 0) {
          this.queues.delete(workspaceCwd);
        } else {
          this.workspaceOrder.push(workspaceCwd);
        }
        break;
      }
      if (!selected) return;
      this.start(selected);
    }
  }

  private start(item: QueueItem): void {
    this.waiting--;
    this.active++;
    this.activeByWorkspace.set(
      item.workspaceCwd,
      (this.activeByWorkspace.get(item.workspaceCwd) ?? 0) + 1,
    );
    this.removeQueueHooks(item);

    const execution: DaemonSchedulerExecution = {
      scheduler: this,
      lane: this.lane,
      active: true,
    };
    void runningScheduler
      .run(execution, async () => {
        try {
          return await item.task();
        } finally {
          execution.active = false;
        }
      })
      .then(item.resolve, item.reject)
      .finally(() => {
        this.active--;
        const workspaceActive =
          (this.activeByWorkspace.get(item.workspaceCwd) ?? 1) - 1;
        if (workspaceActive === 0) {
          this.activeByWorkspace.delete(item.workspaceCwd);
          const orderIndex = this.workspaceOrder.indexOf(item.workspaceCwd);
          if (orderIndex !== -1) {
            this.workspaceOrder.splice(orderIndex, 1);
            this.workspaceOrder.push(item.workspaceCwd);
          }
        } else {
          this.activeByWorkspace.set(item.workspaceCwd, workspaceActive);
        }
        this.drain();
      });
  }

  private removeQueuedItem(item: QueueItem): boolean {
    const queue = this.queues.get(item.workspaceCwd);
    if (!queue) return false;
    const index = queue.indexOf(item);
    if (index === -1) return false;
    queue.splice(index, 1);
    this.waiting--;
    this.removeQueueHooks(item);
    if (queue.length === 0) {
      this.queues.delete(item.workspaceCwd);
      const orderIndex = this.workspaceOrder.indexOf(item.workspaceCwd);
      if (orderIndex !== -1) this.workspaceOrder.splice(orderIndex, 1);
    }
    return true;
  }

  private removeAbortListener(item: QueueItem): void {
    if (item.signal && item.abortListener) {
      item.signal.removeEventListener('abort', item.abortListener);
      item.abortListener = undefined;
    }
  }

  private removeQueueHooks(item: QueueItem): void {
    this.removeAbortListener(item);
    if (item.waitTimer) {
      clearTimeout(item.waitTimer);
      item.waitTimer = undefined;
    }
  }

  private abortReason(signal: AbortSignal): unknown {
    return signal.reason instanceof Error
      ? signal.reason
      : new Error('Daemon bulk operation was aborted');
  }
}

export class FairDaemonSpawnScheduler extends FairDaemonBulkScheduler {
  constructor() {
    super({
      globalActiveLimit: DAEMON_SPAWN_GLOBAL_ACTIVE_LIMIT,
      globalWaitLimit: DAEMON_SPAWN_GLOBAL_WAIT_LIMIT,
      workspaceActiveLimit: DAEMON_SPAWN_GLOBAL_ACTIVE_LIMIT,
      workspaceWaitLimit: DAEMON_SPAWN_WORKSPACE_WAIT_LIMIT,
      lane: 'daemon_spawn',
    });
  }
}

export class FairDaemonProcessScheduler extends FairDaemonBulkScheduler {
  constructor() {
    super({
      globalActiveLimit: DAEMON_PROCESS_GLOBAL_ACTIVE_LIMIT,
      globalWaitLimit: DAEMON_PROCESS_GLOBAL_WAIT_LIMIT,
      workspaceActiveLimit: DAEMON_PROCESS_GLOBAL_ACTIVE_LIMIT,
      workspaceWaitLimit: DAEMON_PROCESS_WORKSPACE_WAIT_LIMIT,
      lane: 'daemon_process',
    });
  }
}
