/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isNodeError, runLogger, sessionLogger } from '@qwen-code/core';

const DIAGNOSTIC_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface DiagnosticLogCleanupResult {
  disabled: boolean;
  scannedRuns: number;
  deletedRuns: number;
  scannedSegments: number;
  deletedSegments: number;
  skipped: number;
  failed: number;
}

export interface DiagnosticLogCleanupOptions {
  logsRoot?: string;
  currentRunId?: string;
  now?: Date;
  debugMode?: boolean;
}

interface RunEntry {
  runId: string;
  dirPath: string;
  timestamp: Date;
}

interface SegmentEntry {
  runId: string;
  filePath: string;
  timestamp: Date;
}

interface RunEntryScanResult {
  entries: RunEntry[];
  scanned: number;
  failed: number;
}

interface SegmentEntryScanResult {
  entries: SegmentEntry[];
  scanned: number;
  failed: number;
}

function createResult(): DiagnosticLogCleanupResult {
  return {
    disabled: false,
    scannedRuns: 0,
    deletedRuns: 0,
    scannedSegments: 0,
    deletedSegments: 0,
    skipped: 0,
    failed: 0,
  };
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function resolveLogsRoot(options: DiagnosticLogCleanupOptions): string {
  if (options.logsRoot) {
    return options.logsRoot;
  }
  return path.dirname(path.dirname(sessionLogger.getRunDir()));
}

async function readLatestRunId(logsRoot: string): Promise<string | undefined> {
  try {
    const target = await fs.readlink(path.join(logsRoot, 'latest'));
    const parts = target.split(/[\\/]+/).filter(Boolean);
    return parts.at(-1);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function parseRunTimestamp(runId: string): Date | undefined {
  const match = runId.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})(Z|[+-]\d{2}-\d{2})(?:-|$)/,
  );
  if (!match) {
    return undefined;
  }

  const timezone =
    match[6] === 'Z'
      ? 'Z'
      : `${match[6].slice(0, 3)}:${match[6].slice(4)}`;
  const timestamp = new Date(
    `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}${timezone}`,
  );
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp;
}

async function readRunTimestamp(
  runId: string,
  runDir: string,
): Promise<Date> {
  const timestamp = parseRunTimestamp(runId);
  if (timestamp) {
    return timestamp;
  }
  return (await fs.stat(runDir)).mtime;
}

async function listRunEntries(runsDir: string): Promise<RunEntryScanResult> {
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return {
        entries: [],
        scanned: 0,
        failed: 0,
      };
    }
    throw error;
  }

  const runs: RunEntry[] = [];
  let scanned = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    scanned++;
    const dirPath = path.join(runsDir, entry.name);
    try {
      runs.push({
        runId: entry.name,
        dirPath,
        timestamp: await readRunTimestamp(entry.name, dirPath),
      });
    } catch (error) {
      if (!isNotFound(error)) {
        failed++;
        runLogger.warn(
          `Failed to inspect diagnostic run ${entry.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return { entries: runs, scanned, failed };
}

function isRunProtected(runId: string, protectedRunIds: Set<string>): boolean {
  if (protectedRunIds.has(runId)) {
    return true;
  }

  // DiagnosticLogger appends "-p<PID>" to both run and segment names.
  const match = runId.match(/-p(\d+)$/);
  const pid = match ? Number(match[1]) : undefined;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
    return false;
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    // Only ESRCH confirms exit. Permission/inspection failures must not
    // cause deletion of logs that may still have an active writer.
    if (isNodeError(error) && error.code === 'ESRCH') {
      return false;
    }
  }

  // PID reuse can retain an old run longer; prefer that to deleting live logs.
  protectedRunIds.add(runId);
  return true;
}

function identifyRunsToDelete(
  runs: RunEntry[],
  cutoffTime: number,
  protectedRunIds: Set<string>,
): RunEntry[] {
  return runs.filter(
    (run) =>
      run.timestamp.getTime() < cutoffTime &&
      !isRunProtected(run.runId, protectedRunIds),
  );
}

async function deleteRunDirs(
  runsToDelete: RunEntry[],
  result: DiagnosticLogCleanupResult,
): Promise<void> {
  for (const run of runsToDelete) {
    try {
      await fs.rm(run.dirPath, { recursive: true, force: true });
      result.deletedRuns++;
    } catch (error) {
      result.failed++;
      runLogger.warn(
        `Failed to delete diagnostic run ${run.runId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function listSegmentEntries(
  sessionsDir: string,
): Promise<SegmentEntryScanResult> {
  const segments: SegmentEntry[] = [];
  let scanned = 0;
  let failed = 0;

  async function walk(dir: string): Promise<void> {
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile() || !/\.(jsonl|log)$/.test(entry.name)) {
        continue;
      }
      scanned++;
      const runId = entry.name.replace(/\.(jsonl|log)$/, '');
      try {
        const timestamp = (await fs.stat(entryPath)).mtime;
        segments.push({
          runId,
          filePath: entryPath,
          timestamp,
        });
      } catch (error) {
        if (!isNotFound(error)) {
          failed++;
          runLogger.warn(
            `Failed to inspect diagnostic segment ${entryPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  await walk(sessionsDir);
  return { entries: segments, scanned, failed };
}

function identifySegmentsToDelete(
  segments: SegmentEntry[],
  cutoffTime: number,
  protectedRunIds: Set<string>,
): SegmentEntry[] {
  return segments.filter(
    (segment) =>
      segment.timestamp.getTime() < cutoffTime &&
      !isRunProtected(segment.runId, protectedRunIds),
  );
}

async function deleteSegmentFiles(
  segmentsToDelete: SegmentEntry[],
  result: DiagnosticLogCleanupResult,
): Promise<void> {
  const parentDirs = new Set<string>();
  for (const segment of segmentsToDelete) {
    try {
      await fs.rm(segment.filePath, { force: true });
      parentDirs.add(path.dirname(segment.filePath));
      result.deletedSegments++;
    } catch (error) {
      result.failed++;
      runLogger.warn(
        `Failed to delete diagnostic segment ${segment.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await removeEmptyParents(parentDirs);
}

async function removeEmptyParents(parentDirs: Set<string>): Promise<void> {
  const dirs = [...parentDirs].sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    let current = dir;
    for (let depth = 0; depth < 3; depth++) {
      try {
        await fs.rmdir(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }
}

export async function cleanupDiagnosticLogs(
  options: DiagnosticLogCleanupOptions = {},
): Promise<DiagnosticLogCleanupResult> {
  const result = createResult();
  const now = options.now ?? new Date();

  try {
    const cutoffTime = now.getTime() - DIAGNOSTIC_LOG_RETENTION_MS;

    const logsRoot = resolveLogsRoot(options);
    const runsDir = path.join(logsRoot, 'runs');
    const sessionsDir = path.join(logsRoot, 'sessions');
    const currentRunId = options.currentRunId ?? sessionLogger.getRunId();
    const latestRunId = await readLatestRunId(logsRoot);
    const protectedRunIds = new Set(
      [currentRunId, latestRunId].filter((runId): runId is string => !!runId),
    );

    const runScan = await listRunEntries(runsDir);
    const runs = runScan.entries;
    result.scannedRuns = runScan.scanned;
    result.failed += runScan.failed;

    const runsToDelete = identifyRunsToDelete(
      runs,
      cutoffTime,
      protectedRunIds,
    );
    await deleteRunDirs(runsToDelete, result);

    const segmentScan = await listSegmentEntries(sessionsDir);
    const segments = segmentScan.entries;
    result.scannedSegments = segmentScan.scanned;
    result.failed += segmentScan.failed;

    const segmentsToDelete = identifySegmentsToDelete(
      segments,
      cutoffTime,
      protectedRunIds,
    );
    await deleteSegmentFiles(segmentsToDelete, result);

    result.skipped =
      result.scannedRuns +
      result.scannedSegments -
      result.deletedRuns -
      result.deletedSegments -
      result.failed;

    if (
      options.debugMode &&
      (result.deletedRuns > 0 || result.deletedSegments > 0)
    ) {
      runLogger.debug(
        `Diagnostic log cleanup: deleted runs=${result.deletedRuns}, segments=${result.deletedSegments}, skipped=${result.skipped}, failed=${result.failed}`,
      );
    }
  } catch (error) {
    result.failed++;
    runLogger.warn(
      `Diagnostic log cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return result;
}
