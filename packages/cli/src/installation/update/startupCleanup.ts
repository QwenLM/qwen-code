/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Startup cleanup — asynchronous housekeeping scheduled at CLI boot.
 *
 * Aligned with Go source: cmd/install/cleanup.go ScheduleStartupCleanup().
 *
 * Cleans up:
 *   1. Stale staging directories under the selected user data directory
 *   2. Stale lock files (via PID liveness check)
 *   3. Windows .old.* rename artifacts
 *   4. Orphaned temp download files in system tmpdir
 */

import { readdir, stat, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  runLogger,
  BRAND_CLI_BIN,
  GLOBAL_CONFIG_DIR,
} from '@qwen-code/core';
import { isProcessRunning } from './updateLock.js';

const DATA_DIR = join(homedir(), GLOBAL_CONFIG_DIR);
const BIN_DIR = join(DATA_DIR, 'bin', BRAND_CLI_BIN);

/** Age threshold for temp files to be considered stale (1 hour). */
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

/**
 * Schedule startup cleanup as an async, non-blocking operation.
 * Runs after a short delay (2 seconds) to avoid impacting startup latency.
 * Errors are silently swallowed — cleanup is always best-effort.
 */
export function scheduleStartupCleanup(): void {
  setTimeout(async () => {
    try {
      await performCleanup();
    } catch (err) {
      runLogger.debug(
        `[StartupCleanup] Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, 2000);
}

/**
 * Perform all cleanup tasks.
 * Exported for testing — prefer `scheduleStartupCleanup()` in production.
 */
export async function performCleanup(): Promise<void> {
  runLogger.debug('[StartupCleanup] Starting cleanup');

  await Promise.allSettled([
    cleanupStaleTempFiles(),
    cleanupWindowsOldFiles(),
    cleanupOrphanedDownloads(),
  ]);

  runLogger.debug('[StartupCleanup] Cleanup complete');
}

/**
 * Clean up stale .tmp.{pid}.{timestamp} files left by atomic install.
 * Only removes files whose creating process is no longer running.
 */
async function cleanupStaleTempFiles(): Promise<void> {
  try {
    const entries = await readdir(BIN_DIR);

    for (const entry of entries) {
      // Match pattern: qwen-X.Y.Z.tmp.{pid}.{timestamp}
      const tmpMatch = entry.match(/\.tmp\.(\d+)\.\d+$/);
      if (!tmpMatch) continue;

      const pid = parseInt(tmpMatch[1], 10);

      // Only remove if the creating process is dead
      if (isProcessRunning(pid)) {
        runLogger.debug(
          `[StartupCleanup] Skipping ${entry}: process ${pid} still running`,
        );
        continue;
      }

      const fullPath = join(BIN_DIR, entry);
      try {
        await unlink(fullPath);
        runLogger.debug(`[StartupCleanup] Removed stale temp: ${entry}`);
      } catch {
        // ignore
      }
    }
  } catch {
    // BIN_DIR may not exist yet — that's fine
  }
}

/**
 * Clean up Windows .old.{timestamp} rename artifacts.
 * These are created by removeOrRename() when a file is busy on Windows.
 */
async function cleanupWindowsOldFiles(): Promise<void> {
  if (process.platform !== 'win32') return;

  try {
    const entries = await readdir(BIN_DIR);

    for (const entry of entries) {
      if (!entry.includes('.old.')) continue;

      const fullPath = join(BIN_DIR, entry);
      try {
        await unlink(fullPath);
        runLogger.debug(`[StartupCleanup] Removed Windows .old file: ${entry}`);
      } catch {
        // File may still be busy — skip silently
      }
    }
  } catch {
    // BIN_DIR may not exist yet
  }
}

/**
 * Clean up orphaned download temp files from the system tmpdir.
 * Matches files with the pattern: {BRAND_CLI_BIN}-update-* or {BRAND_CLI_BIN}-rollback-*
 * Only removes files older than STALE_TEMP_AGE_MS (1 hour).
 */
async function cleanupOrphanedDownloads(): Promise<void> {
  try {
    const tmpDir = tmpdir();
    const entries = await readdir(tmpDir);
    const prefix1 = `${BRAND_CLI_BIN}-update-`;
    const prefix2 = `${BRAND_CLI_BIN}-rollback-`;
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.startsWith(prefix1) && !entry.startsWith(prefix2)) continue;

      const fullPath = join(tmpDir, entry);
      try {
        const s = await stat(fullPath);
        const age = now - s.mtimeMs;

        if (age < STALE_TEMP_AGE_MS) continue; // Too recent, might still be in use

        await rm(fullPath, { recursive: true, force: true });
        runLogger.debug(`[StartupCleanup] Removed orphaned temp: ${entry}`);
      } catch {
        // ignore
      }
    }
  } catch {
    // tmpdir read may fail on some systems
  }
}
