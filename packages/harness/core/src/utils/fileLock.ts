/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { lock } from 'proper-lockfile';
import { runLogger } from './runLogger.js';
import { isNodeError } from './errors.js';

// A missed heartbeat past this window permits stale-lock takeover.
const STALE_MS = 30_000;
/** Waits start short and cap here, so a lock freed quickly is noticed quickly. */
const MAX_RETRY_INTERVAL_MS = 100;

/** The lock was taken over while held; the guarded write must not commit. */
export class LockLostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LockLostError';
  }
}

/** A held lock. `assertHeld` throws once another process took it over. */
export interface FileLock {
  release: () => Promise<void>;
  /** Call before commit; throws if lock loss has been detected. */
  assertHeld: () => void;
}

/** Allows missing target files and retries for approximately `waitMs`. */
export async function acquireFileLock(
  filePath: string,
  waitMs = 3_000,
): Promise<FileLock> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let compromised: Error | undefined;
  const release = await lock(filePath, {
    retries: {
      retries: Math.ceil(waitMs / MAX_RETRY_INTERVAL_MS),
      minTimeout: 5,
      maxTimeout: MAX_RETRY_INTERVAL_MS,
    },
    stale: STALE_MS,
    realpath: false,
    // Record lock loss instead of crashing from proper-lockfile's timer.
    onCompromised: (error) => {
      compromised = error;
      runLogger.warn(
        `[file-lock] ${filePath} was taken over while held`,
        error,
      );
    },
  });
  return {
    release,
    assertHeld() {
      if (compromised) {
        throw new LockLostError(
          `Lost the lock on ${filePath}: another process took it over`,
          { cause: compromised },
        );
      }
    },
  };
}

/** Long enough to outlast a dead holder's lock, which then counts as stale. */
export const OUTLAST_STALE_LOCK_MS = STALE_MS + 5_000;

// Fail promptly rather than waiting out a crashed holder's stale window.
const FILE_LOCK_WAIT_MS = 5_000;

/** Holds the physical-file lock; callers must check `assertHeld` before commit. */
export async function withFileLock<T>(
  filePath: string,
  action: (assertHeld: () => void) => Promise<T>,
  /** @visiblefortesting Shorter wait, so a test need not wait it out. */
  waitMs = FILE_LOCK_WAIT_MS,
): Promise<T> {
  let handle: FileLock;
  try {
    handle = await acquireFileLock(filePath, waitMs);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ELOCKED') throw error;
    throw new Error(
      `Could not lock ${filePath}: another process is writing it; try again`,
      { cause: error },
    );
  }
  try {
    return await action(handle.assertHeld);
  } finally {
    await handle.release().catch((error) => {
      // A release failure must not replace the operation's result.
      runLogger.warn(`[file-lock] ${filePath} could not be released`, error);
    });
  }
}
