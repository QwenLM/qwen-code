/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, open, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('HOUSEKEEPING');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const STALE_LOCK_MS = 60 * 60 * 1000;

export interface ThrottledOnceOptions {
  // mtime-bearing file: if its mtime is within minIntervalMs, skip.
  markerPath: string;
  // O_EXCL lock file (typically markerPath + '.lock').
  lockPath: string;
  // Skip if marker was touched in the last this many ms. Default 24h.
  minIntervalMs?: number;
  // Take over a lockfile older than this. Default 1h.
  staleLockMs?: number;
  // Tag for debug logs.
  name: string;
}

// Run task at most once per minIntervalMs per machine across concurrent
// processes. Cooperative: no waiting, no retries — losers return immediately.
// Returns true if task ran, false if skipped (recently done or lock held).
export async function runThrottledOnce(
  opts: ThrottledOnceOptions,
  task: () => Promise<void>,
): Promise<boolean> {
  const minIntervalMs = opts.minIntervalMs ?? ONE_DAY_MS;
  const staleLockMs = opts.staleLockMs ?? STALE_LOCK_MS;

  // First-ever housekeeping pass may run before ~/.qwen/ exists. mode 0o700
  // matches the rest of the codebase's convention for ~/.qwen/ subdirs
  // (e.g., file-token-storage.ts, sharedTokenManager.ts) so a slow main-app
  // initialization doesn't get races us into creating a world-readable dir.
  await mkdir(dirname(opts.lockPath), { recursive: true, mode: 0o700 }).catch(
    () => {},
  );

  if (await markerIsFresh(opts.markerPath, minIntervalMs, opts.name)) {
    return false;
  }

  let acquired = await tryAcquire(opts.lockPath);
  if (!acquired) {
    // Possibly stale from crashed process — check age and take over.
    // There is a tiny race between `unlink` and the second `tryAcquire`
    // where another process can grab the lock; this is intentional
    // best-effort semantics — losers just skip and retry next cycle.
    try {
      const s = await stat(opts.lockPath);
      if (Date.now() - s.mtimeMs > staleLockMs) {
        await unlink(opts.lockPath).catch(() => {});
        acquired = await tryAcquire(opts.lockPath);
      }
    } catch {
      // Lock vanished between checks — try once more.
      acquired = await tryAcquire(opts.lockPath);
    }
    if (!acquired) {
      debugLogger.debug(`${opts.name}: skipping, lock held`);
      return false;
    }
  }

  try {
    // Re-check marker AFTER acquiring the lock. Closes the TOCTOU window
    // where another process completed the work between our initial mtime
    // check and our lock acquisition. One extra `stat` per run; cheap.
    if (await markerIsFresh(opts.markerPath, minIntervalMs, opts.name)) {
      return false;
    }

    let taskCompleted = false;
    try {
      await task();
      taskCompleted = true;
    } finally {
      // Persist the marker only after successful task completion. Marker
      // write failure is treated as benign: cleanup already ran, and the
      // worst outcome of a missing marker is that the next process re-runs
      // the (idempotent) task. Logging at debug level keeps it from
      // masquerading as a task failure in scheduler.ts's runPass log.
      if (taskCompleted) {
        try {
          await writeFile(opts.markerPath, new Date().toISOString());
        } catch (err) {
          debugLogger.debug(
            `${opts.name}: marker write failed (cleanup succeeded)`,
            err,
          );
        }
      }
    }
    return taskCompleted;
  } finally {
    await unlink(opts.lockPath).catch(() => {
      debugLogger.debug(`${opts.name}: lock unlink failed (harmless)`);
    });
  }
}

async function markerIsFresh(
  markerPath: string,
  minIntervalMs: number,
  name: string,
): Promise<boolean> {
  try {
    const s = await stat(markerPath);
    const age = Date.now() - s.mtimeMs;
    if (age < minIntervalMs) {
      debugLogger.debug(`${name}: skipping, ran ${age}ms ago`);
      return true;
    }
  } catch {
    // marker missing — treat as not fresh.
  }
  return false;
}

async function tryAcquire(lockPath: string): Promise<boolean> {
  try {
    const fh = await open(lockPath, 'wx');
    await fh.close();
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') {
      return false;
    }
    throw e;
  }
}
