/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { isNodeError } from './errors.js';

export interface AtomicWriteOptions {
  /** Number of rename retries on EPERM/EACCES (default: 3). */
  retries?: number;
  /** Base delay in ms for exponential backoff (default: 50). */
  delayMs?: number;
}

export interface AtomicWriteFileOptions extends AtomicWriteOptions {
  /** File permission mode (e.g. 0o600). Preserves original if target exists. */
  mode?: number;
  /** Whether to fsync the temp file before rename. Default: true. */
  flush?: boolean;
  /** Encoding for string content. Default: 'utf-8'. */
  encoding?: BufferEncoding;
}

/**
 * Rename a file with retry on EPERM/EACCES (common on Windows under
 * concurrent access). Uses exponential backoff.
 */
export async function renameWithRetry(
  src: string,
  dest: string,
  retries: number,
  delayMs: number,
): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (error: unknown) {
      const isRetryable =
        isNodeError(error) &&
        (error.code === 'EPERM' || error.code === 'EACCES');
      if (!isRetryable || attempt === retries) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, delayMs * 2 ** attempt),
      );
    }
  }
}

/**
 * Atomically write arbitrary content (string or Buffer) to a file.
 *
 * 1. Resolve symlinks so the temp file lives next to the real target.
 * 2. Write to a temporary file with fsync (`flush: true` by default).
 * 3. Preserve the original file's permissions (or apply `options.mode`).
 * 4. Atomic rename (POSIX) with retry (Windows).
 * 5. On EXDEV (cross-device rename), fall back to direct write.
 * 6. Always clean up the temp file on failure.
 *
 * The parent directory of `filePath` must already exist.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  options?: AtomicWriteFileOptions,
): Promise<void> {
  const retries = options?.retries ?? 3;
  const delayMs = options?.delayMs ?? 50;
  const flush = options?.flush ?? true;
  const encoding = options?.encoding ?? 'utf-8';

  // Resolve symlinks so tmp lives on the same volume as the real target.
  let targetPath: string;
  try {
    targetPath = await fs.realpath(filePath);
  } catch (err) {
    if (!isNodeError(err) || err.code !== 'ENOENT') {
      throw err;
    }
    targetPath = filePath;
  }

  const tmpPath = `${targetPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;

  // Stat the target to preserve permissions.
  let targetMode: number | undefined;
  try {
    const stat = await fs.stat(targetPath);
    targetMode = stat.mode;
  } catch (err) {
    if (!isNodeError(err) || err.code !== 'ENOENT') {
      throw err;
    }
    targetMode = options?.mode;
  }

  try {
    const writeOptions: {
      encoding?: BufferEncoding;
      flush?: boolean;
      mode?: number;
    } = {};
    if (typeof data === 'string') {
      writeOptions.encoding = encoding;
    }
    if (flush) {
      writeOptions.flush = true;
    }
    // For new files, set mode atomically during write if provided.
    if (targetMode === undefined && options?.mode !== undefined) {
      writeOptions.mode = options.mode;
    }

    await fs.writeFile(tmpPath, data, writeOptions);

    // Apply original permissions to the temp file before rename.
    if (targetMode !== undefined) {
      await fs.chmod(tmpPath, targetMode);
    }

    await renameWithRetry(tmpPath, targetPath, retries, delayMs);
  } catch (error) {
    // Clean up temp file.
    try {
      await fs.unlink(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }

    // EXDEV: cross-device rename not supported — fall back to direct write.
    if (isNodeError(error) && error.code === 'EXDEV') {
      const effectiveMode = targetMode ?? options?.mode;
      const fallbackOptions: {
        encoding?: BufferEncoding;
        flush?: boolean;
        mode?: number;
      } = {};
      if (typeof data === 'string') {
        fallbackOptions.encoding = encoding;
      }
      if (flush) {
        fallbackOptions.flush = true;
      }
      if (effectiveMode !== undefined) {
        fallbackOptions.mode = effectiveMode;
      }
      await fs.writeFile(targetPath, data, fallbackOptions);
      if (effectiveMode !== undefined) {
        await fs.chmod(targetPath, effectiveMode);
      }
      return;
    }

    throw error;
  }
}

/**
 * Atomically write a JSON value to a file.
 *
 * Delegates to {@link atomicWriteFile} for the actual atomic
 * write-to-temp + rename flow.
 *
 * The parent directory of `filePath` must already exist.
 */
export async function atomicWriteJSON(
  filePath: string,
  data: unknown,
  options?: AtomicWriteOptions,
): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(data, null, 2), {
    encoding: 'utf-8',
    ...options,
  });
}
