/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A fixed-size circular buffer that automatically evicts the oldest items
 * when the buffer is full. Useful for maintaining a rolling window of
 * recent output lines for progress display.
 */
export class CircularBuffer<T> {
  #buffer: T[];
  #head = 0;
  #size = 0;
  #capacity: number;

  constructor(capacity: number) {
    this.#capacity = capacity;
    this.#buffer = new Array(capacity);
  }

  /**
   * Add an item to the buffer. If the buffer is full,
   * the oldest item will be evicted.
   */
  add(item: T): void {
    this.#buffer[this.#head] = item;
    this.#head = (this.#head + 1) % this.#capacity;
    if (this.#size < this.#capacity) {
      this.#size++;
    }
  }

  /**
   * Get the most recent N items from the buffer.
   * Returns fewer items if the buffer contains less than N items.
   */
  getRecent(count: number): T[] {
    const result: T[] = [];
    const start = this.#size < this.#capacity ? 0 : this.#head;
    const available = Math.min(count, this.#size);

    for (let i = 0; i < available; i++) {
      const index = (start + this.#size - available + i) % this.#capacity;
      result.push(this.#buffer[index]);
    }

    return result;
  }

  /**
   * Clear all items from the buffer.
   */
  clear(): void {
    this.#buffer.fill(undefined as unknown as T);
    this.#head = 0;
    this.#size = 0;
  }

  /**
   * Get the current number of items in the buffer.
   */
  length(): number {
    return this.#size;
  }
}
