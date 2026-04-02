/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * File-based lock for multi-session coordination.
 *
 * Uses a PID-based liveness check: the owning session writes a JSON lock
 * file with its PID. Other sessions detect a stale lock when the PID is
 * dead AND the heartbeat is older than STALE_THRESHOLD_MS.
 */

import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_FILENAME = 'loop-lock.json';

/**
 * A lock with a heartbeat older than this is considered stale
 * (only when the PID is also dead). Heartbeat renewal interval
 * for callers that want to implement it: 30 seconds.
 */
const STALE_THRESHOLD_MS = 60_000;

interface LockData {
  sessionId: string;
  pid: number;
  acquiredAt: number;
  heartbeatAt: number;
}

function getLockPath(qwenDir: string): string {
  return join(qwenDir, LOCK_FILENAME);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence only
    return true;
  } catch {
    return false;
  }
}

async function readLock(qwenDir: string): Promise<LockData | null> {
  try {
    const data = await readFile(getLockPath(qwenDir), 'utf-8');
    const parsed = JSON.parse(data);
    if (
      parsed &&
      typeof parsed.sessionId === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.heartbeatAt === 'number'
    ) {
      return parsed as LockData;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeLock(qwenDir: string, data: LockData): Promise<boolean> {
  try {
    await mkdir(qwenDir, { recursive: true });
    await writeFile(getLockPath(qwenDir), JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to acquire the scheduler lock.
 *
 * Returns true if this session now holds the lock (either freshly acquired
 * or already owned). Returns false if another live session holds it.
 */
export async function acquireLock(
  qwenDir: string,
  sessionId: string,
): Promise<boolean> {
  const existing = await readLock(qwenDir);
  const now = Date.now();

  if (!existing) {
    // No lock — claim it
    return writeLock(qwenDir, {
      sessionId,
      pid: process.pid,
      acquiredAt: now,
      heartbeatAt: now,
    });
  }

  if (existing.sessionId === sessionId) {
    // Already ours — renew
    return writeLock(qwenDir, {
      ...existing,
      pid: process.pid,
      heartbeatAt: now,
    });
  }

  // Another session's lock — check liveness
  const isStale =
    now - existing.heartbeatAt > STALE_THRESHOLD_MS &&
    !isPidAlive(existing.pid);

  if (isStale) {
    // Take over stale lock
    return writeLock(qwenDir, {
      sessionId,
      pid: process.pid,
      acquiredAt: now,
      heartbeatAt: now,
    });
  }

  // Another live session holds the lock
  return false;
}

/**
 * Renew the heartbeat. Only writes if this session owns the lock.
 */
export async function renewHeartbeat(
  qwenDir: string,
  sessionId: string,
): Promise<void> {
  const existing = await readLock(qwenDir);
  if (existing && existing.sessionId === sessionId) {
    await writeLock(qwenDir, {
      ...existing,
      pid: process.pid,
      heartbeatAt: Date.now(),
    });
  }
}

/**
 * Release the lock if owned by this session.
 */
export async function releaseLock(
  qwenDir: string,
  sessionId: string,
): Promise<void> {
  const existing = await readLock(qwenDir);
  if (existing && existing.sessionId === sessionId) {
    try {
      await unlink(getLockPath(qwenDir));
    } catch {
      // Ignore ENOENT
    }
  }
}

/**
 * Check if the lock is currently held by a live session.
 */
export async function isLockHeld(
  qwenDir: string,
): Promise<{ held: boolean; sessionId?: string }> {
  const existing = await readLock(qwenDir);
  if (!existing) return { held: false };
  const isStale =
    Date.now() - existing.heartbeatAt > STALE_THRESHOLD_MS &&
    !isPidAlive(existing.pid);
  if (isStale) return { held: false };
  return { held: true, sessionId: existing.sessionId };
}
