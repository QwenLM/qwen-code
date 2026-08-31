/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bounded single-consumer push queue backing an adaptor's event stream.
 *
 * The orchestrator's pump is the sole consumer and may drop and
 * resubscribe (backoff); a new subscribe takes the queue over and ends
 * the previous iterator — events buffered between subscriptions are
 * retained, so a resubscribing pump can never lose a turn_complete.
 *
 * Overflow policy: drop the oldest `progress` events first (they are
 * advisory), else the oldest event, and count the drops so tests can
 * pin the behavior.
 */

export interface AsyncEventQueueOptions {
  capacity?: number;
  onDrop?: (dropped: number) => void;
}

interface Waiter<T> {
  resolve: (result: IteratorResult<T>) => void;
}

export class AsyncEventQueue<T> {
  private readonly capacity: number;
  private readonly onDrop?: (dropped: number) => void;
  private buffered: T[] = [];
  private waiters: Array<Waiter<T>> = [];
  private ended = false;
  /** Live iterator(s); only the latest one keeps receiving events. */
  private active: Array<Waiter<T>> = [];

  constructor(options: AsyncEventQueueOptions = {}) {
    this.capacity = options.capacity ?? 500;
    this.onDrop = options.onDrop;
  }

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.buffered.push(item);
    if (this.buffered.length > this.capacity) {
      this.evictOne();
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  subscribe(options: { signal?: AbortSignal } = {}): AsyncIterable<T> {
    // A new subscription takes over: the previous iterator must end or
    // the pump's resubscribe would double-consume.
    for (const stale of this.active.splice(0)) {
      stale.resolve({ value: undefined as never, done: true });
    }
    for (const stale of this.waiters.splice(0)) {
      stale.resolve({ value: undefined as never, done: true });
    }
    const signal = options.signal;
    if (signal?.aborted) {
      return this.abortedIterable();
    }
    // The iterator closures below need the queue instance; an arrow-bound
    // alternative would re-alias `this` anyway.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const queue = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next: async (): Promise<IteratorResult<T>> => {
            if (queue.buffered.length > 0) {
              const value = queue.buffered.shift() as T;
              return { value, done: false };
            }
            if (queue.ended) {
              return { value: undefined as never, done: true };
            }
            return await new Promise<IteratorResult<T>>((resolve) => {
              const waiter = { resolve };
              queue.waiters.push(waiter);
              queue.active.push(waiter);
              signal?.addEventListener(
                'abort',
                () => {
                  const index = queue.waiters.indexOf(waiter);
                  if (index !== -1) queue.waiters.splice(index, 1);
                  const activeIndex = queue.active.indexOf(waiter);
                  if (activeIndex !== -1) queue.active.splice(activeIndex, 1);
                  resolve({ value: undefined as never, done: true });
                },
                { once: true },
              );
            });
          },
        };
      },
    };
  }

  get size(): number {
    return this.buffered.length;
  }

  private evictOne(): void {
    // Progress-shaped events drop first; identify by the `type` field the
    // BackendEvent union carries. Anything without it falls back to
    // oldest-first.
    let index = this.buffered.findIndex(
      (item) => (item as { type?: string }).type === 'progress',
    );
    if (index === -1) index = 0;
    this.buffered.splice(index, 1);
    this.onDrop?.(1);
  }

  private abortedIterable(): AsyncIterable<T> {
    let done = false;
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<T> => ({
        next: (): Promise<IteratorResult<T>> => {
          if (done)
            return Promise.resolve({ value: undefined as never, done: true });
          done = true;
          return Promise.resolve({ value: undefined as never, done: true });
        },
      }),
    };
  }
}
