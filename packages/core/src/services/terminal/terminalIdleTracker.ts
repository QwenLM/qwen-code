/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { delay } from '../../utils/delay.js';

export class TerminalIdleTracker {
  private lastOutputAt = 0;
  private waiters = new Set<() => void>();

  markOutput(): void {
    this.lastOutputAt = Date.now();
    for (const waiter of this.waiters) waiter();
  }

  getLastOutputAt(): number {
    return this.lastOutputAt;
  }

  async wait(waitMs = 0, idleMs = 0, signal?: AbortSignal): Promise<void> {
    if (waitMs <= 0) return;
    if (idleMs <= 0) {
      await delay(waitMs, signal);
      return;
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error('Terminal wait aborted.');
      }

      if (this.lastOutputAt === 0) {
        await this.waitForOutputOrTimeout(deadline - Date.now(), signal);
        continue;
      }

      const idleFor = Date.now() - this.lastOutputAt;
      const remainingIdle = idleMs - idleFor;
      if (remainingIdle <= 0) return;

      const remainingDeadline = deadline - Date.now();
      const waitFor = Math.min(remainingIdle, remainingDeadline);
      await this.waitForOutputOrTimeout(waitFor, signal);
    }
  }

  private async waitForOutputOrTimeout(
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (waitMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(onOutput);
        signal?.removeEventListener('abort', onAbort);
      };
      const onOutput = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('Terminal wait aborted.'));
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, waitMs);
      timer.unref?.();
      this.waiters.add(onOutput);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
