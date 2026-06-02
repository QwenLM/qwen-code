/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createDebugLogger } from './debugLogger.js';
import { isNodeError } from './errors.js';

const debugLogger = createDebugLogger('ATOMIC_WRITE');

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
 * Atomically write content to a file (write-to-temp + rename).
 *
 * Falls back to in-place write when the existing file's uid differs
 * from the process's euid — POSIX rename would reset ownership.
 * Also falls back on EXDEV (cross-device). Both fallbacks lose crash
 * atomicity but preserve the existing inode's uid.
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
    chmod?: typeof fs.chmod;
    fchmod?: (fh: fs.FileHandle, mode: number) => Promise<void>;
    unlink?: typeof fs.unlink;
  },
): Promise<void> {
  const retries = options?.retries ?? 3;
  const delayMs = options?.delayMs ?? 50;
  const flush = options?.flush ?? true;
  const encoding = options?.encoding ?? 'utf-8';
  const renameImpl = _testFs?.rename ?? fs.rename;
  const writeFileImpl = _testFs?.writeFile ?? fs.writeFile;
  const chmodImpl = _testFs?.chmod ?? fs.chmod;
  const fchmodImpl =
    _testFs?.fchmod ?? ((fh: fs.FileHandle, mode: number) => fh.chmod(mode));
  const unlinkImpl = _testFs?.unlink ?? fs.unlink;

  // Annotate symlink resolution failures (EACCES on intermediate dir,
  // ELOOP on circular chain) with the logical filePath so they share
  // the `atomicWriteFile("path"): ...` prefix the rest of the function
  // applies — otherwise incident-response logs reference an
  // intermediate path component that the caller never asked about.
  const targetPath = options?.noFollow
    ? filePath
    : await resolveSymlinkChain(filePath).catch((err) => {
        throw annotateWriteError(err, filePath);
      });

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

  // forceMode skips permission preservation only when an explicit mode is
  // supplied — otherwise we'd silently downgrade an existing file's perms
  // to the process umask. forceMode without mode falls back to preservation.
  let existingMode: number | undefined;
  if (!options?.forceMode || options?.mode === undefined) {
    existingMode =
      existingStat !== undefined ? existingStat.mode & 0o7777 : undefined;
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

  // chmod fails on filesystems without POSIX permissions (FAT/exFAT) —
  // narrow the catch to ENOSYS/ENOTSUP so security-relevant errors
  // (sandbox EPERM, transient EIO, read-only EROFS) propagate. This
  // matters specifically on the EXDEV non-noFollow fallback below,
  // where tryChmod is the *sole* mode-setting mechanism for an
  // existing target (writeFile ignores `mode` when the target exists).
  // Non-credential callers don't pass `mode`, so `desiredMode ===
  // undefined` short-circuits before any chmod is attempted.
  const tryChmod = async (target: string): Promise<void> => {
    if (desiredMode === undefined) return;
    try {
      await chmodImpl(target, desiredMode);
    } catch (chmodErr) {
      if (
        !isNodeError(chmodErr) ||
        (chmodErr.code !== 'ENOSYS' && chmodErr.code !== 'ENOTSUP')
      ) {
        throw chmodErr;
      }
    }
  };

  // Detect when atomic rename would silently change ownership. POSIX
  // rename creates a new inode owned by the process's euid:egid; if the
  // existing file has a different uid, fall back to in-place write which
  // preserves the inode and therefore uid. Only uid is compared — gid
  // is intentionally skipped because macOS inherits the parent
  // directory's GID for new files, making egid !== file.gid a
  // false positive on the most common dev platform.
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
    await writeFileImpl(tmpPath, data, writeOptions);
    await tryChmod(tmpPath);
    await renameWithRetry(tmpPath, targetPath, retries, delayMs, renameImpl);
  } catch (error) {
    // Clean up temp file. Routed through unlinkImpl so the test
    // seam covers every fs.unlink call site in this function (pre-open,
    // tmp cleanup, orphan cleanup) — keeps the seam abstraction
    // consistent for future test authors even though this branch is
    // best-effort.
    try {
      await unlinkImpl(tmpPath);
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
          // that races back into existence. Non-ENOENT errors
          // (EACCES on parent dir, EROFS, etc.) propagate so the
          // caller sees the real cause instead of a downstream
          // EEXIST from O_EXCL.
          try {
            await unlinkImpl(targetPath);
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
          let writeOk = false;
          try {
            try {
              await fd.writeFile(
                typeof data === 'string' ? Buffer.from(data, encoding) : data,
              );
              if (flush) await fd.sync();
              // fchmod via the open fd — immune to symlink swap between
              // close and a path-based chmod, which would otherwise redirect
              // the 0o600 onto an attacker-pointed target and silently
              // defeat noFollow on the EXDEV fallback path.
              //
              // Narrow the catch to FAT/exFAT signatures (ENOSYS / ENOTSUP).
              // Operations on credential files are security-sensitive enough
              // that a sandbox EPERM, transient EIO, or read-only EROFS
              // should fail loudly rather than leave the file at the
              // umask-masked open() mode with no diagnostic trail.
              if (desiredMode !== undefined) {
                try {
                  await fchmodImpl(fd, desiredMode);
                } catch (chmodErr) {
                  if (
                    !isNodeError(chmodErr) ||
                    (chmodErr.code !== 'ENOSYS' && chmodErr.code !== 'ENOTSUP')
                  ) {
                    throw chmodErr;
                  }
                }
              }
              writeOk = true;
            } finally {
              await fd.close();
            }
          } catch (writeErr) {
            // O_EXCL created targetPath; if any of write/sync/fchmod
            // threw, remove the orphan so the next retry doesn't
            // deadlock on EEXIST (e.g. credential refresh loop after
            // a transient seccomp EPERM on `fchmod`).
            if (!writeOk) {
              try {
                await unlinkImpl(targetPath);
              } catch (orphanErr) {
                // Best-effort cleanup, but log so incident response
                // can correlate the original write error with a
                // subsequent EEXIST loop.
                debugLogger.debug(
                  `orphan unlink failed for ${targetPath}:`,
                  orphanErr,
                );
              }
            }
            throw writeErr;
          }
        } else {
          await writeFileImpl(targetPath, data, writeOptions);
          await tryChmod(targetPath);
        }
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

function annotateWriteError(
  error: unknown,
  targetPath: string,
  fnName: string = 'atomicWriteFile',
): unknown {
  if (error instanceof Error && !error.message.startsWith(`${fnName}(`)) {
    error.message = `${fnName}(${JSON.stringify(targetPath)}): ${error.message}`;
  }
  return error;
}

/** Atomically write a JSON value to a file. Delegates to {@link atomicWriteFile}. */
export async function atomicWriteJSON(
  filePath: string,
  data: unknown,
  options?: AtomicWriteFileOptions,
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
    chmod?: typeof fsSync.chmodSync;
    fchmod?: (fd: number, mode: number) => void;
    unlink?: typeof fsSync.unlinkSync;
  },
): void {
  const retries = options?.retries ?? 3;
  const delayMs = options?.delayMs ?? 50;
  const flush = options?.flush ?? true;
  const encoding = options?.encoding ?? 'utf-8';
  const renameImpl = _testFs?.rename ?? fsSync.renameSync;
  const writeFileImpl = _testFs?.writeFile ?? fsSync.writeFileSync;
  const chmodImpl = _testFs?.chmod ?? fsSync.chmodSync;
  const fchmodImpl = _testFs?.fchmod ?? fsSync.fchmodSync;
  const unlinkImpl = _testFs?.unlink ?? fsSync.unlinkSync;

  // Annotate symlink-resolution failures with the logical filePath
  // (see atomicWriteFile for rationale).
  let targetPath: string;
  if (options?.noFollow) {
    targetPath = filePath;
  } else {
    try {
      targetPath = resolveSymlinkChainSync(filePath);
    } catch (err) {
      throw annotateWriteError(err, filePath, 'atomicWriteFileSync');
    }
  }
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

  // See tryChmod in atomicWriteFile for rationale on the narrowed catch.
  const tryChmodSync = (target: string): void => {
    if (desiredMode === undefined) return;
    try {
      chmodImpl(target, desiredMode);
    } catch (chmodErr) {
      if (
        !isNodeError(chmodErr) ||
        (chmodErr.code !== 'ENOSYS' && chmodErr.code !== 'ENOTSUP')
      ) {
        throw chmodErr;
      }
    }
  };

  try {
    writeFileImpl(tmpPath, data, writeOptions);
    tryChmodSync(tmpPath);
    renameWithRetrySync(tmpPath, targetPath, retries, delayMs, renameImpl);
  } catch (error) {
    // See atomicWriteFile for the unlinkImpl-seam routing rationale.
    try {
      unlinkImpl(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }

    if (isNodeError(error) && error.code === 'EXDEV') {
      try {
        if (options?.noFollow) {
          // See atomicWriteFile for the rationale — noFollow must not
          // be silently dropped on the cross-device fallback path.
          // Non-ENOENT errors propagate.
          try {
            unlinkImpl(targetPath);
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
          let writeOk = false;
          try {
            try {
              const buf =
                typeof data === 'string' ? Buffer.from(data, encoding) : data;
              // writeFileSync(fd, buf) loops until the full buffer is
              // written. Plain `fsSync.writeSync(fd, buf)` returns the
              // bytes-actually-written and can short-write, which would
              // silently truncate the credential file while still
              // reaching fsync + fchmod. The async sibling
              // (`fd.writeFile`) handles short-writes internally; the
              // sync path now matches.
              fsSync.writeFileSync(fd, buf);
              if (flush) fsSync.fsyncSync(fd);
              // fchmod on the open fd (see atomicWriteFile for rationale).
              // Narrow the catch to FAT/exFAT signatures so EPERM/EIO/EROFS
              // surface instead of leaving a credential file at the
              // umask-masked open() mode silently.
              if (desiredMode !== undefined) {
                try {
                  fchmodImpl(fd, desiredMode);
                } catch (chmodErr) {
                  if (
                    !isNodeError(chmodErr) ||
                    (chmodErr.code !== 'ENOSYS' && chmodErr.code !== 'ENOTSUP')
                  ) {
                    throw chmodErr;
                  }
                }
              }
              writeOk = true;
            } finally {
              fsSync.closeSync(fd);
            }
          } catch (writeErr) {
            // O_EXCL created targetPath; remove the orphan on failure
            // so subsequent retries don't deadlock on EEXIST.
            if (!writeOk) {
              try {
                unlinkImpl(targetPath);
              } catch (orphanErr) {
                debugLogger.debug(
                  `orphan unlink failed for ${targetPath}:`,
                  orphanErr,
                );
              }
            }
            throw writeErr;
          }
        } else {
          writeFileImpl(targetPath, data, writeOptions);
          tryChmodSync(targetPath);
        }
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
