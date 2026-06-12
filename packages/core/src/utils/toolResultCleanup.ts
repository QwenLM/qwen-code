/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('TOOL_RESULT_CLEANUP');

export interface CleanupResult {
  filesDeleted: number;
  bytesFreed: number;
  errors: number;
}

export async function cleanupOldToolResults(
  globalTempDir: string,
  maxAgeMs: number,
): Promise<CleanupResult> {
  const result: CleanupResult = { filesDeleted: 0, bytesFreed: 0, errors: 0 };

  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(globalTempDir);
  } catch (error) {
    debugLogger.debug(`Cannot read globalTempDir ${globalTempDir}:`, error);
    return result;
  }

  const now = Date.now();

  for (const projectHash of projectDirs) {
    const projectDir = path.join(globalTempDir, projectHash);

    let projectStat;
    try {
      projectStat = await fs.lstat(projectDir);
    } catch (error) {
      debugLogger.debug(`Cannot stat ${projectDir}:`, error);
      result.errors++;
      continue;
    }
    if (!projectStat.isDirectory()) continue;

    await cleanupDirectory(
      path.join(projectDir, 'tool-results'),
      now,
      maxAgeMs,
      result,
    );
    await cleanupLegacyOutputFiles(projectDir, now, maxAgeMs, result);
  }

  if (result.filesDeleted > 0) {
    debugLogger.debug(
      `Cleaned up ${result.filesDeleted} tool result files, freed ${Math.round(result.bytesFreed / 1024)} KB`,
    );
  }
  if (result.errors > 0) {
    debugLogger.warn(
      `${result.errors} errors during tool result cleanup`,
    );
  }

  return result;
}

async function cleanupDirectory(
  dir: string,
  now: number,
  maxAgeMs: number,
  result: CleanupResult,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    debugLogger.debug(`Cannot read directory ${dir}:`, error);
    return;
  }

  for (const entry of entries) {
    await tryDeleteIfOld(path.join(dir, entry), now, maxAgeMs, result);
  }
}

async function cleanupLegacyOutputFiles(
  dir: string,
  now: number,
  maxAgeMs: number,
  result: CleanupResult,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    debugLogger.debug(`Cannot read directory ${dir}:`, error);
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.output')) continue;
    await tryDeleteIfOld(path.join(dir, entry), now, maxAgeMs, result);
  }
}

async function tryDeleteIfOld(
  filePath: string,
  now: number,
  maxAgeMs: number,
  result: CleanupResult,
): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) return;
    if (now - stat.mtimeMs < maxAgeMs) return;

    await fs.unlink(filePath);
    result.filesDeleted++;
    result.bytesFreed += stat.size;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    debugLogger.debug(`Failed to clean up ${filePath}:`, error);
    result.errors++;
  }
}
