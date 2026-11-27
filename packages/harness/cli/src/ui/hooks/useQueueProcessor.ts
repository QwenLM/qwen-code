/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * React hook that processes queued commands when conditions are met.
 *
 * Uses a single unified command queue
 * (module-level store) and QueryGuard for concurrency control. Priority
 * determines processing order: 'now' > 'next' (user input) > 'later'
 * (task notifications).
 *
 * Processing triggers when:
 * - No query active (queryGuard — reactive via useSyncExternalStore)
 * - Queue has items
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
  subscribeToCommandQueue,
  getCommandQueueSnapshot,
  processQueueIfReady,
  runLogger,
  type QueuedCommand,
  type QueryGuard,
} from '@qwen-code/core';

export interface UseQueueProcessorParams {
  /**
   * Callback to execute queued commands.
   * Each call receives an array of commands (batched by same commandMode).
   */
  executeQueuedInput: (commands: QueuedCommand[]) => Promise<void>;

  /**
   * QueryGuard instance for concurrency control.
   * When active (dispatching or running), the processor defers.
   */
  queryGuard: QueryGuard;

  /**
   * External readiness gate (e.g. config initialized AND MCP servers ready).
   * When false, the processor defers even if the queue has items.
   */
  isReady: boolean;
}

/**
 * Processes queued commands when the model is idle.
 *
 * Processing triggers when:
 * - `queryGuard.isActive` is false
 * - Queue has items
 *
 * Slash commands and bash-mode commands are processed one at a time.
 * Other commands are batched by same commandMode.
 */
export function useQueueProcessor({
  executeQueuedInput,
  queryGuard,
  isReady,
}: UseQueueProcessorParams): void {
  // Subscribe to the query guard. Re-renders when a query starts or ends.
  const isQueryActive = useSyncExternalStore(
    queryGuard.subscribe,
    queryGuard.getSnapshot,
  );

  // Subscribe to the unified command queue via useSyncExternalStore.
  const queueSnapshot = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  );

  useEffect(() => {
    if (!isReady) {
      if (queueSnapshot.length > 0) {
        runLogger.debug(
          `[useQueueProcessor] blocked: isReady=false, queueLen=${queueSnapshot.length}`,
        );
      }
      return;
    }
    if (isQueryActive) {
      if (queueSnapshot.length > 0) {
        runLogger.debug(
          `[useQueueProcessor] blocked: isQueryActive=true, queueLen=${queueSnapshot.length}`,
        );
      }
      return;
    }
    if (queueSnapshot.length === 0) return;

    runLogger.debug(
      `[useQueueProcessor] processing: queueLen=${queueSnapshot.length}, ` +
        `modes=${queueSnapshot.map((c) => c.commandMode).join(',')}`,
    );
    processQueueIfReady({
      executeInput: executeQueuedInput,
      queryGuard,
    });
  }, [
    queueSnapshot,
    isQueryActive,
    executeQueuedInput,
    isReady,
    queryGuard,
  ]);
}
