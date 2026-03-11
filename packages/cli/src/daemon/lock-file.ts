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

/** Validate that a parsed object has the required DaemonLockInfo fields. */
function isValidLockInfo(obj: unknown): obj is DaemonLockInfo {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['pid'] === 'number' &&
    typeof o['port'] === 'number' &&
    typeof o['authToken'] === 'string' &&
    typeof o['cwd'] === 'string' &&
    typeof o['startedAt'] === 'string'
  );
}

/** Read the daemon lock file. Returns null if not found, invalid JSON, or missing fields. */
export function readLockFile(): DaemonLockInfo | null {
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (!isValidLockInfo(parsed)) {
      return null;
    }
    return parsed;
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

/**
 * Verify that a running process is actually the daemon by checking /health.
 * Falls back to true if the API is not reachable (process might be starting up).
 */
export async function verifyDaemonProcess(
  lock: DaemonLockInfo,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`http://127.0.0.1:${lock.port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: string; pid?: number };
    return body.status === 'ok' && body.pid === lock.pid;
  } catch {
    // API not reachable - process might exist but not be the daemon
    return false;
  }
}

/** Get the lock file path (for display purposes). */
export function getLockFilePath(): string {
  return LOCK_FILE;
}
