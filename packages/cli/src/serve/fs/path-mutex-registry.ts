/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export class PathMutexRegistry {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(
    key: string,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    // A cancelled waiter still follows its predecessor; deleting its tail
    // early would let the next caller bypass the current lock owner.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    try {
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(signal.reason);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          void previous
            .catch(() => undefined)
            .then(() => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            });
          if (signal.aborted) onAbort();
        });
      } else {
        await previous.catch(() => undefined);
      }
      signal?.throwIfAborted();
      return await fn();
    } finally {
      release();
    }
  }
}
