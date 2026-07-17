/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { cpus } from 'node:os';

/** Default per-run concurrency: min(16, cpus-2), floored at 1. */
function defaultConcurrency(): number {
  return Math.max(1, Math.min(16, cpus().length - 2));
}

/**
 * Per-run gate for `agent()` calls (design: "scheduler.ts"). Owns the
 * concurrency semaphore (FIFO queue beyond the cap) and the lifetime agent-count
 * cap. Combinator semantics (parallel/pipeline) live in the sandbox bootstrap.
 */
export class Scheduler {
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];
  private agentCount = 0;

  constructor(
    readonly concurrency: number = defaultConcurrency(),
    private readonly lifetimeCap: number = 1000,
  ) {}

  /** Increment the lifetime counter. Returns false once the cap is reached. */
  tryCountAgent(): boolean {
    if (this.agentCount >= this.lifetimeCap) return false;
    this.agentCount += 1;
    return true;
  }

  get counted(): number {
    return this.agentCount;
  }

  get active(): number {
    return this.inFlight;
  }

  /** Acquire a concurrency slot; resolves with a one-shot release. */
  acquire(): Promise<() => void> {
    const grant = (): (() => void) => {
      this.inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.release();
      };
    };
    if (this.inFlight < this.concurrency) {
      return Promise.resolve(grant());
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(grant()));
    });
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
