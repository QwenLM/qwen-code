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
 * In-place truncate+write hardened against post-stat races:
 *
 * - `O_NOFOLLOW` rejects a final-component symlink (no follow to
 *   attacker-chosen target).
 * - **No `O_CREAT`** surfaces `ENOENT` instead of silently recreating a
 *   file the attacker just unlinked — which would re-introduce the
 *   exact ownership reset this whole codepath exists to prevent.
 * - **No `O_TRUNC` at open time**: opening with `O_TRUNC` would
 *   truncate immediately, *before* the fd-bound `fstat` check could
 *   detect that the path was swapped to a different inode between the
 *   caller's stat and our open. We open write-only without truncating,
 *   verify the bound inode against `expectedStat`, and only then call
 *   `fh.truncate(0)` through the validated fd.
 * - **`O_NONBLOCK`** so a post-stat swap from a regular file to a FIFO
 *   doesn't hang `open()` indefinitely waiting for a reader. For
 *   regular files `O_NONBLOCK` is a no-op; for FIFOs without a reader
 *   it fails immediately with `ENXIO`.
 * - **`fstat` verifies `dev` + `ino` + `uid` + `gid` + regular-file
 *   status** against the caller's `expectedStat`. uid/gid alone would
 *   miss a same-owner inode swap (attacker replaces the file with a
 *   different inode of their own); `!isFile()` catches a special-file
 *   swap that survives `O_NONBLOCK` (e.g. FIFO with a live reader).
 * - **Post-write `nlink === 0` check** detects the
 *   fstat-to-close window: a concurrent `rename(other, targetPath)`
 *   between fstat and close drops our bound inode's link count to
 *   zero. The data we wrote goes to an anonymous inode that close
 *   frees — silent data loss. Catching `nlink === 0` surfaces this
 *   as `EINODE_UNLINKED_DURING_WRITE`.
 *
 * Caller should confirm `existingStat.isFile()` before invoking so the
 * in-place path is skipped for known non-regular targets. Defense in
 * depth: if the file is swapped to a non-regular target post-stat,
 * `O_NONBLOCK` prevents hanging on FIFO open and the fstat guard
 * rejects all non-regular files via `!fdStat.isFile()`.
 *
 * **chmod via `fh.chmod` is best-effort**:
 * - Root (Docker-as-root, the PR's target): chmod succeeds and is
 *   load-bearing — POSIX clears setuid/setgid on write to a file
 *   with those bits, so chmod restores them.
 * - Non-root with `uid !== fdStat.uid`: chmod is guaranteed to
 *   fail with EPERM (POSIX requires file owner or root for chmod).
 *   We skip the syscall in that case to avoid the guaranteed failure.
 *
 * **Known limitation — no advisory locking between concurrent
 * in-place writers**: two concurrent `atomicWriteFile` calls that
 * both take the in-place fallback have no mutual exclusion between
 * `truncate(0)` and `writeFile` completion. Last-writer-wins with
 * possibly interleaved content. The atomic rename path is immune to
 * this. If multi-process coordinated writes against a shared file
 * are needed, callers should layer their own `flock`/lockfile.
 *
 * @remarks
 * **Freshness contract**: `expectedStat` MUST be captured by a fresh
 * `fs.stat(targetPath)` immediately before calling this function. A
 * stale or cached stat silently nullifies every guard (the
 * dev/ino/uid/gid verification becomes a tautology against the wrong
 * baseline). The function is exported solely for unit testability;
 * the only production caller is `atomicWriteFile` in this same file.
 *
 * @throws EOWNERSHIP_CHANGED — fstat mismatch (path swapped post-stat).
 * @throws EINODE_UNLINKED_DURING_WRITE — concurrent rename-over dropped
 *   our bound inode to nlink 0 between fstat and close.
 * @throws EINPLACE_TRUNCATE_FAILED — fh.truncate(0) failed; original
 *   content is still intact.
 * @throws EINPLACE_WRITE_FAILED — fh.writeFile failed after truncate;
 *   file is now empty or partially written.
 */
export async function writeInPlaceWithFdGuards(
  targetPath: string,
  data: string | Buffer,
  expectedStat: Stats,
  options: { encoding?: BufferEncoding; flush?: boolean; mode?: number },
): Promise<void> {
  const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
  const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
  // No O_TRUNC: truncation must wait until after fd-bound verification.
  // O_NONBLOCK: avoid hanging if the path was swapped to a FIFO.
  const flags = fs.constants.O_WRONLY | O_NOFOLLOW | O_NONBLOCK;
  const fh = await fs.open(targetPath, flags);
  try {
    const fdStat = await fh.stat();
    if (
      !fdStat.isFile() ||
      fdStat.dev !== expectedStat.dev ||
      fdStat.ino !== expectedStat.ino ||
      fdStat.uid !== expectedStat.uid ||
      fdStat.gid !== expectedStat.gid
    ) {
      const err: NodeJS.ErrnoException = new Error(
        `${targetPath} was swapped between stat and open ` +
          `(expected dev=${expectedStat.dev} ino=${expectedStat.ino} ` +
          `uid=${expectedStat.uid} gid=${expectedStat.gid} regular=true; ` +
          `got dev=${fdStat.dev} ino=${fdStat.ino} ` +
          `uid=${fdStat.uid} gid=${fdStat.gid} regular=${fdStat.isFile()})`,
      );
      err.code = 'EOWNERSHIP_CHANGED';
      throw err;
    }
    // Wrap truncate so callers can distinguish "truncate failed, original
    // intact" from "write failed after truncate, original lost".
    try {
      await fh.truncate(0);
    } catch (truncErr) {
      const err: NodeJS.ErrnoException = new Error(
        `In-place truncate of ${targetPath} failed before any data was lost; ` +
          `original content is intact. Cause: ` +
          (truncErr instanceof Error ? truncErr.message : String(truncErr)),
      );
      err.code = 'EINPLACE_TRUNCATE_FAILED';
      (err as Error & { cause?: unknown }).cause = truncErr;
      throw err;
    }
    const fhWriteOptions: { encoding?: BufferEncoding } = {};
    if (typeof data === 'string' && options.encoding) {
      fhWriteOptions.encoding = options.encoding;
    }
    // Note: do NOT pass `flush: true` here — Node.js silently ignores
    // the flush option on `FileHandle.writeFile` (it's only honored on
    // the path-based `fs.writeFile` form). We issue an explicit
    // `fh.sync()` after the write succeeds.
    try {
      await fh.writeFile(data, fhWriteOptions);
    } catch (writeErr) {
      const err: NodeJS.ErrnoException = new Error(
        `In-place write to ${targetPath} failed after truncate(0); ` +
          `file is now empty or partially written. Cause: ` +
          (writeErr instanceof Error ? writeErr.message : String(writeErr)),
      );
      err.code = 'EINPLACE_WRITE_FAILED';
      (err as Error & { cause?: unknown }).cause = writeErr;
      throw err;
    }
    // Explicit data fsync — fh.writeFile does not honor flush on a
    // FileHandle, so without this the just-written bytes sit in the
    // kernel page cache and a power loss can leave the file empty
    // (truncate succeeded) or partially written. Must run *before*
    // the chmod block so it fsyncs even when canChmod=false — that
    // branch is the exact shared-write scenario this PR targets.
    if (options.flush) {
      try {
        await fh.sync();
      } catch {
        // Best-effort: not all filesystems support fsync.
      }
    }
    if (options.mode !== undefined) {
      // Skip chmod when we know it will EPERM — non-root callers cannot
      // chmod files they don't own. Use fdStat.uid (fd-bound, verified
      // by the guard above) rather than expectedStat.uid so a future
      // refactor of the guard doesn't silently weaken this check.
      const euid = process.geteuid?.();
      const canChmod = euid === undefined || euid === 0 || euid === fdStat.uid;
      if (canChmod) {
        try {
          await fh.chmod(options.mode);
          // chmod is metadata-only; the data fsync above covered the
          // bytes but not the mode change. A second sync ensures the
          // mode restoration survives a crash before lazy metadata
          // flush (matters for setuid/setgid bits).
          if (options.flush) {
            try {
              await fh.sync();
            } catch {
              // Best-effort.
            }
          }
        } catch {
          // Ignore — not all filesystems support chmod.
        }
      }
    }
    // Fstat-to-close window: a concurrent rename-over after our guard
    // unlinks the inode we're holding. Our truncate + writeFile land on
    // an anonymous inode that close will free. Detect via nlink === 0.
    try {
      const finalStat = await fh.stat();
      if (finalStat.nlink === 0) {
        const err: NodeJS.ErrnoException = new Error(
          `${targetPath}: bound inode was unlinked between fstat and close ` +
            `(concurrent rename-over). Our write went to an anonymous inode ` +
            `that will be freed; data at ${targetPath} reflects the racing ` +
            `writer's content, not ours.`,
        );
        err.code = 'EINODE_UNLINKED_DURING_WRITE';
        throw err;
      }
    } catch (err) {
      // Re-throw our EINODE_UNLINKED_DURING_WRITE; ignore fstat itself
      // failing (best-effort detection only).
      if (isNodeError(err) && err.code === 'EINODE_UNLINKED_DURING_WRITE') {
        throw err;
      }
    }
  } finally {
    // close() can throw on NFS (COMMIT failure) or FUSE. Don't let it
    // mask the original try-body exception — the explicit fh.sync()
    // above already fsync'd the data, so close failure is best-effort.
    try {
      await fh.close();
    } catch {
      // ignore
    }
  }
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
 * 6. **Ownership preservation.** If the existing file is a regular
 *    file owned by a different uid/gid than the calling process's
 *    euid/egid, fall back to in-place truncate+write instead of
 *    rename. POSIX rename creates a new inode owned by the process's
 *    euid/egid, which would silently strip the original ownership and
 *    break shared-write setups (e.g. group-writable files in a shared
 *    workspace, or files inside a bind-mounted Docker volume edited
 *    by root in-container). The in-place write preserves the inode —
 *    and therefore uid/gid — at the cost of four observable shifts:
 *      - **Crash atomicity** — a crash mid-write can leave a
 *        partially-written file.
 *      - **Concurrent reader isolation** — readers can observe a
 *        zero-length or partial file during the write.
 *      - **Watcher semantics** — emits an inotify `MODIFY` event rather
 *        than `MOVED_TO` / `CREATE`. Most watchers (chokidar, VSCode)
 *        handle both, but consumers that only watch for one will miss
 *        these writes.
 *      - **Hardlink propagation** — rename creates a fresh inode, so
 *        sibling hardlinks to the previous inode retain the old
 *        content; in-place truncate+write keeps the inode, so every
 *        hardlink to it sees the new content. Backup / snapshot /
 *        dedup workflows that watch hardlink siblings will see a
 *        behavior shift.
 *    The in-place path is hardened against symlink-swap, unlink-race,
 *    and inode-swap attacks via `O_NOFOLLOW` + missing `O_CREAT` +
 *    post-open `fstat` verification. Non-regular targets (FIFO,
 *    socket, device) bypass the in-place fallback and take the atomic
 *    rename path, which has well-defined "replace with regular file"
 *    semantics instead of FIFO-blocking or device-write footguns.
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

  // Non-regular targets (FIFO, socket, device) skip the in-place
  // fallback even when ownership mismatches: open(O_WRONLY|O_TRUNC) on
  // a FIFO blocks until a reader appears, and on a device writes to the
  // actual device. Both are far worse than the alternative "rename
  // replaces the special file with a regular file" semantics that the
  // atomic path provides for these cases.
  if (
    existingStat !== undefined &&
    existingStat.isFile() &&
    ownershipWouldChange()
  ) {
    try {
      await writeInPlaceWithFdGuards(targetPath, data, existingStat, {
        encoding: typeof data === 'string' ? encoding : undefined,
        flush,
        mode: desiredMode,
      });
      return;
    } catch (err) {
      // File deleted between caller's stat and in-place open — nothing
      // to preserve. Fall through to the atomic rename path, which will
      // correctly create a new file at targetPath.
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw err;
      }
    }
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
 * Delegates to {@link atomicWriteFile}. The write is **conditionally**
 * atomic: when the existing file's uid/gid matches the calling
 * process's euid/egid, this uses the write-to-temp + rename atomic
 * path. When ownership differs (shared-write workspace, Docker
 * bind-mount edited by a different user), it falls back to in-place
 * truncate+write to preserve uid/gid — see the ownership-preservation
 * note on {@link atomicWriteFile} for the full trade-off list.
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
