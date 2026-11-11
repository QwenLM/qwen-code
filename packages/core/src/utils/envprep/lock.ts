/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-based locking for environment preparation.
 *
 * Prevents multiple CLI instances from downloading/installing the same
 * component concurrently. Lock files are JSON containing the PID and
 * timestamp, enabling stale-lock detection (process died, or timed out).
 *
 * Modeled after the Go version's envprep/lock.go.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runLogger } from '../runLogger.js';

const LOCK_STALE_THRESHOLD = 30 * 1000; // 30 seconds (3× heartbeat interval)
const HEARTBEAT_INTERVAL = 10 * 1000; // 10 seconds

/** Contents persisted inside each lock file. */
interface LockData {
  pid: number;
  ownerId: string;
  createdAt: string; // ISO-8601
  hostname?: string;
}

export interface LockHandle {
  touch(): void;
  startHeartbeat(): void;
  release(): void;
}

/**
 * Checks whether a process with the given PID is still alive.
 * Uses the "kill 0" trick — it sends no signal but throws if the
 * process does not exist.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but we lack permission to signal it
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'EPERM'
    ) {
      return true;
    }
    return false;
  }
}

/**
 * Checks whether a lock described by `data` should be considered stale.
 * A lock is stale when it has timed out OR the holder process is dead.
 */
function isLockStale(lockFilePath: string, data: LockData): boolean {
  if (data.pid > 0 && !isProcessAlive(data.pid)) return true;
  try {
    const stat = fs.statSync(lockFilePath);
    if (Date.now() - stat.mtimeMs >= LOCK_STALE_THRESHOLD) return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * Reads and parses a lock file. Returns `null` if the file does not
 * exist or cannot be parsed.
 */
function readLockFile(lockFile: string): LockData | null {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    return JSON.parse(raw) as LockData;
  } catch {
    return null;
  }
}

/**
 * Returns `true` if the lock file at `lockFilePath` is held by a live
 * process that has not timed out.
 *
 * Used by the installer to decide whether to wait for another owner.
 */
export function isLockActivelyHeld(lockFilePath: string): boolean {
  const data = readLockFile(lockFilePath);
  if (!data) return fs.existsSync(lockFilePath);
  return !isLockStale(lockFilePath, data);
}

// ─── LockManager ────────────────────────────────────────────────────────────

class FileLockHandle implements LockHandle {
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly lockDir: string,
    private readonly resourceName: string,
    private readonly pid: number,
    private readonly ownerId: string,
  ) {}

  touch(): void {
    const lockFile = path.join(this.lockDir, `${this.resourceName}.lock`);
    try {
      const data = readLockFile(lockFile);
      if (!data || data.pid !== this.pid || data.ownerId !== this.ownerId) {
        this.stopHeartbeat();
        return;
      }
      const now = new Date();
      fs.utimesSync(lockFile, now, now);
    } catch {
      this.stopHeartbeat();
    }
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.touch(), HEARTBEAT_INTERVAL);
    this.heartbeatTimer.unref?.();
  }

  release(): void {
    this.stopHeartbeat();
    const lockFile = path.join(this.lockDir, `${this.resourceName}.lock`);
    try {
      const data = readLockFile(lockFile);
      if (data?.pid === this.pid && data.ownerId === this.ownerId) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // File may already have been removed — harmless
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}

export class LockManager {
  private readonly lockDir: string;

  constructor(baseDir: string) {
    this.lockDir = path.join(baseDir, '.locks');
  }

  /**
   * Attempts to acquire an exclusive lock for `resourceName`.
   * Throws if another live process already holds the lock.
   */
  acquireLock(resourceName: string): LockHandle {
    fs.mkdirSync(this.lockDir, { recursive: true });
    const lockFile = path.join(this.lockDir, `${resourceName}.lock`);

    // Check for an existing lock
    const existing = readLockFile(lockFile);
    if (existing) {
      if (!isLockStale(lockFile, existing)) {
        throw new Error(
          `Another process is preparing ${resourceName} ` +
            `(pid: ${existing.pid}, started: ${existing.createdAt})`,
        );
      }
      // Stale — remove and continue
      runLogger.warn(
        `[envprep/lock] Removing stale lock for ${resourceName} (pid: ${existing.pid})`,
      );
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // ignore — may have been cleaned by another process
      }
    }

    // Create lock file exclusively (O_EXCL prevents TOCTOU races)
    const data: LockData = {
      pid: process.pid,
      ownerId: randomUUID(),
      createdAt: new Date().toISOString(),
      hostname: os.hostname(),
    };

    let fd: number | undefined;
    try {
      fd = fs.openSync(
        lockFile,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o644,
      );
      fs.writeSync(fd, JSON.stringify(data));
      runLogger.debug(
        `[envprep/lock] Acquired lock for ${resourceName} (pid: ${data.pid})`,
      );
      const handle = new FileLockHandle(
        this.lockDir,
        resourceName,
        data.pid,
        data.ownerId,
      );
      return handle;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        throw new Error(
          `Another process is preparing ${resourceName} (lock file appeared between check and create)`,
        );
      }
      throw err;
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }
}
