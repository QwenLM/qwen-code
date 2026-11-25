/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Dream consolidation lock and transcript scan helpers.
 *
 * The lock file's mtime is the last successful consolidation timestamp. The
 * file body is the holder PID while a consolidation is in flight.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runLogger } from '../../utils/runLogger.js';

const LOCK_FILE = '.consolidate-lock';
const HOLDER_STALE_MS = 60 * 60 * 1000;

function lockPath(memoryDir: string): string {
  return path.join(memoryDir, LOCK_FILE);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseHolderPid(raw: string): number | undefined {
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/**
 * Returns the timestamp the scheduler should apply to its time gate.
 *
 * An empty body is the completed-consolidation watermark. A live PID body is
 * an in-flight lease whose mtime suppresses a duplicate worker. Once that PID
 * exits, its acquisition mtime must not pass as a successful consolidation.
 * Reclaim it before the time gate; otherwise one interrupted Dream suppresses
 * the next attempt for the full consolidation interval.
 */
export async function readLastConsolidatedAt(
  memoryDir: string,
): Promise<number> {
  const filePath = lockPath(memoryDir);
  try {
    const [stat, raw] = await Promise.all([
      fs.stat(filePath),
      fs.readFile(filePath, 'utf8'),
    ]);
    const holderPid = parseHolderPid(raw);
    if (holderPid === undefined || isProcessRunning(holderPid)) {
      return stat.mtimeMs;
    }

    await fs.unlink(filePath);
    runLogger.debug(
      `[AutoDream] reclaimed lock from exited PID ${holderPid} before time gate`,
    );
    return 0;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code !== 'ENOENT'
    ) {
      runLogger.debug(
        '[AutoDream] failed to read or reclaim consolidation lock:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return 0;
  }
}

/**
 * Writes the current PID and returns the previous mtime for rollback. Returns
 * null when another live process appears to hold the lock.
 */
export async function tryAcquireConsolidationLock(
  memoryDir: string,
): Promise<number | null> {
  const filePath = lockPath(memoryDir);

  let previousMtime: number | undefined;
  let holderPid: number | undefined;
  try {
    const [stat, raw] = await Promise.all([
      fs.stat(filePath),
      fs.readFile(filePath, 'utf8'),
    ]);
    previousMtime = stat.mtimeMs;
    holderPid = parseHolderPid(raw);
  } catch {
    // No prior lock, or unreadable body. Treat as reclaimable.
  }

  if (
    previousMtime !== undefined &&
    Date.now() - previousMtime < HOLDER_STALE_MS &&
    holderPid !== undefined &&
    isProcessRunning(holderPid)
  ) {
    runLogger.debug(
      `[AutoDream] lock held by live PID ${holderPid} (${Math.round(
        (Date.now() - previousMtime) / 1000,
      )}s old)`,
    );
    return null;
  }

  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(filePath, String(process.pid), 'utf8');

  try {
    const verify = await fs.readFile(filePath, 'utf8');
    if (parseHolderPid(verify) !== process.pid) {
      return null;
    }
  } catch {
    return null;
  }

  return previousMtime ?? 0;
}

/**
 * Restores the pre-acquire mtime if the dream fork fails.
 */
export async function rollbackConsolidationLock(
  memoryDir: string,
  priorMtime: number,
): Promise<void> {
  const filePath = lockPath(memoryDir);
  try {
    if (priorMtime === 0) {
      await fs.unlink(filePath);
      return;
    }

    await fs.writeFile(filePath, '', 'utf8');
    const timeSeconds = priorMtime / 1000;
    await fs.utimes(filePath, timeSeconds, timeSeconds);
  } catch (error) {
    runLogger.debug(
      '[AutoDream] rollback failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Marks a completed consolidation by clearing the in-flight holder PID. The
 * lock file mtime remains the scheduling timestamp for the next dream run.
 */
export async function markConsolidationComplete(
  memoryDir: string,
): Promise<void> {
  await fs.writeFile(lockPath(memoryDir), '', 'utf8');
}

function isSafeTranscriptFileName(fileName: string): boolean {
  if (!fileName.endsWith('.jsonl')) return false;
  const sessionId = path.basename(fileName, '.jsonl');
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) &&
    !sessionId.includes('..') &&
    !sessionId.startsWith('agent-')
  );
}

/**
 * Lists session IDs whose transcript file was touched after `sinceMs`.
 */
export async function listSessionsTouchedSince(
  transcriptDir: string,
  sinceMs: number,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(transcriptDir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const touched = await Promise.all(
    entries.filter(isSafeTranscriptFileName).map(async (fileName) => {
      const filePath = path.join(transcriptDir, fileName);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.mtimeMs <= sinceMs) return undefined;
        return path.basename(fileName, '.jsonl');
      } catch {
        return undefined;
      }
    }),
  );

  return touched.filter((id): id is string => id !== undefined);
}
