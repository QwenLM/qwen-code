/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import type { Stats } from 'node:fs';
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
 * Atomically write arbitrary content (string or Buffer) to a file.
 *
 * 1. Resolve symlinks (including broken ones) so the temp file lives
 *    next to the real target.
 * 2. Write to a temporary file with fsync (`flush: true` by default).
 * 3. Preserve the original file's permissions (or apply `options.mode`).
 * 4. Atomic rename (POSIX) with retry (Windows).
 * 5. On EXDEV (cross-device rename), fall back to direct write.
 *    **Note:** the EXDEV fallback is non-atomic — a crash mid-write
 *    can leave a partially-written file. EXDEV only occurs when the
 *    resolved target path is on a different filesystem than its parent
 *    directory, which is rare in practice.
 * 6. **Ownership preservation.** If the existing file is owned by a
 *    different uid/gid than the calling process's euid/egid, fall back
 *    to in-place truncate+write instead of rename. POSIX rename creates
 *    a new inode owned by the process's euid/egid, which would silently
 *    strip the original ownership and break shared-write setups
 *    (e.g. group-writable files in a shared workspace, or files inside
 *    a bind-mounted Docker volume edited by root in-container). The
 *    in-place write preserves the inode — and therefore uid/gid — at
 *    the cost of three properties:
 *      - **Crash atomicity** — a crash mid-write can leave a
 *        partially-written file.
 *      - **Concurrent reader isolation** — readers can observe a
 *        zero-length or partial file during the write.
 *      - **Watcher semantics** — emits an inotify `MODIFY` event rather
 *        than `MOVED_TO` / `CREATE`. Most watchers (chokidar, VSCode)
 *        handle both, but consumers that only watch for one will miss
 *        these writes.
 *    If the file is not writable by the current process (mode forbids
 *    it), the in-place fallback surfaces `EACCES` — which is the
 *    correct behavior (rename would have silently replaced a file the
 *    user has no business overwriting).
 * 7. Always clean up the temp file on failure.
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
  // rename creates a new inode owned by the process's euid/egid; if the
  // existing file is owned by someone else (or has a different group),
  // shared-write users would lose access. Fall back to in-place write,
  // which truncates the existing inode and so preserves uid/gid.
  // Skipped on Windows (no POSIX ownership) and for new files (no owner
  // to preserve). Root takes the same fallback as non-root — even
  // though root *could* chown back after rename, chown silently fails
  // inside user-namespaced or CAP_CHOWN-stripped containers, which is
  // exactly the Docker-as-root scenario this fix targets.
  const ownershipWouldChange = (): boolean => {
    if (existingStat === undefined) return false;
    if (process.platform === 'win32') return false;
    const euid = process.geteuid?.();
    const egid = process.getegid?.();
    if (euid === undefined || egid === undefined) return false;
    return existingStat.uid !== euid || existingStat.gid !== egid;
  };

  if (ownershipWouldChange()) {
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

/**
 * Atomically write a JSON value to a file.
 *
 * Delegates to {@link atomicWriteFile} for the actual atomic
 * write-to-temp + rename flow.
 *
 * Note: if `filePath` is a symlink, the write resolves the chain
 * and updates the real target file — the symlink itself is preserved.
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
