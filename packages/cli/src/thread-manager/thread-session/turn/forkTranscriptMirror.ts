/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * fork 会话的初始 transcript_mirror 快照：把 fork 继承的历史 entries 按 512 KiB 分片
 * 补发一次，宿主才能看到继承的前段历史；只订阅后续 commit 会漏掉这段。
 */

import { ndjsonSafeStringify } from '@qwen-code/core';

export const FORK_TRANSCRIPT_MIRROR_CHUNK_BYTES = 512 * 1024;

export function chunkForkTranscriptEntries<T>(
  entries: readonly T[],
  maxBytes = FORK_TRANSCRIPT_MIRROR_CHUNK_BYTES,
): T[][] {
  const chunks: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;

  for (const entry of entries) {
    const bytes = Buffer.byteLength(ndjsonSafeStringify(entry), 'utf8');
    if (batch.length > 0 && batchBytes + bytes > maxBytes) {
      chunks.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(entry);
    batchBytes += bytes;
  }
  if (batch.length > 0) chunks.push(batch);
  return chunks;
}
