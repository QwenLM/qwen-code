/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment preparation manager.
 *
 * Orchestrates multiple EnvironmentPreparers, executing them in
 * registration order (dependencies first). Uses file-based locking
 * to prevent concurrent installations across CLI instances.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { BRAND_CLI_BIN } from '../../config/brand.js';
import { delay } from '../delay.js';
import { getErrorMessage } from '../errors.js';
import { runLogger } from '../runLogger.js';
import { isLockActivelyHeld, LockManager } from './lock.js';
import type { LockHandle } from './lock.js';
import type { EnvironmentPreparer } from './types.js';

export type PrepareAllResult =
  | { ok: true }
  | { ok: false; component: string; error: string; lockHeld?: boolean };

export class PrepareManager {
  private readonly preparers: EnvironmentPreparer[] = [];
  private readonly lockManager: LockManager;
  private readonly baseDir: string;
  private initialized = false;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.lockManager = new LockManager(baseDir);
  }

  /** Registers a preparer. Order matters — dependencies must go first. */
  registerPreparer(preparer: EnvironmentPreparer): void {
    this.preparers.push(preparer);
  }

  /**
   * Runs all preparers in sequence.
   *
   * For each preparer:
   * 1. Skip if not required or already installed
   * 2. Acquire file lock (skip if another instance holds it)
   * 3. Double-check installation (may have completed while waiting)
   * 4. Run prepare()
   * 5. Release lock
   *
   * Failures are returned to the caller.
   */
  async prepareAll(signal?: AbortSignal): Promise<PrepareAllResult> {
    signal?.throwIfAborted();
    if (!this.initialized) {
      this.initialize();
    }

    for (const preparer of this.preparers) {
      const required = await preparer.isRequired(signal);
      signal?.throwIfAborted();
      if (!required || preparer.isInstalled()) {
        runLogger.debug(
          `[envprep/manager] Skipping ${preparer.name()} preparer`,
        );
        continue;
      }

      const result = await this.acquireAndPrepare(
        preparer,
        /* allowRetry */ true,
        signal,
      );
      if (!result.ok) return result;
    }

    return { ok: true };
  }

  /**
   * Attempts to acquire the component lock and run the preparer. If another
   * process holds the lock, waits for that component and retries once if the
   * other process exits without completing it.
   */
  private async acquireAndPrepare(
    preparer: EnvironmentPreparer,
    allowRetry: boolean,
    signal?: AbortSignal,
  ): Promise<PrepareAllResult> {
    signal?.throwIfAborted();
    let handle: LockHandle | undefined;
    try {
      handle = this.lockManager.acquireLock(preparer.name());
    } catch (err) {
      runLogger.debug(
        `[envprep/manager] Failed to acquire lock for ${preparer.name()}: ${err instanceof Error ? err.message : err}`,
      );
      const waitResult = await this.waitForComponent(preparer, signal);
      if (waitResult.ok) return { ok: true };

      if (allowRetry && !waitResult.lockHeld) {
        if (preparer.isInstalled()) return { ok: true };
        return this.acquireAndPrepare(preparer, /* allowRetry */ false, signal);
      }
      return waitResult;
    }

    try {
      handle.startHeartbeat();

      if (preparer.isInstalled()) {
        runLogger.debug(
          `[envprep/manager] Skipping ${preparer.name()}: installed by another process while waiting for lock`,
        );
        return { ok: true };
      }

      runLogger.log(`[envprep/manager] Preparing: ${preparer.name()}`);
      const start = Date.now();

      await preparer.prepare(signal);
      signal?.throwIfAborted();

      const duration = Date.now() - start;
      runLogger.log(
        `[envprep/manager] Successfully prepared ${preparer.name()} in ${duration}ms`,
      );

      return { ok: true };
    } catch (err) {
      signal?.throwIfAborted();
      const error = getErrorMessage(err);
      runLogger.warn(
        `[envprep/manager] Failed to prepare ${preparer.name()}: ${error}`,
      );
      return { ok: false, component: preparer.name(), error };
    } finally {
      handle.release();
    }
  }

  private async waitForComponent(
    preparer: EnvironmentPreparer,
    signal?: AbortSignal,
  ): Promise<PrepareAllResult> {
    const component = preparer.name();
    const pollInterval = 3000;
    const deadline = Date.now() + 5 * 60 * 1000;
    const lockPath = path.join(this.baseDir, '.locks', `${component}.lock`);

    runLogger.warn(
      `[envprep/manager] Another process is preparing ${component}; waiting`,
    );

    while (Date.now() < deadline) {
      await delay(pollInterval, signal);

      if (preparer.isInstalled()) return { ok: true };

      if (!existsSync(lockPath)) {
        if (preparer.isInstalled()) return { ok: true };
        return {
          ok: false,
          component,
          error: `other process released ${component} lock without completing installation`,
        };
      }

      if (!isLockActivelyHeld(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          component,
          error: `other process died during ${component} installation`,
        };
      }
    }

    return {
      ok: false,
      component,
      error: `timed out waiting for another process to complete ${component}`,
      lockHeld: true,
    };
  }

  private initialize(): void {
    try {
      mkdirSync(this.baseDir, { recursive: true });
    } catch (err) {
      runLogger.warn(
        `[envprep/manager] Failed to create base directory ${this.baseDir}: ${getErrorMessage(err)}`,
      );
    }

    // Clean up stale temp files from previous failed attempts
    cleanStaleTempFiles(this.baseDir);

    this.initialized = true;
  }
}

/**
 * Removes download temp files older than 1 hour.
 * Called during manager initialization to prevent disk-space leaks.
 */
function cleanStaleTempFiles(_baseDir: string): void {
  // Temp files are stored in os.tmpdir(), not baseDir.
  // This is a best-effort cleanup — failures are silently ignored.
  try {
    const tmpDir = path.join(os.tmpdir(), `${BRAND_CLI_BIN}-downloads`);
    const entries = readdirSync(tmpDir, { withFileTypes: true });
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour ago

    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      const fullPath = path.join(tmpDir, entry.name);
      try {
        const stat = statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(fullPath);
          runLogger.debug(
            `[envprep/manager] Cleaned stale temp file: ${entry.name}`,
          );
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* temp dir may not exist yet — that's fine */
  }
}
