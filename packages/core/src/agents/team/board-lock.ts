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

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
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
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function assertSafeName(kind: string, name: string): void {
  if (
    !SAFE_NAME.test(name) ||
    name === '.' ||
    name === '..' ||
    name.endsWith('.') ||
    WINDOWS_DEVICE_NAME.test(name)
  ) {
    throw new Error(
      `Invalid ${kind} "${name}". Use 1-64 characters: letters, digits, ` +
        `dot, dash or underscore, starting with a letter or digit.`,
    );
  }
}

const ITEM_ID =
  /^[adt]-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertItemId(
  kind: string,
  id: string,
  prefix?: 'a' | 'd' | 't',
): void {
  if (!ITEM_ID.test(id) || (prefix && !id.startsWith(`${prefix}-`))) {
    throw new Error(`Invalid ${kind} "${id}".`);
  }
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
}

export async function createBoardRecord<T>(
  board: string,
  collection: string,
  prefix: 'a' | 'd' | 't',
  build: (id: string) => T,
): Promise<T> {
  assertSafeName('board name', board);
  assertSafeName('collection name', collection);
  const root = getBoardsRootDir();
  const boardDir = getBoardDir(board);
  const collectionDir = getCollectionDir(board, collection);
  await ensurePrivateDir(root);
  await ensurePrivateDir(boardDir);
  await ensurePrivateDir(collectionDir);

  for (let attempt = 0; attempt < 3; attempt++) {
    const id = `${prefix}-${randomUUID()}`;
    const record = build(id);
    try {
      await fsp.writeFile(
        path.join(collectionDir, `${id}.json`),
        JSON.stringify(record, null, 2),
        { flag: 'wx', mode: 0o600, flush: true },
      );
      return record;
    } catch (err) {
      if (isNodeError(err) && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`Could not allocate a ${collection} id.`);
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
  settledAt: (record: unknown) => number | null,
  olderThanMs: number,
  now: number = Date.now(),
): Promise<string[]> {
  assertSafeName('board name', board);
  assertSafeName('collection name', collection);
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
    throw new Error('olderThanMs must be a non-negative finite number.');
  }
  if (!Number.isFinite(now)) throw new Error('now must be a finite number.');
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
    await withItemLock(
      full,
      async () => {
        const raw = await fsp.readFile(full, 'utf8');
        let timestamp: number | null;
        try {
          timestamp = settledAt(JSON.parse(raw));
        } catch (err) {
          debug.warn(`skipping invalid ${file}:`, err);
          return;
        }
        if (
          timestamp === null ||
          !Number.isFinite(timestamp) ||
          now - timestamp < olderThanMs
        ) {
          return;
        }
        await fsp.unlink(full);
        removed.push(file);
      },
      () => {},
    );
  }
  return removed;
}
