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
    } finally {
      try {
        await release?.();
      } catch (err) {
        debug.warn('failed to release board item lock:', err);
      }
    }
  });
}
