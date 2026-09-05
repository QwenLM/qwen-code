/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Simple FIFO counting semaphore.
 *
 * Used to gate concurrent calls to the model API so a configured per-provider
 * cap (#3409) translates into back-pressure rather than the upstream
 * ``429 Too many concurrent requests`` error -- the model server has no way
 * to tell us "wait", so the queue has to live in the client.
 *
 * - ``capacity <= 0`` is treated as "unlimited" and the limiter becomes a
 *   pass-through, so callers can wire this in unconditionally.
 * - ``acquire`` resolves with a release function. Always invoke release
 *   exactly once, including on the error path -- ``runExclusive`` does this
 *   for you.
 * - The wait list is FIFO so the order callers acquired the lock matches the
 *   order they were enqueued; useful for predictable pipeline behavior.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Number.isFinite(capacity) && capacity > 0 ? capacity : 0;
  }

  /** Number of in-flight slots. */
  get inFlight(): number {
    return this.active;
  }

  /** Number of callers currently parked waiting for a slot. */
  get queued(): number {
    return this.waiters.length;
  }

  /** Effective configured limit (``0`` means "unlimited"). */
  get limit(): number {
    return this.capacity;
  }

  /**
   * Acquire a slot. Resolves with a single-use ``release`` function. When
   * the limiter is unlimited (``capacity <= 0``) this resolves immediately
   * with a no-op release.
   */
  async acquire(): Promise<() => void> {
    if (this.capacity === 0) {
      return () => {};
    }
    if (this.active < this.capacity) {
      this.active++;
      return this.makeRelease();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve(this.makeRelease());
      });
    });
  }

  /**
   * Run ``fn`` while holding a slot. Always releases the slot, even when
   * ``fn`` throws or rejects. Most callers want this rather than the raw
   * ``acquire``/release pair.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) {
        next();
      }
    };
  }
}
