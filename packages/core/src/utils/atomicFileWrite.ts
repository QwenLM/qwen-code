/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
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
  /**
   * Ignore the existing target's permission bits and apply `mode`
   * regardless. Use for secrets that must heal historically over-permissive
   * files (e.g. a credential file accidentally restored from backup at
   * 0o644 must be forced back to 0o600). No effect when `mode` is unset.
   * Default: false.
   */
  forceMode?: boolean;
  /**
   * Do NOT follow symlinks at `filePath` — write to / replace the link
   * itself rather than its target. Pre-`atomicWriteFile` migration code
   * used `fs.rename(tmp, filePath)`, which atomically *replaces* a
   * symlink with the new regular file. The default behavior resolves
   * the chain and writes through, which is a security regression for
   * credential files on shared hosts (a pre-placed symlink could
   * redirect tokens to an attacker-controlled path). Credential write
   * sites pass `noFollow: true` to match the old replace-the-symlink
   * semantics. Default: false (follow symlinks). See PR #4333 review.
   */
  noFollow?: boolean;
}

/**
 * Rename a file with retry on EPERM/EACCES (common on Windows under
 * concurrent access). Uses exponential backoff.
 *
 * @param _renameImpl Internal test seam — defaults to `fs.rename`. Tests
 *   inject a mock to exercise retry, give-up, and non-retryable paths
 *   that vitest cannot otherwise spy on (ESM exports of `node:fs` are
 *   non-configurable).
 */
export async function renameWithRetry(
  src: string,
  dest: string,
  retries: number,
  delayMs: number,
  _renameImpl: (s: string, d: string) => Promise<void> = fs.rename,
): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await _renameImpl(src, dest);
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
 * 6. Always clean up the temp file on failure.
 *
 * The parent directory of `filePath` must already exist.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  options?: AtomicWriteFileOptions,
  /**
   * Internal test seam — defaults to real `fs.rename` / `fs.writeFile`.
   * Tests inject overrides to exercise EXDEV fallback and rename-retry
   * paths that vitest cannot spy on (ESM exports of `node:fs` are
   * non-configurable). Production callers never pass this.
   */
  _testFs?: {
    rename?: (s: string, d: string) => Promise<void>;
    writeFile?: typeof fs.writeFile;
  },
): Promise<void> {
  const retries = options?.retries ?? 3;
  const delayMs = options?.delayMs ?? 50;
  const flush = options?.flush ?? true;
  const encoding = options?.encoding ?? 'utf-8';
  const renameImpl = _testFs?.rename ?? fs.rename;
  const writeFileImpl = _testFs?.writeFile ?? fs.writeFile;

  const targetPath = options?.noFollow
    ? filePath
    : await resolveSymlinkChain(filePath);

  const tmpPath = `${targetPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;

  // forceMode skips permission preservation only when an explicit mode is
  // supplied — otherwise we'd silently downgrade an existing file's perms
  // to the process umask. forceMode without mode falls back to preservation.
  let existingMode: number | undefined;
  if (!options?.forceMode || options?.mode === undefined) {
    try {
      const stat = await fs.stat(targetPath);
      existingMode = stat.mode & 0o7777;
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

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

  try {
    await writeFileImpl(tmpPath, data, writeOptions);
    await tryChmod(tmpPath);
    await renameWithRetry(tmpPath, targetPath, retries, delayMs, renameImpl);
  } catch (error) {
    // Clean up temp file.
    try {
      await fs.unlink(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }

    // EXDEV: cross-device rename not supported — fall back to direct write.
    if (isNodeError(error) && error.code === 'EXDEV') {
      try {
        if (options?.noFollow) {
          // Naive fallback `writeFile(targetPath)` follows symlinks,
          // defeating the entire purpose of noFollow on credential
          // paths. Unlink any existing entry (matches the rename
          // happy path that atomically replaces a symlink), then
          // open with O_EXCL to refuse writing through a symlink
          // that races back into existence.
          try {
            await fs.unlink(targetPath);
          } catch (unlinkErr) {
            if (!isNodeError(unlinkErr) || unlinkErr.code !== 'ENOENT') {
              throw unlinkErr;
            }
          }
          const fd = await fs.open(
            targetPath,
            fsSync.constants.O_WRONLY |
              fsSync.constants.O_CREAT |
              fsSync.constants.O_EXCL,
            desiredMode ?? 0o666,
          );
          try {
            await fd.writeFile(
              typeof data === 'string' ? Buffer.from(data, encoding) : data,
            );
            if (flush) await fd.sync();
          } finally {
            await fd.close();
          }
        } else {
          await writeFileImpl(targetPath, data, writeOptions);
        }
        await tryChmod(targetPath);
        return;
      } catch (fallbackError) {
        // Preserve the function's error-shape contract even on the
        // non-atomic fallback path (e.g. ENOSPC writing directly).
        throw annotateWriteError(fallbackError, targetPath);
      }
    }

    throw annotateWriteError(error, targetPath);
  }
}

/**
 * Prefix the error message with the logical target path so downstream
 * debug logs identify which file actually failed (the original syscall
 * error usually references the random `.tmp.<hex>` temp path, which is
 * unhelpful when a caller doesn't wrap the error). Mutates in place to
 * preserve every other property (`code`, `errno`, `syscall`, `stack`,
 * the prototype chain) so existing `err.code === 'ENOENT'` checks and
 * `instanceof` narrowing continue to work unchanged.
 *
 * `fnName` defaults to the async variant; sync callers pass
 * `'atomicWriteFileSync'` so incident-response logs identify which
 * code path actually failed.
 */
function annotateWriteError(
  error: unknown,
  targetPath: string,
  fnName: string = 'atomicWriteFile',
): unknown {
  // Idempotency guard: skip if we already annotated this error (the
  // prefix is a literal `${fnName}(`). The earlier guard used
  // `includes(targetPath)`, but real fs syscall errors embed the *tmp*
  // path (e.g. `ENOSPC ... '/path/creds.json.a1b2c3.tmp'`) which
  // *contains* the target path as a substring — so the annotation was
  // silently skipped on every real failure. Check for our own prefix
  // instead so the message gets annotated exactly once across the
  // tmp-write → rename → EXDEV-fallback chain.
  if (error instanceof Error && !error.message.startsWith(`${fnName}(`)) {
    error.message = `${fnName}(${JSON.stringify(targetPath)}): ${error.message}`;
  }
  return error;
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

// --- Synchronous variants ----------------------------------------------------

/**
 * True blocking sleep without busy-wait. Backed by a tiny SharedArrayBuffer
 * since Atomics.wait requires an Int32Array view of shared memory.
 */
function blockingSleep(ms: number): void {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);
  Atomics.wait(i32, 0, 0, ms);
}

/**
 * Sync mirror of {@link renameWithRetry}. Retries on EPERM/EACCES with
 * exponential backoff (common on Windows under concurrent AV scans).
 *
 * @param _renameImpl Internal test seam — see {@link renameWithRetry}.
 */
export function renameWithRetrySync(
  src: string,
  dest: string,
  retries: number,
  delayMs: number,
  _renameImpl: (s: string, d: string) => void = fsSync.renameSync,
): void {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      _renameImpl(src, dest);
      return;
    } catch (error: unknown) {
      const isRetryable =
        isNodeError(error) &&
        (error.code === 'EPERM' || error.code === 'EACCES');
      if (!isRetryable || attempt === retries) {
        throw error;
      }
      blockingSleep(delayMs * 2 ** attempt);
    }
  }
}

/**
 * Sync mirror of {@link resolveSymlinkChain}. Walks symlinks (including
 * broken ones) up to POSIX SYMLOOP_MAX. Returns the original path for
 * non-symlinks.
 */
function resolveSymlinkChainSync(filePath: string): string {
  const maxHops = 40;
  let current = filePath;
  for (let i = 0; i < maxHops; i++) {
    let lstats: fsSync.Stats;
    try {
      lstats = fsSync.lstatSync(current);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return current;
      }
      throw err;
    }
    if (!lstats.isSymbolicLink()) {
      return current;
    }
    const linkTarget = fsSync.readlinkSync(current);
    if (path.isAbsolute(linkTarget)) {
      current = linkTarget;
    } else {
      const parentDir = fsSync.realpathSync(path.dirname(current));
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
 * Synchronous variant of {@link atomicWriteFile}. Same semantics: symlink
 * resolution, permission preservation (or `forceMode` override), fsync via
 * `flush: true`, EPERM/EACCES rename retry, EXDEV fallback to direct write.
 *
 * Use for code paths that cannot await (e.g. settings persistence on
 * `process.exit`). Prefer the async variant when possible.
 */
export function atomicWriteFileSync(
  filePath: string,
  data: string | Buffer,
  options?: AtomicWriteFileOptions,
  /** Internal test seam — see {@link atomicWriteFile}. */
  _testFs?: {
    rename?: (s: string, d: string) => void;
    writeFile?: typeof fsSync.writeFileSync;
  },
): void {
  const retries = options?.retries ?? 3;
  const delayMs = options?.delayMs ?? 50;
  const flush = options?.flush ?? true;
  const encoding = options?.encoding ?? 'utf-8';
  const renameImpl = _testFs?.rename ?? fsSync.renameSync;
  const writeFileImpl = _testFs?.writeFile ?? fsSync.writeFileSync;

  const targetPath = options?.noFollow
    ? filePath
    : resolveSymlinkChainSync(filePath);
  const tmpPath = `${targetPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;

  // forceMode without mode falls back to permission preservation — otherwise
  // we'd silently downgrade an existing file's perms to the process umask.
  let existingMode: number | undefined;
  if (!options?.forceMode || options?.mode === undefined) {
    try {
      const stat = fsSync.statSync(targetPath);
      existingMode = stat.mode & 0o7777;
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  const desiredMode = existingMode ?? options?.mode;

  const writeOptions: {
    encoding?: BufferEncoding;
    flush?: boolean;
    mode?: number;
  } = {};
  if (typeof data === 'string') writeOptions.encoding = encoding;
  if (flush) writeOptions.flush = true;
  if (desiredMode !== undefined) writeOptions.mode = desiredMode;

  const tryChmodSync = (target: string): void => {
    if (desiredMode === undefined) return;
    try {
      fsSync.chmodSync(target, desiredMode);
    } catch {
      // Not all filesystems support chmod (FAT/exFAT).
    }
  };

  try {
    writeFileImpl(tmpPath, data, writeOptions);
    tryChmodSync(tmpPath);
    renameWithRetrySync(tmpPath, targetPath, retries, delayMs, renameImpl);
  } catch (error) {
    try {
      fsSync.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }

    if (isNodeError(error) && error.code === 'EXDEV') {
      try {
        if (options?.noFollow) {
          // See atomicWriteFile for the rationale — noFollow must not
          // be silently dropped on the cross-device fallback path.
          try {
            fsSync.unlinkSync(targetPath);
          } catch (unlinkErr) {
            if (!isNodeError(unlinkErr) || unlinkErr.code !== 'ENOENT') {
              throw unlinkErr;
            }
          }
          const fd = fsSync.openSync(
            targetPath,
            fsSync.constants.O_WRONLY |
              fsSync.constants.O_CREAT |
              fsSync.constants.O_EXCL,
            desiredMode ?? 0o666,
          );
          try {
            const buf =
              typeof data === 'string' ? Buffer.from(data, encoding) : data;
            fsSync.writeSync(fd, buf);
            if (flush) fsSync.fsyncSync(fd);
          } finally {
            fsSync.closeSync(fd);
          }
        } else {
          writeFileImpl(targetPath, data, writeOptions);
        }
        tryChmodSync(targetPath);
        return;
      } catch (fallbackError) {
        throw annotateWriteError(
          fallbackError,
          targetPath,
          'atomicWriteFileSync',
        );
      }
    }

    throw annotateWriteError(error, targetPath, 'atomicWriteFileSync');
  }
}
