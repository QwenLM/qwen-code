/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Generic non-blocking message queue.
 *
 * Queue for producer/consumer patterns with FIFO dequeue and LIFO
 * pop. All operations are non-blocking — they return null when empty.
 * The consumer decides when and how to process items.
 */

/**
 * A generic non-blocking message queue.
 *
 * - `enqueue(item)` adds an item. Silently dropped after `drain()`.
 * - `dequeue()` returns the next item (FIFO), or `null` if empty.
 * - `popLast()` returns the last item (LIFO), or `null` if empty.
 *   Useful for retrieving the most recently queued item for editing.
 * - `drain()` signals that no more items will be enqueued.
 */
export class AsyncMessageQueue<T> {
  private items: T[] = [];
  private drained = false;

  /** Add an item to the queue. Dropped silently after drain. */
  enqueue(item: T): void {
    if (this.drained) return;
    this.items.push(item);
  }

  /** Remove and return the next item, or null if empty. */
  dequeue(): T | null {
    if (this.items.length > 0) {
      return this.items.shift()!;
    }
    return null;
  }

  /** Signal that no more items will be enqueued. */
  drain(): void {
    this.drained = true;
  }

  /** Number of items currently in the queue. */
  get size(): number {
    return this.items.length;
  }

  /** Remove and return the last item, or null if empty. */
  popLast(): T | null {
    if (this.items.length > 0) {
      return this.items.pop()!;
    }
    return null;
  }

  /** Whether `drain()` has been called. */
  get isDrained(): boolean {
    return this.drained;
  }
}
