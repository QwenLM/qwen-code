/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Two-tier locking for board item files.
 *
 * An in-process `Mutex` per path serializes local writers so they don't
 * stampede the OS lock (the cause of Windows `ELOCKED` flakiness), wrapping a
 * `proper-lockfile` cross-process lock that guards writers in other agent
 * processes, over `atomicWriteJSON`.
 *
 * The same discipline already exists twice — `tasks.ts` (`withTaskFileLock`)
 * and `mailbox.ts` (`withInboxLock`) — with the second documented as mirroring
 * the first. This module is the extracted form, used by the newer board items;
 * folding those two onto it is a follow-up, deliberately not bundled here so
 * adding `ask` and `decision` does not also rewrite the task and mailbox
 * paths.
 */

import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { Mutex } from 'async-mutex';
import { Storage } from '../../config/storage.js';
import { isNodeError } from '../../utils/errors.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debug = createDebugLogger('BOARD_LOCK');

/** Root for all boards: `~/.qwen/boards/`. */
export const BOARDS_DIR = 'boards';

export function getBoardsRootDir(): string {
  return path.join(Storage.getGlobalQwenDir(), BOARDS_DIR);
}

/** `~/.qwen/boards/{board}/` */
export function getBoardDir(board: string): string {
  return path.join(getBoardsRootDir(), board);
}

/** `~/.qwen/boards/{board}/{collection}/` */
export function getCollectionDir(board: string, collection: string): string {
  return path.join(getBoardDir(board), collection);
}

/**
 * Board and collection names reach the filesystem directly, so reject anything
 * that could escape the root. Deliberately stricter than "no slashes": a name
 * that survives this is also safe to print, to type into a command, and to use
 * as a JSON key.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertSafeName(kind: string, name: string): void {
  if (!SAFE_NAME.test(name) || name === '.' || name === '..') {
    throw new Error(
      `Invalid ${kind} "${name}". Use 1-64 characters: letters, digits, ` +
        `dot, dash or underscore, starting with a letter or digit.`,
    );
  }
}

/**
 * Build a two-tier lock over a family of files.
 *
 * The discipline is the same everywhere it is used — an in-process `Mutex` per
 * path so local writers do not stampede the OS lock (the cause of Windows
 * `ELOCKED` flakiness), wrapping a `proper-lockfile` cross-process lock — but
 * the tuning is not. `mailbox.ts` deliberately retries 10 times where the task
 * board retries 30, and logs a compromised lock at a quieter level. A factory
 * keeps one implementation without flattening those choices into it.
 *
 * `retries` is the cross-process retry budget; `onCompromised` receives a lock
 * that went stale under us.
 */
export function createItemLock(options: {
  retries: number;
  onCompromised: (err: Error) => void;
}) {
  const lockOptions: lockfile.LockOptions = {
    retries: {
      retries: options.retries,
      minTimeout: 5,
      maxTimeout: 100,
      factor: 2,
      // Jitter the backoff so in-process and cross-process contenders don't
      // retry in lockstep (thundering herd) and starve each other out of the
      // retry budget.
      randomize: true,
    },
    stale: 5000,
    onCompromised: options.onCompromised,
  };

  const fileLocks = new Map<string, Mutex>();

  /**
   * Run `fn` holding both the in-process mutex and the cross-process file lock
   * for `filePath`. Release of both is automatic.
   *
   * A file that vanishes — before the lock is taken, or between taking it and
   * reading — surfaces as `onMissing()` when one is given, and otherwise
   * rethrows. Callers that treat a vanished record as "not found" pass one;
   * callers that consider it a real error do not.
   */
  const withLock = async function <T>(
    filePath: string,
    fn: () => Promise<T>,
    onMissing?: () => T,
  ): Promise<T> {
    let lock = fileLocks.get(filePath);
    if (!lock) {
      lock = new Mutex();
      fileLocks.set(filePath, lock);
    }
    return lock
      .runExclusive(async () => {
        let release: (() => Promise<void>) | undefined;
        try {
          release = await lockfile.lock(filePath, lockOptions);
        } catch (err) {
          if (isNodeError(err) && err.code === 'ENOENT' && onMissing) {
            return onMissing();
          }
          throw err;
        }
        try {
          return await fn();
        } catch (err) {
          if (isNodeError(err) && err.code === 'ENOENT' && onMissing) {
            return onMissing();
          }
          throw err;
        } finally {
          try {
            await release?.();
          } catch (err) {
            debug.warn('failed to release lock:', err);
          }
        }
      })
      .finally(() => {
        // Drop the mutex once nobody is queued on it. This must run AFTER
        // runExclusive releases the mutex — inside the callback isLocked() is
        // always true because this caller itself holds it, so the delete was
        // unreachable and the map grew without bound for a long-lived reader.
        const held = fileLocks.get(filePath);
        if (held && !held.isLocked()) fileLocks.delete(filePath);
      });
  };

  return withLock;
}

/** The board's own lock: the same budget the task board uses. */
export const withItemLock = createItemLock({
  retries: 30,
  onCompromised: (err) => debug.warn('board item lock compromised:', err),
});

export async function pruneCollection(
  board: string,
  collection: string,
  filenamePattern: RegExp,
  isSettled: (record: unknown) => boolean,
  olderThanMs: number,
  now: number = Date.now(),
): Promise<string[]> {
  assertSafeName('board name', board);
  const dir = getCollectionDir(board, collection);
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }

  const removed: string[] = [];
  for (const file of files) {
    if (!filenamePattern.test(file)) continue;
    const full = path.join(dir, file);
    try {
      const raw = await fsp.readFile(full, 'utf8');
      if (!raw.trim()) continue;
      const record = JSON.parse(raw) as {
        settledAt?: number | null;
        resolvedAt?: number | null;
        expiresAt?: number;
        updatedAt?: number;
      };
      if (!isSettled(record)) continue;
      const timestamp =
        record.settledAt ??
        record.resolvedAt ??
        record.expiresAt ??
        record.updatedAt;
      if (timestamp === undefined || timestamp === null) continue;
      // A non-numeric or unparseable timestamp must never read as "older than
      // cutoff": `now - "…"` is NaN and `NaN < olderThanMs` is false, which
      // would unlink a file the age gate exists to protect. Skip anything that
      // does not resolve to a finite millisecond timestamp.
      const at =
        typeof timestamp === 'number'
          ? timestamp
          : typeof timestamp === 'string'
            ? Date.parse(timestamp)
            : NaN;
      if (!Number.isFinite(at) || now - at < olderThanMs) continue;
      // Take the lock so a concurrent settle cannot be lost between the read
      // above and the unlink.
      await withItemLock(
        full,
        async () => {
          await fsp.unlink(full);
          removed.push(file);
        },
        () => {},
      );
    } catch (err) {
      debug.warn(`skipping unprunable ${file}:`, err);
    }
  }
  return removed;
}
