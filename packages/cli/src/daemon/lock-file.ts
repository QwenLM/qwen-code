/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DaemonLockInfo } from './types.js';

const LOCK_DIR = path.join(os.homedir(), '.qwen', 'daemon');
const LOCK_FILE = path.join(LOCK_DIR, 'daemon.lock');

/** Write the daemon lock file with process information. */
export function writeLockFile(info: DaemonLockInfo): void {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify(info, null, 2), 'utf-8');
}

/** Read the daemon lock file. Returns null if not found or invalid. */
export function readLockFile(): DaemonLockInfo | null {
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf-8');
    return JSON.parse(content) as DaemonLockInfo;
  } catch {
    return null;
  }
}

/** Remove the daemon lock file. */
export function removeLockFile(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // Ignore if file doesn't exist
  }
}

/** Check if the process recorded in the lock file is still running. */
export function isDaemonRunning(lock: DaemonLockInfo): boolean {
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Get the lock file path (for display purposes). */
export function getLockFilePath(): string {
  return LOCK_FILE;
}
