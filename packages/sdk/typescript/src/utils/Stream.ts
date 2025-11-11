/**
 * Async iterable queue for streaming messages between producer and consumer.
 */

export class Stream<T> implements AsyncIterable<T> {
  private returned: (() => void) | undefined;
  private queue: T[] = [];
  private readResolve: ((result: IteratorResult<T>) => void) | undefined;
  private readReject: ((error: Error) => void) | undefined;
  private isDone = false;
  hasError: Error | undefined;
  private started = false;

  constructor(returned?: () => void) {
    this.returned = returned;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.started) {
      throw new Error('Stream can only be iterated once');
    }
    this.started = true;
    return this;
  }

  async next(): Promise<IteratorResult<T>> {
    // Check queue first - if there are queued items, return immediately
    if (this.queue.length > 0) {
      return Promise.resolve({
        done: false,
        value: this.queue.shift()!,
      });
    }
    // Check if stream is done
    if (this.isDone) {
      return Promise.resolve({ done: true, value: undefined });
    }
    // Check for errors that occurred before next() was called
    // This ensures errors set via error() before iteration starts are properly rejected
    if (this.hasError) {
      return Promise.reject(this.hasError);
    }
    // No queued items, not done, no error - set up promise for next value/error
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.readResolve = resolve;
      this.readReject = reject;
    });
  }

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

  done(): void {
    this.isDone = true;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  error(error: Error): void {
    this.hasError = error;
    // If readReject exists (next() has been called), reject immediately
    if (this.readReject) {
      const reject = this.readReject;
      this.readResolve = undefined;
      this.readReject = undefined;
      reject(error);
    }
    // Otherwise, error is stored in hasError and will be rejected when next() is called
    // This handles the case where error() is called before the first next() call
  }

  return(): Promise<IteratorResult<T>> {
    this.isDone = true;
    if (this.returned) {
      this.returned();
    }
    return Promise.resolve({ done: true, value: undefined });
  }
}
