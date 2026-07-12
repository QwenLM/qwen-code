/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface FifoTaskQueue {
  run<T>(
    task: () => Promise<T>,
    options?: { signal?: AbortSignal; onStart?: () => void },
  ): Promise<T>;
}

type QueuedTask = {
  task: () => Promise<unknown>;
  signal?: AbortSignal;
  onStart?: () => void;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  removeAbortListener?: () => void;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

export function createFifoTaskQueue(limit: number): FifoTaskQueue {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `Task queue limit must be a positive integer, got ${limit}.`,
    );
  }

  let active = 0;
  const queued: QueuedTask[] = [];

  const pump = (): void => {
    while (active < limit && queued.length > 0) {
      const item = queued.shift()!;
      const removeAbortListener = item.removeAbortListener;
      item.removeAbortListener = undefined;
      removeAbortListener?.();
      if (item.signal?.aborted) {
        item.reject(abortReason(item.signal));
        continue;
      }
      active += 1;
      try {
        item.onStart?.();
      } catch (error) {
        active -= 1;
        item.reject(error);
        continue;
      }
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  const run = <T>(
    task: () => Promise<T>,
    options: { signal?: AbortSignal; onStart?: () => void } = {},
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortReason(options.signal));
        return;
      }
      const item: QueuedTask = {
        task,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onStart ? { onStart: options.onStart } : {}),
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (options.signal) {
        const onAbort = () => {
          const index = queued.indexOf(item);
          if (index < 0) return;
          queued.splice(index, 1);
          item.removeAbortListener?.();
          reject(abortReason(options.signal!));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        item.removeAbortListener = () =>
          options.signal?.removeEventListener('abort', onAbort);
      }
      queued.push(item);
      pump();
    });

  return { run };
}
