/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type WorkflowDispatchState = 'running' | 'pausing' | 'paused';

export interface WorkflowDispatchSnapshot {
  state: WorkflowDispatchState;
  queued: number;
  inFlight: number;
}

type Job = {
  thunk: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type GateWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

function abortError(): Error {
  return new DOMException('Workflow dispatch scheduler aborted.', 'AbortError');
}

export class WorkflowDispatchScheduler {
  private state: WorkflowDispatchState = 'running';
  private inFlight = 0;
  private readonly queue: Job[] = [];
  private readonly gateWaiters: GateWaiter[] = [];
  private readonly stateListeners = new Set<
    (snapshot: WorkflowDispatchSnapshot) => void
  >();

  constructor(
    private readonly limit: number,
    private readonly signal?: AbortSignal,
    onStateChange?: (snapshot: WorkflowDispatchSnapshot) => void,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `Workflow dispatch limit must be a positive integer, got ${String(limit)}.`,
      );
    }
    if (onStateChange) this.stateListeners.add(onStateChange);
    if (signal && !signal.aborted) {
      signal.addEventListener('abort', () => this.abortPending(), {
        once: true,
      });
    }
  }

  /**
   * Subscribe to state transitions. Returns an unsubscribe function.
   * The constructor callback (when given) is registered as the first
   * listener; this method lets additional observers — e.g. the sandbox's
   * pause-aware wall-clock watchdog — hook the same transitions.
   */
  onStateChange(
    listener: (snapshot: WorkflowDispatchSnapshot) => void,
  ): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  run<T>(thunk: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.signal?.aborted) {
        reject(abortError());
        return;
      }
      this.queue.push({
        thunk: thunk as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  pause(): boolean {
    if (this.state !== 'running' || this.signal?.aborted) return false;
    this.setState('pausing');
    if (this.inFlight === 0) this.setState('paused');
    return true;
  }

  resume(): boolean {
    if (this.state !== 'paused' || this.signal?.aborted) return false;
    this.setState('running');
    while (this.gateWaiters.length > 0) {
      this.gateWaiters.shift()!.resolve();
    }
    this.pump();
    return true;
  }

  waitUntilRunning(): Promise<void> {
    if (this.signal?.aborted) return Promise.reject(abortError());
    if (this.state === 'running') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.gateWaiters.push({ resolve, reject });
    });
  }

  snapshot(): WorkflowDispatchSnapshot {
    return {
      state: this.state,
      queued: this.queue.length,
      inFlight: this.inFlight,
    };
  }

  private pump(): void {
    while (
      this.state === 'running' &&
      this.inFlight < this.limit &&
      this.queue.length > 0
    ) {
      const job = this.queue.shift()!;
      if (this.signal?.aborted) {
        job.reject(abortError());
        continue;
      }
      this.inFlight++;
      Promise.resolve()
        .then(job.thunk)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.inFlight--;
          if (this.state === 'pausing' && this.inFlight === 0) {
            this.setState('paused');
          }
          this.pump();
        });
    }
  }

  private setState(state: WorkflowDispatchState): void {
    if (this.state === state) return;
    this.state = state;
    const snapshot = this.snapshot();
    for (const listener of [...this.stateListeners]) listener(snapshot);
  }

  private abortPending(): void {
    const error = abortError();
    while (this.queue.length > 0) this.queue.shift()!.reject(error);
    while (this.gateWaiters.length > 0) {
      this.gateWaiters.shift()!.reject(error);
    }
  }
}
