/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File I/O primitives for shell output reading.
 * Provides range-based reading and tail-based reading for large output files.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';

export type ReadFileRangeResult = {
  /** The content read from the file (UTF-8 decoded). */
  content: string;
  /** Number of bytes actually read. */
  bytesRead: number;
  /** Total file size in bytes. */
  bytesTotal: number;
};

/**
 * Reads `maxBytes` from a file starting at `offset`.
 * Returns null if the file is smaller than offset.
 *
 * @param path - Absolute path to the file.
 * @param offset - Byte offset to start reading from.
 * @param maxBytes - Maximum number of bytes to read.
 */
export async function readFileRange(
  path: string,
  offset: number,
  maxBytes: number,
): Promise<ReadFileRangeResult | null> {
  const stat = await fsp.stat(path);
  const bytesTotal = stat.size;

  if (bytesTotal <= offset) {
    return null;
  }

  const fd = await fsp.open(path, 'r');
  try {
    const bytesToRead = Math.min(maxBytes, bytesTotal - offset);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await fd.read(buffer, 0, bytesToRead, offset);
    return {
      content: buffer.subarray(0, bytesRead).toString('utf-8'),
      bytesRead,
      bytesTotal,
    };
  } finally {
    await fd.close();
  }
}

/**
 * Reads the last `maxBytes` of a file.
 *
 * @param path - Absolute path to the file.
 * @param maxBytes - Maximum number of bytes to read from the end.
 */
export async function tailFile(
  path: string,
  maxBytes: number,
): Promise<ReadFileRangeResult> {
  const stat = await fsp.stat(path);
  const bytesTotal = stat.size;
  const offset = Math.max(0, bytesTotal - maxBytes);

  const fd = await fsp.open(path, 'r');
  try {
    const bytesToRead = Math.min(maxBytes, bytesTotal);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await fd.read(buffer, 0, bytesToRead, offset);
    return {
      content: buffer.subarray(0, bytesRead).toString('utf-8'),
      bytesRead,
      bytesTotal,
    };
  } finally {
    await fd.close();
  }
}

/**
 * Counts the number of lines in a string.
 */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') count++;
  }
  // Don't count trailing newline as an extra line
  if (content[content.length - 1] === '\n') count--;
  return count;
}

/**
 * Extracts the last N lines from a string.
 */
export function lastNLines(content: string, n: number): string {
  if (n <= 0 || content.length === 0) return '';
  const lines = content.split('\n');
  // Remove trailing empty line from trailing newline
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.slice(-n).join('\n');
}

/**
 * Synchronously checks if a file exists.
 */
export function fileExistsSync(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
