/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getTaskOutputDir, isNodeError, runLogger } from '@qwen-code/core';

const RETENTION_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface BackgroundLogCleanupResult {
  scanned: number;
  deleted: number;
  failed: number;
}

/**
 * Cleans up task output files older than 7 days.
 * Scans the TaskOutput directory for .output files.
 *
 * @param debugMode Whether to log detailed debug information.
 */
export async function cleanupBackgroundLogs(
  debugMode: boolean = false,
): Promise<BackgroundLogCleanupResult> {
  const result: BackgroundLogCleanupResult = {
    scanned: 0,
    deleted: 0,
    failed: 0,
  };
  try {
    const outputDir = getTaskOutputDir();

    let entries;
    try {
      entries = await fs.readdir(outputDir, { withFileTypes: true });
    } catch (error) {
      // Directory doesn't exist, nothing to clean up
      if (!(isNodeError(error) && error.code === 'ENOENT')) {
        result.failed++;
      }
      return result;
    }

    const now = Date.now();

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.output')) {
        result.scanned++;
        const filePath = path.join(outputDir, entry.name);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtime.getTime() > RETENTION_PERIOD_MS) {
            await fs.unlink(filePath);
            result.deleted++;
          }
        } catch (error) {
          result.failed++;
          if (debugMode) {
            runLogger.debug(
              `Failed to process output file ${entry.name}:`,
              error,
            );
          }
        }
      }
    }

    if (result.deleted > 0 && debugMode) {
      runLogger.debug(
        `Cleaned up ${result.deleted} expired task output files.`,
      );
    }
  } catch (error) {
    result.failed++;
    // Best-effort cleanup, don't let it crash the CLI
    if (debugMode) {
      runLogger.warn('Task output cleanup failed:', error);
    }
  }
  return result;
}
