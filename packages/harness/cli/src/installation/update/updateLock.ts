/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-based update lock — prevents concurrent upgrade/rollback operations.
 *
 * Aligned with Go source: cmd/update/common.go AcquireLock / ReleaseLock.
 *
 * Uses `O_CREAT|O_EXCL` (Node's 'wx' flag) for atomic lock file creation.
 * Lock content is JSON: `{ pid, timestamp, hostname }`.
 * Stale locks are detected via process liveness checks (PID existence + CLI
 * process verification) and are auto-cleaned.
 */

import { open, unlink, readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import type { FileHandle } from 'node:fs/promises';
import {
  BRAND_FIXED_CLI_BIN,
  runLogger,
  GLOBAL_CONFIG_DIR,
} from '@qwen-code/core';

import type { LockInfo } from './updateTypes.js';
import { LOCK_STALE_THRESHOLD_MS } from './updateTypes.js';

export function createUpdateLock(
  lockPath: string,
  processNames: readonly string[] = [BRAND_FIXED_CLI_BIN, 'lingma'],
) {
  const LOCK_PATH = lockPath;
  const LOCK_DIR = join(lockPath, '..');
  /**
   * Acquire the update lock file.
   *
   * Returns a FileHandle on success. The caller MUST call `releaseLock(handle)`
   * when done, even if the update itself fails.
   *
   * If another process holds a valid (non-expired) lock, throws an error.
   * Expired locks are automatically cleaned up before retrying.
   *
   * Aligned with Go `AcquireLock()`.
   */
  async function acquireLock(): Promise<FileHandle> {
    // Ensure lock directory exists
    await mkdir(LOCK_DIR, { recursive: true });

    try {
      return await tryCreateLock();
    } catch (err: unknown) {
      // Lock file already exists — check if it's stale
      if (isFileExistsError(err)) {
        const stale = await isLockStale();
        if (stale) {
          runLogger.debug('[UpdateLock] Stale lock detected, cleaning up');
          await forceRemoveLock();
          // Retry once after cleanup
          try {
            return await tryCreateLock();
          } catch (retryErr: unknown) {
            if (isFileExistsError(retryErr)) {
              throw new Error(
                `Another update process is running. Try again later or remove ~/${GLOBAL_CONFIG_DIR}/update.lock manually.`,
              );
            }
            throw retryErr;
          }
        }
        throw new Error(
          `Another update process is running. Try again later or remove ~/${GLOBAL_CONFIG_DIR}/update.lock manually.`,
        );
      }
      throw err;
    }
  }

  /**
   * Release the update lock.
   *
   * Closes the file handle and removes the lock file.
   * Aligned with Go `ReleaseLock()`.
   */
  async function releaseLock(handle: FileHandle): Promise<void> {
    try {
      await handle.close();
    } catch {
      // Ignore close errors
    }
    await forceRemoveLock();
  }

  /**
   * Non-blocking check: is the update lock currently held?
   *
   * Returns true if a valid (non-expired) lock exists.
   * Used by auto-update: if locked, skip silently instead of waiting.
   */
  async function isLocked(): Promise<boolean> {
    let content: string;
    try {
      content = await readFile(LOCK_PATH, 'utf-8');
    } catch {
      // No lock file — not locked
      return false;
    }

    let info: LockInfo;
    try {
      info = JSON.parse(content);
    } catch {
      // File exists but unparseable (empty or corrupt) — conservatively treat as locked
      runLogger.debug(
        '[UpdateLock] isLocked: lock file exists but unparseable, treating as locked',
      );
      return true;
    }

    // If the holding process is dead or not a CLI process, treat as unlocked
    if (!isProcessRunning(info.pid)) {
      runLogger.debug(
        '[UpdateLock] isLocked: PID not running, treating as unlocked',
      );
      return false;
    }

    if (!isCliProcess(info.pid)) {
      runLogger.debug(
        '[UpdateLock] isLocked: PID reused by non-CLI process, treating as unlocked',
      );
      return false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Process detection helpers (exported for testing)
  // ---------------------------------------------------------------------------

  /**
   * Check whether a process with the given PID is still running.
   *
   * Uses `process.kill(pid, 0)` which sends no signal but validates existence.
   */
  function isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0); // Signal 0: just checks existence
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false; // No such process
      if (code === 'EPERM') return true; // Process exists, no permission
      return false;
    }
  }

  /**
   * Best-effort check whether the given PID belongs to a CLI process.
   *
   * Guards against PID reuse: if the OS recycled the PID for an unrelated
   * process we should treat the lock as stale.
   *
   * Returns `false` (safe default — allows lock acquisition) when the command
   * line cannot be determined.
   */
  function isCliProcess(pid: number): boolean {
    if (process.platform === 'win32') {
      return isCliProcessWindows(pid);
    }
    try {
      // On Unix, try /proc first, then ps
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
        return processNames.some((name) => cmdline.includes(name));
      } catch {
        const output = execSync(`ps -p ${pid} -o command=`, {
          timeout: 3000,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return processNames.some((name) => output.includes(name));
      }
    } catch {
      return false; // Safe default: allow lock acquisition
    }
  }

  function isCliProcessWindows(pid: number): boolean {
    const matchesCli = (output: string): boolean => {
      const lower = output.toLowerCase();
      return processNames.some((name) => lower.includes(name.toLowerCase()));
    };

    // Prefer PowerShell CIM — works on every modern Windows including Win11
    // 24H2, which removed wmic.exe. `stdio[2]='ignore'` is essential: without
    // it, execSync inherits stderr to the parent process; when the install
    // flow runs under PowerShell with `$ErrorActionPreference='Stop'` and a
    // `2>&1` redirect, any leaked native stderr terminates the script.
    try {
      const psOutput = execSync(
        `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
        {
          timeout: 5000,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        },
      );
      return matchesCli(psOutput);
    } catch {
      // PowerShell unavailable / blocked / timed out — try wmic fallback.
    }

    try {
      const wmicOutput = execSync(
        `wmic process where ProcessId=${pid} get CommandLine /format:list`,
        {
          timeout: 3000,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        },
      );
      return matchesCli(wmicOutput);
    } catch {
      return false; // Safe default: allow lock acquisition
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Atomically create the lock file using 'wx' (O_CREAT|O_EXCL).
   * Throws EEXIST if file already exists.
   */
  async function tryCreateLock(): Promise<FileHandle> {
    const lockInfo: LockInfo = {
      pid: process.pid,
      timestamp: new Date().toISOString(),
      hostname: hostname(),
    };

    // Atomic create+write: single libuv operation eliminates empty-file window
    await writeFile(LOCK_PATH, JSON.stringify(lockInfo, null, 2), { flag: 'wx' });

    // Open read-only handle as token for releaseLock()
    const handle = await open(LOCK_PATH, 'r');
    runLogger.debug(`[UpdateLock] Lock acquired: pid=${process.pid}`);
    return handle;
  }

  /**
   * Check if the existing lock file is stale.
   *
   * A lock is stale when:
   *   1. The holding process is no longer running (crash / killed).
   *   2. The PID was reused by an unrelated (non-CLI) process.
   *   3. The lock file cannot be read or parsed.
   *
   * If the holding process is still alive *and* is a CLI process the lock is
   * considered valid regardless of age — long-running updates should not be
   * interrupted.
   */
  async function isLockStale(): Promise<boolean> {
    let content: string;
    try {
      content = await readFile(LOCK_PATH, 'utf-8');
    } catch {
      // Can't read — treat as stale
      return true;
    }

    let info: LockInfo;
    try {
      info = JSON.parse(content);
    } catch {
      // File exists but unparseable (empty or corrupt) — use mtime-based TTL
      return isLockMtimeStale();
    }

    const lockTime = new Date(info.timestamp).getTime();
    const age = Date.now() - lockTime;

    runLogger.debug(
      `[UpdateLock] Existing lock: pid=${info.pid}, age=${Math.round(age / 1000)}s, host=${info.hostname}`,
    );

    // If the process is not running, lock is immediately stale
    if (!isProcessRunning(info.pid)) {
      runLogger.debug(
        `[UpdateLock] PID ${info.pid} is not running — lock is stale`,
      );
      return true;
    }

    // If process is running but is NOT a CLI process (PID reuse), lock is stale
    if (!isCliProcess(info.pid)) {
      runLogger.debug(
        `[UpdateLock] PID ${info.pid} is running but is not a CLI process — lock is stale (PID reuse)`,
      );
      return true;
    }

    // Process is running and is a CLI process — lock is valid regardless of age
    runLogger.debug(
      `[UpdateLock] PID ${info.pid} is a running CLI process — lock is valid`,
    );
    return false;
  }

  /**
   * Fallback staleness check using file mtime for unparseable lock files.
   * If mtime < LOCK_STALE_THRESHOLD_MS ago → likely being written by a concurrent process → not stale.
   * If mtime >= LOCK_STALE_THRESHOLD_MS ago → crash residue → stale.
   */
  async function isLockMtimeStale(): Promise<boolean> {
    try {
      const st = await stat(LOCK_PATH);
      const age = Date.now() - st.mtimeMs;
      if (age < LOCK_STALE_THRESHOLD_MS) {
        runLogger.debug(
          `[UpdateLock] Unparseable lock file is recent (${Math.round(age / 1000)}s) — not stale`,
        );
        return false;
      }
      runLogger.debug(
        `[UpdateLock] Unparseable lock file is old (${Math.round(age / 1000)}s) — stale`,
      );
      return true;
    } catch {
      return true;
    }
  }

  /**
   * Force-remove the lock file (best-effort, no error on missing).
   */
  async function forceRemoveLock(): Promise<void> {
    try {
      await unlink(LOCK_PATH);
      runLogger.debug('[UpdateLock] Lock file removed');
    } catch {
      // Ignore — file might already be gone
    }
  }

  /**
   * Type guard for Node.js EEXIST errors.
   */
  function isFileExistsError(err: unknown): boolean {
    return (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'EEXIST'
    );
  }

  return { acquireLock, releaseLock, isLocked, isProcessRunning, isCliProcess };
}
export const acquireLock = (
  ...args: Parameters<ReturnType<typeof createUpdateLock>['acquireLock']>
) =>
  createUpdateLock(
    join(homedir(), GLOBAL_CONFIG_DIR, 'update.lock'),
  ).acquireLock(...args);
export const releaseLock = (
  ...args: Parameters<ReturnType<typeof createUpdateLock>['releaseLock']>
) =>
  createUpdateLock(
    join(homedir(), GLOBAL_CONFIG_DIR, 'update.lock'),
  ).releaseLock(...args);
export const isLocked = (
  ...args: Parameters<ReturnType<typeof createUpdateLock>['isLocked']>
) =>
  createUpdateLock(join(homedir(), GLOBAL_CONFIG_DIR, 'update.lock')).isLocked(
    ...args,
  );
export const isProcessRunning = (
  ...args: Parameters<ReturnType<typeof createUpdateLock>['isProcessRunning']>
) =>
  createUpdateLock(
    join(homedir(), GLOBAL_CONFIG_DIR, 'update.lock'),
  ).isProcessRunning(...args);
export const isCliProcess = (
  ...args: Parameters<ReturnType<typeof createUpdateLock>['isCliProcess']>
) =>
  createUpdateLock(
    join(homedir(), GLOBAL_CONFIG_DIR, 'update.lock'),
  ).isCliProcess(...args);
