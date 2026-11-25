/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelStreamResponse } from '../provider/modelStreamResponse.js';

/**
 * Build a promise that rejects when `signal` aborts. The already-aborted case
 * rejects synchronously without registering a listener; otherwise a one-shot
 * `abort` listener is registered and removed by `cleanup()`.
 *
 * Callers push `promise` into their own `Promise.race` and invoke `cleanup()`
 * once the race settles to detach the listener.
 */
export function createAbortRejection(signal: AbortSignal): {
  promise: Promise<never>;
  cleanup(): void;
} {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(
        signal.reason ?? new DOMException('Model stream aborted', 'AbortError'),
      );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    cleanup() {
      if (onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

/**
 * Reject as soon as `signal` aborts, but keep observing `pending` so a late
 * transport failure is still surfaced after the abort has already won. Returns
 * `pending` unchanged when there is no signal.
 */
export function raceWithAbortSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return pending;
  const { promise, cleanup } = createAbortRejection(signal);
  return Promise.race([pending, promise]).finally(cleanup);
}

export function raceSingleRequestResponseWithAbortSignal(
  pending: Promise<ModelStreamResponse>,
  signal: AbortSignal | undefined,
): Promise<ModelStreamResponse> {
  let acquired: ModelStreamResponse | undefined;
  return raceWithAbortSignal(
    pending.then((response) => {
      void response.completed.catch(() => undefined);
      void response.partial.catch(() => undefined);
      let cancelled = false;
      const cancel = (reason?: unknown): void => {
        if (cancelled) return;
        cancelled = true;
        // A non-cooperative transport must not hold single-request cleanup open.
        try {
          void Promise.resolve(response.cancel?.(reason)).catch(
            () => undefined,
          );
        } catch {
          // Cancellation is best effort, including responses acquired after abort.
        }
      };
      if (signal?.aborted) {
        cancel(signal.reason);
        signal.throwIfAborted();
      }
      acquired = {
        events: response.events,
        completed: response.completed,
        partial: response.partial,
        cancel,
      };
      return acquired;
    }),
    signal,
  ).catch((error) => {
    if (signal?.aborted) acquired?.cancel?.(signal.reason);
    throw error;
  });
}
