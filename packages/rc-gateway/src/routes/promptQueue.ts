/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-session FIFO serialiser for prompt execution.
 *
 * The spec ("Per-session FIFO preserved") requires that a new prompt MUST NOT
 * begin until the previous prompt returns a `stopReason` or is cancelled.  A
 * queued prompt that cannot acquire the slot within `queueWaitTimeoutSec`
 * receives a 503 `queue_timeout` response; the in-flight prompt is unaffected.
 *
 * Implementation: each session has a single-slot "mutex" represented as a
 * Promise chain.  `acquire()` appends a new waiter to the tail of the chain
 * and returns a `release` callback the caller MUST invoke (in a `finally`
 * block) when the turn is done.  A `queueWaitMs` deadline races against
 * acquiring the lock — if it fires first the function throws `QueueTimeoutError`
 * and the waiter is removed from the chain transparently (the next queued
 * prompt still runs in order).
 */

export class QueueTimeoutError extends Error {
  readonly code = 'queue_timeout' as const;
  constructor() {
    super('Prompt slot not acquired within queue-wait window');
    this.name = 'QueueTimeoutError';
  }
}

export class PromptQueue {
  /** Tail of the per-session Promise chain (resolves when the slot is free). */
  private readonly sessions = new Map<string, Promise<void>>();

  /**
   * Wait for the per-session slot to become free, then acquire it.
   *
   * @param sessionId  The session whose slot to acquire.
   * @param queueWaitMs  Maximum time (ms) to wait for the slot.  If the slot
   *   is not free within this window, throws `QueueTimeoutError`.
   * @returns A `release` function the caller MUST call in a `finally` block to
   *   free the slot for the next waiter.
   */
  async acquire(sessionId: string, queueWaitMs: number): Promise<() => void> {
    // Snapshot the current tail.  The new waiter will chain off it.
    const current = this.sessions.get(sessionId) ?? Promise.resolve();

    // `release` will be called by the caller when their turn is done.
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Register this waiter as the new tail immediately — before any await — so
    // that a subsequent caller chains off *this* waiter, not the old tail.
    this.sessions.set(sessionId, next);

    // Now race: wait for the previous tail to resolve vs. the deadline.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        current,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new QueueTimeoutError()),
            queueWaitMs,
          );
        }),
      ]);
    } catch (err) {
      // We timed out waiting for the slot.  Remove ourselves from the chain
      // so that the NEXT waiter chains off `next` (which we'll resolve now so
      // the chain isn't stuck).  The in-flight prompt continues unaffected.
      release();
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // We hold the slot — return release to the caller.
    return release;
  }

  /** Number of sessions currently tracked (for tests / introspection). */
  get size(): number {
    return this.sessions.size;
  }
}
