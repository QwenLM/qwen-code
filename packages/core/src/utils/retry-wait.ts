/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Lifecycle notifications for retry-owned backoff sleeps.
 *
 * A request owner (e.g. a workflow subagent round) installs an observer with
 * {@link runWithRetryWaitObserver} around the code that issues its request;
 * the retry layers announce each finite backoff sleep they perform through
 * {@link beginRetryWait}. The observer lives in its own AsyncLocalStorage —
 * `retryContext` only wraps a single attempt, while backoff runs outside it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createDebugLogger } from './debugLogger.js';

export type RetryWaitEvent =
  | { phase: 'start'; waitId: string; delayMs: number }
  | { phase: 'end'; waitId: string };

export type RetryWaitObserver = (event: RetryWaitEvent) => void;

const debugLogger = createDebugLogger('RETRY_WAIT');
const observerStorage = new AsyncLocalStorage<RetryWaitObserver>();
let waitSequence = 0;

export function runWithRetryWaitObserver<T>(
  observer: RetryWaitObserver,
  fn: () => T,
): T {
  return observerStorage.run(observer, fn);
}

/**
 * Wraps an async iterator so each `next`/`return`/`throw` runs under
 * `observer`. Needed for lazily iterated request generators, whose body (and
 * so its backoff sleeps) executes on iteration rather than on creation.
 */
export function bindRetryWaitObserver<T>(
  observer: RetryWaitObserver,
  iterator: AsyncIterator<T>,
): AsyncIterableIterator<T> {
  const bound: AsyncIterableIterator<T> = {
    next: (...args) =>
      observerStorage.run(observer, () => iterator.next(...args)),
    return: (value) =>
      observerStorage.run(observer, () =>
        iterator.return
          ? iterator.return(value)
          : Promise.resolve({ done: true as const, value }),
      ),
    throw: (error) =>
      observerStorage.run(observer, () =>
        iterator.throw ? iterator.throw(error) : Promise.reject(error),
      ),
    [Symbol.asyncIterator]: () => bound,
  };
  return bound;
}

/**
 * Announces a retry-owned sleep of `delayMs` to the current request's
 * observer and returns an idempotent function that ends it. Call it when the
 * sleep actually settles (resolve, reject, abort or skip). No observer, or a
 * delay that is not a finite positive number, makes this a no-op.
 */
export function beginRetryWait(delayMs: number): () => void {
  const observer = observerStorage.getStore();
  if (!observer || !Number.isFinite(delayMs) || delayMs <= 0) {
    return () => {};
  }
  const waitId = `retry-wait-${++waitSequence}`;
  notify(observer, { phase: 'start', waitId, delayMs });
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    notify(observer, { phase: 'end', waitId });
  };
}

function notify(observer: RetryWaitObserver, event: RetryWaitEvent): void {
  try {
    observer(event);
  } catch (error) {
    debugLogger.warn('retry wait observer threw (swallowed):', error);
  }
}
