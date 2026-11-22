/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export interface ReadFileMediaLimits {
  readonly maxInlineMediaBase64Bytes: number;
  readonly maxMediaResultBytes: number;
}

export function base64ByteLength(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

export async function readFileWithinBase64Limit(
  filePath: string,
  maxBase64Bytes: number,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  signal?.throwIfAborted();
  // Nonblocking open lets the handle check reject a replaced FIFO as well.
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    signal?.throwIfAborted();
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error('Inline media must be a regular file.');
    }
    const maxBytes = Math.floor(maxBase64Bytes / 4) * 3;
    if (stats.size > maxBytes) return undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      signal?.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read({ buffer: chunk });
      signal?.throwIfAborted();
      if (bytesRead === 0) return Buffer.concat(chunks, total);
      total += bytesRead;
      if (total > maxBytes) return undefined;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}
