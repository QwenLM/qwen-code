/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef } from 'react';

export interface UiProviderTransactionContext {
  signal: AbortSignal;
  canPublish: () => boolean;
  ownsRollback: () => boolean;
}

export interface UiProviderTransaction {
  run<T>(
    operation: (context: UiProviderTransactionContext) => Promise<T>,
  ): Promise<T | undefined>;
  cancelActive(): void;
}

interface QueuedTransaction<T> {
  generation: number;
  operation: (context: UiProviderTransactionContext) => Promise<T>;
  stale: boolean;
}

interface ActiveTransaction {
  generation: number;
  controller: AbortController;
  canPublish: boolean;
  settled: boolean;
}

export function useUiProviderTransaction(): UiProviderTransaction {
  const generationRef = useRef(0);
  const activeRef = useRef<ActiveTransaction | null>(null);
  const queuedRef = useRef<QueuedTransaction<unknown> | null>(null);
  const tailRef = useRef<Promise<void>>(Promise.resolve());

  const cancelActive = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;

    active.canPublish = false;
    active.controller.abort();
  }, []);

  const dispose = useCallback(() => {
    if (queuedRef.current) {
      queuedRef.current.stale = true;
    }
    cancelActive();
  }, [cancelActive]);

  useEffect(() => dispose, [dispose]);

  const run = useCallback(
    <T>(
      operation: (context: UiProviderTransactionContext) => Promise<T>,
    ): Promise<T | undefined> => {
      cancelActive();
      if (queuedRef.current) {
        queuedRef.current.stale = true;
      }

      const queued: QueuedTransaction<T> = {
        generation: ++generationRef.current,
        operation,
        stale: false,
      };
      queuedRef.current = queued as QueuedTransaction<unknown>;

      const previousTail = tailRef.current;
      const result = previousTail.then(async () => {
        if (
          queued.stale ||
          generationRef.current !== queued.generation ||
          queuedRef.current !== queued
        ) {
          return undefined;
        }

        queuedRef.current = null;
        const active: ActiveTransaction = {
          generation: queued.generation,
          controller: new AbortController(),
          canPublish: true,
          settled: false,
        };
        activeRef.current = active;

        try {
          return await queued.operation({
            signal: active.controller.signal,
            canPublish: () =>
              active.canPublish && generationRef.current === active.generation,
            ownsRollback: () => !active.settled,
          });
        } finally {
          active.settled = true;
          if (activeRef.current === active) {
            activeRef.current = null;
          }
        }
      });

      tailRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [cancelActive],
  );

  return { run, cancelActive };
}
