/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A push/pull async iterator bridge.
 *
 * Producers push values with {@link enqueue}, signal completion with
 * {@link done}, or propagate errors with {@link error}.
 *
 * Consumers pull values with `for await (const v of stream)`.
 *
 * This bridges callback-style APIs (e.g. progress callbacks) into
 * async-iterable APIs consumed by generators and `for await...of` loops.
 *
 * A Stream can only be iterated once — attempting to iterate a second
 * time throws an error.
 *
 * @example
 * ```ts
 * const stream = new Stream<number>();
 * // Producer side
 * stream.enqueue(1);
 * stream.enqueue(2);
 * stream.done();
 * // Consumer side
 * for await (const n of stream) {
 *   console.log(n); // 1, 2
 * }
 * ```
 */
export class Stream<T> implements AsyncIterator<T> {
  private readonly queue: T[] = [];
  private readResolve?: (value: IteratorResult<T>) => void;
  private readReject?: (error: unknown) => void;
  private isDone = false;
  private hasError: unknown;
  private started = false;

  constructor(private readonly returned?: () => void) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    if (this.started) {
      throw new Error('Stream can only be iterated once');
    }
    this.started = true;
    return this as unknown as AsyncIterableIterator<T>;
  }

  next(): Promise<IteratorResult<T, unknown>> {
    // Fast path: queued values available synchronously
    if (this.queue.length > 0) {
      return Promise.resolve({
        done: false,
        value: this.queue.shift()!,
      });
    }
    // Terminal: stream completed
    if (this.isDone) {
      return Promise.resolve({ done: true, value: undefined });
    }
    // Terminal: stream errored
    if (this.hasError) {
      return Promise.reject(this.hasError);
    }
    // Slow path: park a reader until enqueue/done/error is called
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.readResolve = resolve;
      this.readReject = reject;
    });
  }

  /** Push a value into the stream. If a reader is parked, it wakes immediately. */
  enqueue(value: T): void {
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({ done: false, value });
    } else {
      this.queue.push(value);
    }
  }

  /** Signal that no more values will be produced. */
  done(): void {
    this.isDone = true;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  /** Signal an error. Any parked reader is rejected immediately. */
  error(err: unknown): void {
    this.hasError = err;
    if (this.readReject) {
      const reject = this.readReject;
      this.readResolve = undefined;
      this.readReject = undefined;
      reject(err);
    }
  }

  /** Called when the consumer breaks out of iteration early. */
  return(): Promise<IteratorResult<T, unknown>> {
    this.isDone = true;
    if (this.returned) {
      this.returned();
    }
    return Promise.resolve({ done: true, value: undefined });
  }
}
