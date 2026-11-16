/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Writable } from 'node:stream';

export function flushOutput(
  stream: Writable,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cancel = () => resolve();
    signal.addEventListener('abort', cancel, { once: true });
    // A write callback fences all preceding writes, including a short tail
    // that does not generate another drain event.
    stream.write(Buffer.alloc(0), (error) => {
      signal.removeEventListener('abort', cancel);
      if (error) {
        // Writable emits its error after callbacks; let the owner cancel first.
        setImmediate(() => (signal.aborted ? resolve() : reject(error)));
      } else resolve();
    });
  });
}
