/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export type DescriptorFileReadSource = {
  kind: 'descriptor';
  fileHandle: FileHandle;
  stats: Stats;
};

export type FileReadSource =
  | { kind: 'path'; path: string }
  | DescriptorFileReadSource;

export interface FileReadRequest {
  path: string;
  mediaDelivery: 'inline' | 'omni';
  signal?: AbortSignal;
}

export class FileReadOpenError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'FileReadOpenError';
  }
}

export async function readFileHandleBytes(
  fileHandle: FileHandle,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError('File read extent must be a non-negative integer.');
  }
  signal?.throwIfAborted();
  const bytes = Buffer.allocUnsafe(length);
  let position = 0;
  while (position < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await fileHandle.read(
      bytes,
      position,
      Math.min(64 * 1024, length - position),
      position,
    );
    signal?.throwIfAborted();
    if (bytesRead === 0) break;
    position += bytesRead;
  }
  return bytes.subarray(0, position);
}
