/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Writable } from 'node:stream';

const OUTPUT_DRAIN_TIMEOUT_MS = 2_000;

export function createAcpOutput(output: Writable) {
  const writer = Writable.toWeb(output).getWriter();
  const drained = writer.closed;
  // A write can fail before EOF. Keep its original error for close().
  void drained.catch(() => {});
  let closing = false;
  let closePromise: Promise<void> | undefined;

  return {
    stream: new WritableStream<Uint8Array>({
      write(frame) {
        if (closing) throw new Error('ACP output is closed');
        return writer.write(frame);
      },
    }),
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      // closed preserves the original error if close() reports invalid state.
      void writer.close().catch(() => {});
      let timer: NodeJS.Timeout | undefined;
      closePromise = Promise.race([
        drained,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(
              `ACP output did not drain within ${OUTPUT_DRAIN_TIMEOUT_MS}ms`,
            );
            reject(error);
            output.destroy(error);
          }, OUTPUT_DRAIN_TIMEOUT_MS);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
        writer.releaseLock();
      });
      return closePromise;
    },
  };
}
