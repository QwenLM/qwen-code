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

const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
    factor: 2,
    // Jitter so in-process and cross-process contenders don't retry in
    // lockstep and starve each other out of the retry budget.
    randomize: true,
  },
  stale: 5000,
  onCompromised: (err) => {
    debug.warn('board item lock compromised:', err);
  },
};

const fileLocks = new Map<string, Mutex>();

function getFileLock(filePath: string): Mutex {
  let lock = fileLocks.get(filePath);
  if (!lock) {
    lock = new Mutex();
    fileLocks.set(filePath, lock);
  }
  return lock;
}

/**
 * Run `fn` holding both the in-process mutex and the cross-process file lock
 * for `filePath`. Release of both is automatic.
 *
 * A file that vanishes before the lock is taken surfaces as `onMissing()`
 * rather than a raw ENOENT — callers treat a vanished item as "not found",
 * which is the same outcome a concurrent prune produces.
 */
export async function withItemLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  onMissing: () => T,
): Promise<T> {
  return getFileLock(filePath).runExclusive(async () => {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(filePath, LOCK_OPTIONS);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return onMissing();
      throw err;
    }
    try {
      return await fn();
    } catch (err) {
      // A file removed between taking the lock and reading it — a concurrent
      // prune — must surface as the caller's "not found", the same as one that
      // vanished before the lock. Otherwise callers see a raw ENOENT the
      // onMissing contract said they would not.
      if (isNodeError(err) && err.code === 'ENOENT') return onMissing();
      throw err;
    } finally {
      try {
        await release?.();
      } catch (err) {
        debug.warn('failed to release board item lock:', err);
      }
      // Drop the mutex once nobody is queued on it. Keeping one per path for
      // the process lifetime is unbounded growth for a long-lived
      // `board watch`, and re-creating an uncontended mutex costs nothing.
      const held = fileLocks.get(filePath);
      if (held && !held.isLocked()) fileLocks.delete(filePath);
    }
  });
}

/**
 * Remove settled items older than `olderThanMs`.
 *
 * Deliberately manual rather than automatic: deleting a record another
 * participant may be mid-read on is a concurrency problem worth not having,
 * and a fetch-based system has no daemon that could be trusted to run a sweep.
 * The caller decides when the board is quiet.
 *
 * `isSettled` decides what counts as finished for a collection, so each item
 * type keeps its own definition rather than this module knowing all three.
 */
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
        updatedAt?: number;
      };
      if (!isSettled(record)) continue;
      const at = record.settledAt ?? record.resolvedAt ?? record.updatedAt ?? 0;
      if (!at || now - at < olderThanMs) continue;
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
