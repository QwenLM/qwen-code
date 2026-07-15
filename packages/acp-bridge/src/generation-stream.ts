/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single-consumer bounded queue for request-scoped generation events.
 * Unlike EventBus, it has no replay or fan-out because generated side content
 * belongs only to the HTTP request that initiated it.
 */
export class GenerationStreamQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private waiter:
    | {
        resolve: (result: IteratorResult<T>) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  private closed = false;
  private failure: unknown;

  constructor(private readonly capacity: number) {}

  push(value: T): boolean {
    if (this.closed) return false;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value, done: false });
      return true;
    }
    if (this.values.length >= this.capacity) return false;
    this.values.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.settleWaiter();
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.settleWaiter();
  }

  private settleWaiter(): void {
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = undefined;
    if (this.failure !== undefined) waiter.reject(this.failure);
    else waiter.resolve({ value: undefined, done: true });
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ value, done: false });
    }
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    if (this.waiter) {
      return Promise.reject(
        new Error('GenerationStreamQueue supports only one pending reader'),
      );
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}
