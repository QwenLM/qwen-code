/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Owns creation, initialization and disposal of one eagerly started resource.
 * Creation must clean up partial results if it rejects. Once creation succeeds,
 * dispose owns the result even if initialization fails. Initialization must honor
 * its cancellation signal; disposal waits for its actual completion.
 */
export class AsyncInitializer<T> {
  private readonly createPromise: Promise<T>;
  private readonly initPromise: Promise<T>;
  private readonly initController = new AbortController();
  private value!: T;
  private initialized = false;
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(
    private readonly options: {
      create: () => T | Promise<T>;
      init?: (value: T, signal: AbortSignal) => void | Promise<void>;
      dispose: (value: T) => void | Promise<void>;
    },
  ) {
    this.createPromise = (async () => options.create())();
    this.initPromise = this.createPromise.then(async (value) => {
      if (options.init) {
        this.initController.signal.throwIfAborted();
        await options.init(value, this.initController.signal);
      }
      this.value = value;
      this.initialized = true;
      return value;
    });
    // Starting work without an immediate consumer must not cause an unhandled
    // rejection. Keep the original rejected promise for every eventual waiter.
    void this.initPromise.catch(() => {});
  }

  get(): T {
    if (this.disposed) throw new Error('Resource is disposed');
    if (!this.initialized) throw new Error('Resource not yet initialized');
    return this.value;
  }

  /** Only preparation operations, such as supplying a host, are safe at this stage. */
  whenCreated(): Promise<T> {
    if (this.disposed) throw new Error('Resource is disposed');
    return this.createPromise;
  }

  whenReady(): Promise<T> {
    if (this.disposed) throw new Error('Resource is disposed');
    return this.initPromise;
  }

  isInitialized(): boolean {
    return this.initialized && !this.disposed;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    // Publish the promise before invoking user cleanup, including synchronous
    // cleanup that re-enters dispose().
    this.disposePromise = this.initPromise
      .catch(() => {})
      .then(() =>
        this.createPromise.then(
          async (value) => {
            try {
              await this.options.dispose(value);
            } finally {
              this.initialized = false;
              this.value = undefined as T;
            }
          },
          () => {
            /* A failed creator owns its partial-result cleanup. */
          },
        ),
      );
    void this.disposePromise.catch(() => {});
    this.initController.abort();
    return this.disposePromise;
  }

  whenDisposed(): Promise<void> {
    return this.disposePromise ?? Promise.resolve();
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}
