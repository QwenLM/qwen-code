/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LlmClient } from '@qwen-code/qwen-code-core/core/client.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';

const debugLogger = createDebugLogger('NON_INTERACTIVE_CLI');

export async function waitForPendingMemoryTasks(
  client: Pick<
    LlmClient,
    'getPendingMemoryTaskPromises' | 'removePendingMemoryTaskPromises'
  >,
  signal: AbortSignal,
): Promise<void> {
  const promises = client.getPendingMemoryTaskPromises();
  if (promises.length === 0) return;

  const pending = new Set(promises);
  const settled = Promise.allSettled(
    promises.map((promise) =>
      promise.then(
        () => {
          pending.delete(promise);
        },
        () => {
          pending.delete(promise);
        },
      ),
    ),
  );
  let stopWaiting!: () => void;
  const aborted = new Promise<void>((resolve) => {
    stopWaiting = resolve;
  });
  signal.addEventListener('abort', stopWaiting, { once: true });
  try {
    if (!signal.aborted) {
      debugLogger.debug(
        `[runNonInteractive] Waiting for ${promises.length} tracked memory task(s)`,
      );
      await Promise.race([settled, aborted]);
    }
  } finally {
    signal.removeEventListener('abort', stopWaiting);
    // A cancelled waiter leaves unfinished tasks available to the next owner.
    client.removePendingMemoryTaskPromises(
      promises.filter((promise) => !pending.has(promise)),
    );
  }
  if (signal.aborted) {
    debugLogger.debug(
      '[runNonInteractive] Abandoned memory wait after abort; tasks may still be running',
    );
    signal.throwIfAborted();
  }
  debugLogger.debug('[runNonInteractive] Tracked memory tasks settled');
}
