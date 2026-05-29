/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
 * Follow a symlink chain to its final target, supporting broken links.
 *
 * Unlike `fs.realpath()`, this resolves even when the final target does
 * not exist (broken symlink). Returns the original path for non-symlinks.
 */
async function resolveSymlinkChain(filePath: string): Promise<string> {
  const maxHops = 40; // matches POSIX SYMLOOP_MAX
  let current = filePath;
  for (let i = 0; i < maxHops; i++) {
    let lstats: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      lstats = await fs.lstat(current);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return current;
      }
      throw err;
    }
    if (!lstats.isSymbolicLink()) {
      return current;
    }
    const linkTarget = await fs.readlink(current);
    if (path.isAbsolute(linkTarget)) {
      current = linkTarget;
    } else {
      // Resolve relative targets against the kernel-resolved parent dir.
      // path.dirname() is purely string-based and would mis-resolve when
      // intermediate path components are themselves directory symlinks.
      const parentDir = await fs.realpath(path.dirname(current));
      current = path.resolve(parentDir, linkTarget);
    }
  }
  const err = new Error(
    `ELOOP: too many levels of symbolic links, resolve '${filePath}'`,
  );
  (err as NodeJS.ErrnoException).code = 'ELOOP';
  throw err;
}

/**
 * Atomically write content to a file (write-to-temp + rename).
 *
 * Falls back to in-place write when the existing file's uid differs
 * from the process's euid — POSIX rename would reset ownership.
 * Also falls back on EXDEV (cross-device). Both fallbacks lose crash
 * atomicity but preserve the existing inode's uid/gid.
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

  const targetPath = await resolveSymlinkChain(filePath);

  // Stat the target to preserve existing permissions and detect
  // ownership-changing renames (see the ownership-preservation note in
  // the function doc).
  let existingStat: Stats | undefined;
  try {
    existingStat = await fs.stat(targetPath);
  } catch (err) {
    if (!isNodeError(err) || err.code !== 'ENOENT') {
      throw err;
    }
  }

  const existingMode =
    existingStat !== undefined ? existingStat.mode & 0o7777 : undefined;
  const desiredMode = existingMode ?? options?.mode;

  const writeOptions: {
    encoding?: BufferEncoding;
    flush?: boolean;
    mode?: number;
  } = {};
  if (typeof data === 'string') writeOptions.encoding = encoding;
  if (flush) writeOptions.flush = true;
  if (desiredMode !== undefined) writeOptions.mode = desiredMode;

  // chmod fails on filesystems without POSIX permissions (FAT/exFAT). Best-effort.
  const tryChmod = async (target: string): Promise<void> => {
    if (desiredMode === undefined) return;
    try {
      await fs.chmod(target, desiredMode);
    } catch {
      // Ignore — not all filesystems support chmod.
    }
  };

  // Detect when atomic rename would silently change ownership. POSIX
  // rename creates a new inode owned by the process's euid:egid; if the
  // existing file has a different uid, fall back to in-place write which
  // preserves the inode and therefore uid/gid. Only uid is compared —
  // gid is skipped because macOS inherits the parent directory's GID
  // for new files, making egid !== file.gid a false positive.
  const ownershipWouldChange = (): boolean => {
    if (existingStat === undefined) return false;
    if (process.platform === 'win32') return false;
    const euid = process.geteuid?.();
    if (euid === undefined) return false;
    return existingStat.uid !== euid;
  };

  if (
    existingStat !== undefined &&
    existingStat.isFile() &&
    ownershipWouldChange()
  ) {
    await fs.writeFile(targetPath, data, writeOptions);
    await tryChmod(targetPath);
    return;
  }

  const tmpPath = `${targetPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;

  try {
    await fs.writeFile(tmpPath, data, writeOptions);
    await tryChmod(tmpPath);
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
      await fs.writeFile(targetPath, data, writeOptions);
      await tryChmod(targetPath);
      return;
    }

    throw error;
  }
}

/** Atomically write a JSON value to a file. Delegates to {@link atomicWriteFile}. */
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
