/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview A shared sliding-window concurrency limiter (p-limit style).
 *
 * Unlike the fixed-size batch loops elsewhere in the codebase, this keeps a
 * window of at most `limit` thunks in flight and starts a queued thunk the
 * instant a slot frees — so a single instance can be SHARED across many
 * callers (e.g. every agent() dispatch within one workflow run) and still
 * hold the total in-flight count under one cap.
 */

/**
 * Thrown (and surfaced as a rejection) when the limiter is aborted via its
 * `AbortSignal`. Named `AbortError` so `isAbortError()` (utils/errors.ts) can
 * classify it the same way as other cancellations in the codebase.
 */
function abortError(): Error {
  // DOMException is a global in Node ≥17 and is already used elsewhere in this
  // package for the same purpose (utils/abortController.ts). The 'AbortError'
  // name is what isAbortError() keys off.
  return new DOMException('Concurrency limiter aborted.', 'AbortError');
}

export interface ConcurrencyLimiter {
  /**
   * Schedule a single thunk. Resolves/rejects with the thunk's own
   * settlement (rejections are propagated raw — the caller decides whether
   * to treat them as data). At most `limit` scheduled thunks run at once,
   * across ALL callers sharing this limiter.
   */
  run<T>(thunk: () => Promise<T>): Promise<T>;
}

export function createConcurrencyLimiter(
  limit: number,
  signal?: AbortSignal,
): ConcurrencyLimiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `Concurrency limit must be a positive integer, got ${String(limit)}.`,
    );
  }

  let active = 0;
  type Job = {
    thunk: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  };
  const queue: Job[] = [];

  const pump = (): void => {
    while (active < limit && queue.length > 0) {
      const job = queue.shift()!;
      // Don't start NEW work once aborted — reject the job without invoking
      // its thunk so an aborted run can't keep spawning agents. In-flight
      // thunks are cancelled through their own signal (the dispatch layer).
      if (signal?.aborted) {
        job.reject(abortError());
        continue;
      }
      active++;
      // Promise.resolve().then(thunk) so a thunk that throws synchronously is
      // funnelled into the rejection path rather than escaping pump().
      Promise.resolve()
        .then(job.thunk)
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };

  const run = <T>(thunk: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      queue.push({
        thunk: thunk as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      pump();
    });

  // Drain the queue the moment the signal fires, rather than waiting for
  // some in-flight thunk's finally to re-run pump(). Without this, a thunk
  // that never settles would hold the slot and wedge every queued job
  // forever. Cleanup matters: a listener on a long-lived parent signal that
  // outlives many limiters would leak — `{ once: true }` covers it (abort
  // fires at most once per AbortSignal).
  if (signal && !signal.aborted) {
    signal.addEventListener(
      'abort',
      () => {
        while (queue.length > 0) queue.shift()!.reject(abortError());
      },
      { once: true },
    );
  }

  return { run };
}
