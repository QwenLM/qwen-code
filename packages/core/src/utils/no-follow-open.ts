/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cross-platform "open without following symlinks".
 *
 * POSIX provides `O_NOFOLLOW`: the kernel refuses to open a path whose final
 * component is a symlink (`ELOOP`). Windows has no such flag —
 * `fs.constants.O_NOFOLLOW` is `undefined` there — so flag expressions like
 * `(flags | (O_NOFOLLOW ?? 0))` silently collapse into a plain open that
 * follows symlinks (issue #8227). Callers must therefore never OR the flag
 * in themselves; they should open through this helper instead.
 *
 * When `O_NOFOLLOW` is unavailable, the helper compensates with an
 * lstat → open → fstat identity check:
 *
 *  1. `lstat` the path and refuse it when the final component is a symlink.
 *  2. Open the path.
 *  3. `fstat` the opened handle and require dev/ino to still match the
 *     `lstat` from step 1. If the path was replaced between the two calls
 *     (for example swapped for a symlink), the identities differ and the
 *     open is rejected after closing the handle again.
 *
 * Filesystems that do not expose inode numbers (`ino === 0`: FAT/exFAT,
 * some SMB shares) make step 3 vacuous, so the helper refuses the open
 * there rather than degrade to a plain open — the same fail-closed posture
 * used for unverifiable inode identities elsewhere (#8290, #9857).
 *
 * Every refusal is reported as an error with `code: 'ELOOP'` — the same
 * code POSIX `O_NOFOLLOW` produces — so existing `ELOOP` handling in
 * callers applies to the fallback path unchanged.
 */

import * as fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import { hasVerifiableInode } from './file-identity.js';

function noFollowRejection(
  filePath: string,
  reason: string,
): NodeJS.ErrnoException {
  const error = new Error(
    `Refusing to open '${filePath}' without a no-follow guarantee: ${reason}`,
  ) as NodeJS.ErrnoException;
  error.code = 'ELOOP';
  return error;
}

/**
 * Verify that the handle opened in step (2) still refers to the file seen by
 * the pre-open `lstat` (step 1). Throws an `ELOOP`-coded error when the
 * identity cannot be proven or has changed.
 */
function assertSameIdentity(
  filePath: string,
  before: fs.Stats,
  after: fs.Stats,
): void {
  if (!hasVerifiableInode(before.ino)) {
    throw noFollowRejection(
      filePath,
      'the filesystem reports inode 0, so the opened file cannot be ' +
        'proven identical to the one that was checked',
    );
  }
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw noFollowRejection(
      filePath,
      'the file identity changed between the pre-open check and the open ' +
        '(possible symlink race)',
    );
  }
}

function resolveBaseFlags(flags: number | undefined): number {
  // Optional chain so strict vitest mocks of node:fs that omit `constants`
  // degrade to plain O_RDONLY (= 0) instead of throwing at call time.
  return flags ?? fs.constants?.O_RDONLY ?? 0;
}

/**
 * The platform's O_NOFOLLOW flag, or `undefined` when the runtime does not
 * expose it (Windows) — the caller then takes the compensating path.
 */
function getNoFollowFlag(): number | undefined {
  return fs.constants?.O_NOFOLLOW;
}

/**
 * Synchronous variant of {@link openNoFollow}. Returns a raw fd; the caller
 * owns closing it.
 */
export function openSyncNoFollow(
  filePath: string,
  flags?: number,
  mode?: number,
): number {
  const baseFlags = resolveBaseFlags(flags);
  const noFollowFlag = getNoFollowFlag();
  if (typeof noFollowFlag === 'number') {
    return fs.openSync(filePath, baseFlags | noFollowFlag, mode);
  }

  const before = fs.lstatSync(filePath);
  if (before.isSymbolicLink()) {
    throw noFollowRejection(filePath, 'the path is a symlink');
  }
  const fd = fs.openSync(filePath, baseFlags, mode);
  try {
    assertSameIdentity(filePath, before, fs.fstatSync(fd));
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // The rejection below is the primary error; closing is best-effort.
    }
    throw error;
  }
  return fd;
}

/**
 * Open `filePath` without following a symlink in the final path component.
 *
 * On platforms with `O_NOFOLLOW` the guarantee is enforced by the kernel at
 * open time. Elsewhere an lstat → open → fstat identity check compensates
 * (see the module docs). Rejections carry `code: 'ELOOP'`. The caller owns
 * closing the returned handle.
 */
export async function openNoFollow(
  filePath: string,
  flags?: number,
  mode?: number,
): Promise<FileHandle> {
  const baseFlags = resolveBaseFlags(flags);
  const noFollowFlag = getNoFollowFlag();
  if (typeof noFollowFlag === 'number') {
    return fs.promises.open(filePath, baseFlags | noFollowFlag, mode);
  }

  const before = await fs.promises.lstat(filePath);
  if (before.isSymbolicLink()) {
    throw noFollowRejection(filePath, 'the path is a symlink');
  }
  const handle = await fs.promises.open(filePath, baseFlags, mode);
  try {
    assertSameIdentity(filePath, before, await handle.stat());
  } catch (error) {
    await handle.close().catch(() => {
      // The rejection below is the primary error; closing is best-effort.
    });
    throw error;
  }
  return handle;
}
