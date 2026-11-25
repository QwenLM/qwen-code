/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Worker } from 'node:worker_threads';
import { SCRIPT_LIMITS, type ScriptWorkerData } from './types.js';

export interface ScriptWorkerOptions {
  prewarm?: boolean;
  maxSyncMs?: number;
  /** Includes running, stopping and spare workers. Production shares one manager. */
  maxWorkers?: number;
}

interface SpareWorker {
  worker: Worker;
  release(): void;
}

interface WorkerWaiter {
  wasm: WebAssembly.Module;
  resolve(worker: Worker): void;
  reject(error: unknown): void;
}

export class WorkerWaitTimeoutError extends Error {
  constructor() {
    super(
      `No CodeMode worker became free within ${SCRIPT_LIMITS.workerWaitMs / 1000} seconds. Retry after the other scripts finish or their workers exit.`,
    );
    this.name = 'WorkerWaitTimeoutError';
  }
}

/** One-use workers: capacity is returned by exit, never by script completion. */
export class ScriptWorkers {
  private readonly live = new Set<Worker>();
  private readonly stopping = new WeakSet<Worker>();
  private readonly waiters: WorkerWaiter[] = [];
  private readonly maxWorkers: number;
  private spare?: SpareWorker;

  constructor(
    private readonly workerUrl: string | URL,
    private readonly options: ScriptWorkerOptions = {},
  ) {
    this.maxWorkers = options.maxWorkers ?? SCRIPT_LIMITS.workers;
  }

  acquire(wasm: WebAssembly.Module, signal: AbortSignal): Promise<Worker> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => waiter.reject(signal.reason);
      const timer = setTimeout(
        () => waiter.reject(new WorkerWaitTimeoutError()),
        SCRIPT_LIMITS.workerWaitMs,
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      const waiter: WorkerWaiter = {
        wasm,
        resolve: (worker) => {
          cleanup();
          resolve(worker);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', abort, { once: true });
      this.admit();
    });
  }

  stop(worker: Worker): void {
    if (this.stopping.has(worker)) return;
    this.stopping.add(worker);
    void worker.terminate().catch(() => {});
    // terminate() can ref the thread again. Unref afterwards, without releasing capacity.
    worker.unref();
  }

  private spawn(wasm: WebAssembly.Module): Worker {
    const data: ScriptWorkerData = {
      wasm,
      ...(this.options.maxSyncMs === undefined
        ? {}
        : { maxSyncMs: this.options.maxSyncMs }),
    };
    const worker = new Worker(this.workerUrl, {
      workerData: data,
      execArgv: [],
    });
    this.live.add(worker);
    worker.once('exit', () => {
      this.live.delete(worker);
      if (this.spare?.worker === worker) this.spare = undefined;
      this.admit();
    });
    return worker;
  }

  private admit(): void {
    let wasm: WebAssembly.Module | undefined;
    while (
      this.waiters.length &&
      (this.spare || this.live.size < this.maxWorkers)
    ) {
      const waiter = this.waiters[0];
      try {
        // Claim the spare only once a worker exists, so a failed spawn cannot
        // discard the spare along with the attempt.
        const spare = this.spare;
        const worker = spare?.worker ?? this.spawn(waiter.wasm);
        if (spare) {
          this.spare = undefined;
          spare.release();
        }
        worker.ref();
        // A failed idle VM is retried on demand, not in a respawn loop.
        worker.once('exit', () => this.prepareSpare(waiter.wasm));
        waiter.resolve(worker);
        wasm = waiter.wasm;
      } catch (error) {
        waiter.reject(error);
      }
    }
    if (wasm) this.prepareSpare(wasm);
  }

  private prepareSpare(wasm: WebAssembly.Module): void {
    if (
      !this.options.prewarm ||
      this.spare ||
      this.waiters.length ||
      this.live.size >= this.maxWorkers
    )
      return;
    try {
      const worker = this.spawn(wasm);
      const discard = () => {
        if (this.spare?.worker === worker) this.spare = undefined;
        this.stop(worker);
      };
      this.spare = {
        worker,
        release: () => {
          worker.off('message', discard);
          worker.off('error', discard);
        },
      };
      // Before start, any message is an initialization failure.
      worker.once('message', discard);
      worker.on('error', discard);
      worker.unref();
    } catch {
      // Prewarming is optional; a later acquisition can retry construction.
    }
  }
}
