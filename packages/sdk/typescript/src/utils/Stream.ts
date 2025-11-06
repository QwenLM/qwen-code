/**
 * Async iterable queue for streaming messages between producer and consumer.
 */

export class Stream<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private isDone = false;
  private streamError: Error | null = null;
  private readResolve: ((result: IteratorResult<T>) => void) | null = null;
  private readReject: ((error: Error) => void) | null = null;
  private maxQueueSize: number = 10000; // Prevent memory leaks
  private droppedMessageCount = 0;

  /**
   * Add a value to the stream.
   */
  enqueue(value: T): void {
    if (this.isDone) {
      throw new Error('Cannot enqueue to completed stream');
    }
    if (this.streamError) {
      throw new Error('Cannot enqueue to stream with error');
    }

    // Fast path: consumer is waiting
    if (this.readResolve) {
      this.readResolve({ value, done: false });
      this.readResolve = null;
      this.readReject = null;
    } else {
      // Slow path: buffer in queue (with size limit)
      if (this.queue.length >= this.maxQueueSize) {
        // Drop oldest message to prevent memory leak
        this.queue.shift();
        this.droppedMessageCount++;

        // Warn about dropped messages (but don't throw)
        if (this.droppedMessageCount % 100 === 1) {
          console.warn(
            `[Stream] Queue full, dropped ${this.droppedMessageCount} messages. ` +
              `Consumer may be too slow.`,
          );
        }
      }

      this.queue.push(value);
    }
  }

  /**
   * Mark the stream as complete.
   */
  done(): void {
    if (this.isDone) {
      return; // Already done, no-op
    }

    this.isDone = true;

    // If consumer is waiting, signal completion
    if (this.readResolve) {
      this.readResolve({ done: true, value: undefined });
      this.readResolve = null;
      this.readReject = null;
    }
  }

  /**
   * Set an error state for the stream.
   */
  setError(err: Error): void {
    if (this.streamError) {
      return; // Already has error, no-op
    }

    this.streamError = err;

    // If consumer is waiting, reject immediately
    if (this.readReject) {
      this.readReject(err);
      this.readResolve = null;
      this.readReject = null;
    }
  }

  /**
   * Get the next value from the stream.
   */
  async next(): Promise<IteratorResult<T>> {
    // Fast path: queue has values
    if (this.queue.length > 0) {
      const value = this.queue.shift()!;
      return { value, done: false };
    }

    // Error path: stream has error
    if (this.streamError) {
      throw this.streamError;
    }

    // Done path: stream is complete
    if (this.isDone) {
      return { done: true, value: undefined };
    }

    // Wait path: no values yet, wait for producer
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.readResolve = resolve;
      this.readReject = reject;
      // Producer will call resolve/reject when value/done/error occurs
    });
  }

  /**
   * Enable async iteration with `for await` syntax.
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  get queueSize(): number {
    return this.queue.length;
  }

  get isComplete(): boolean {
    return this.isDone;
  }

  get hasError(): boolean {
    return this.streamError !== null;
  }

  get droppedMessages(): number {
    return this.droppedMessageCount;
  }

  /**
   * Set the maximum queue size.
   */
  setMaxQueueSize(size: number): void {
    if (size < 1) {
      throw new Error('Max queue size must be at least 1');
    }
    this.maxQueueSize = size;
  }

  get maxSize(): number {
    return this.maxQueueSize;
  }

  /**
   * Clear all buffered messages. Use only during cleanup or error recovery.
   */
  clear(): void {
    this.queue = [];
  }
}
