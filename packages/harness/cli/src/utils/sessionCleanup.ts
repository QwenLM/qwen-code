/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  runLogger,
  sanitizeFilenamePart,
  Storage,
  TOOL_OUTPUTS_DIR,
  type Config,
  deleteSessionArtifactsAsync,
  deleteSubagentTranscriptDirAndArtifactsAsync,
  getTranscriptProjectDir,
  isNodeError,
} from '@qwen-code/core';
import type { Settings, SessionRetentionSettings } from '../config/settings.js';
import { deleteSessionTranscript } from './sessionTranscriptDeletion.js';

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

// Constants
export const DEFAULT_MIN_RETENTION = '1d' as string;
const MIN_MAX_COUNT = 1;
const MULTIPLIERS = {
  h: 60 * 60 * 1000, // hours to ms
  d: 24 * 60 * 60 * 1000, // days to ms
  w: 7 * 24 * 60 * 60 * 1000, // weeks to ms
  m: 30 * 24 * 60 * 60 * 1000, // months (30 days) to ms
};

/**
 * Result of session cleanup operation
 */
export interface CleanupResult {
  disabled: boolean;
  scanned: number;
  deleted: number;
  skipped: number;
  failed: number;
}

interface TranscriptCleanupEntry {
  fileName: string;
  sessionPath: string;
  sessionId: string | null;
  mtime: Date;
  isCurrentSession: boolean;
}

function getSessionIdFromTranscriptFileName(fileName: string): string | null {
  const sessionId = path.basename(fileName, '.jsonl');
  if (!sessionId || sessionId !== sanitizeFilenamePart(sessionId)) {
    return null;
  }

  return sessionId;
}

/**
 * Cleans up associated artifacts (logs, tool-outputs, directory) for a session.
 */
async function cleanupSessionAndSubagentsAsync(
  sessionId: string,
  config: Config,
): Promise<number> {
  const tempDir = config.storage.getProjectTempDir();
  const projectRoot = config.getSessionArtifactProjectRoot();
  const sessionResult = await deleteSessionArtifactsAsync(sessionId, tempDir);
  let failed = sessionResult.failed;
  if (projectRoot) {
    const subagentResult = await deleteSubagentTranscriptDirAndArtifactsAsync(
      projectRoot,
      sessionId,
      tempDir,
    );
    failed += subagentResult.failed;
  }
  return failed;
}

async function scanTranscriptFiles(
  projectRoot: string,
  currentSessionId: string | undefined,
  visit: (entry: TranscriptCleanupEntry) => Promise<void>,
): Promise<{ scanned: number; failed: number }> {
  const projectDir = getTranscriptProjectDir(projectRoot);

  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return { scanned: 0, failed: 0 };
    }
    throw error;
  }

  let scanned = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    const sessionPath = path.join(projectDir, entry.name);
    scanned++;
    try {
      const stat = await fs.stat(sessionPath);
      const sessionId = getSessionIdFromTranscriptFileName(entry.name);
      await visit({
        fileName: entry.name,
        sessionPath,
        sessionId,
        mtime: stat.mtime,
        isCurrentSession: sessionId === currentSessionId,
      });
    } catch (error) {
      if (!isNotFound(error)) {
        failed++;
        runLogger.debug(
          `Failed to inspect transcript ${entry.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return { scanned, failed };
}

/**
 * Runs age-based transcript retention as deferred maintenance.
 */
export async function cleanupExpiredSessions(
  config: Config,
  settings: Settings,
): Promise<CleanupResult> {
  const result: CleanupResult = {
    disabled: false,
    scanned: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
  };

  try {
    // Early exit if cleanup is disabled
    if (!settings.general?.sessionRetention?.enabled) {
      return { ...result, disabled: true };
    }

    const retentionConfig = settings.general.sessionRetention;
    const projectRoot = config.getSessionArtifactProjectRoot();
    if (!projectRoot) {
      return result;
    }

    // Validate retention configuration
    const validationErrorMessage = validateRetentionConfig(
      config,
      retentionConfig,
    );
    if (validationErrorMessage) {
      // Log validation errors to console for visibility
      runLogger.warn(`Session cleanup disabled: ${validationErrorMessage}`);
      return { ...result, disabled: true };
    }

    // Transcript retention is age-only. Avoid touching the transcript
    // directory when the shared retention settings contain only maxCount.
    if (!retentionConfig.maxAge) {
      return result;
    }

    const cutoffTime = Date.now() - parseRetentionPeriod(retentionConfig.maxAge);
    const scanResult = await scanTranscriptFiles(
      projectRoot,
      config.getSessionId(),
      async (transcript) => {
        if (
          transcript.isCurrentSession ||
          transcript.mtime.getTime() >= cutoffTime
        ) {
          return;
        }

        try {
          runLogger.log(
            'transcript.cleanup.delete',
            `current_session=${config.getSessionId()}`,
            `session=${transcript.sessionId ?? 'unknown'}`,
            `file=${transcript.fileName}`,
            'reason=retention',
            `path=${transcript.sessionPath}`,
          );
          const sessionId = transcript.sessionId;
          if (sessionId) {
            await deleteSessionTranscript({
              transcriptStore: config.getTranscriptStore(),
              sessionPath: transcript.sessionPath,
              sessionId,
              sessionArtifactProjectRoot: projectRoot,
              beforeDelete: async () => {
                const artifactFailures = await cleanupSessionAndSubagentsAsync(
                  sessionId,
                  config,
                );
                if (artifactFailures > 0) {
                  throw new Error(
                    `${artifactFailures} associated artifact cleanup operation(s) failed`,
                  );
                }
              },
            });
          } else {
            await config
              .getTranscriptStore()
              .deleteTranscript(transcript.sessionPath);
          }

          if (config.getDebugMode()) {
            runLogger.debug(
              `Deleted transcript session: ${transcript.fileName}`,
            );
          }
          result.deleted++;
        } catch (error) {
          // Ignore ENOENT (file already deleted)
          if (isNotFound(error)) {
            // File already deleted
          } else {
            runLogger.warn(
              `Failed to delete session ${transcript.sessionId ?? transcript.fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
            result.failed++;
          }
        }
      },
    );
    result.scanned = scanResult.scanned;
    result.failed += scanResult.failed;

    result.skipped = result.scanned - result.deleted - result.failed;

    if (config.getDebugMode() && result.deleted > 0) {
      runLogger.debug(
        `Session cleanup: deleted ${result.deleted}, skipped ${result.skipped}, failed ${result.failed}`,
      );
    }
  } catch (error) {
    // Global error handler - don't let cleanup failures break startup
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    runLogger.warn(`Session cleanup failed: ${errorMessage}`);
    result.failed++;
  }

  return result;
}

/**
 * Parses retention period strings like "30d", "7d", "24h" into milliseconds
 * @throws {Error} If the format is invalid
 */
export function parseRetentionPeriod(period: string): number {
  const match = period.match(/^(\d+)([dhwm])$/);
  if (!match) {
    throw new Error(
      `Invalid retention period format: ${period}. Expected format: <number><unit> where unit is h, d, w, or m`,
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  // Reject zero values as they're semantically invalid
  if (value === 0) {
    throw new Error(
      `Invalid retention period: ${period}. Value must be greater than 0`,
    );
  }

  return value * MULTIPLIERS[unit as keyof typeof MULTIPLIERS];
}

/**
 * Validates retention configuration
 */
function validateRetentionConfig(
  config: Config,
  retentionConfig: SessionRetentionSettings,
): string | null {
  if (!retentionConfig.enabled) {
    return 'Retention not enabled';
  }

  // Validate maxAge if provided
  if (retentionConfig.maxAge) {
    let maxAgeMs: number;
    try {
      maxAgeMs = parseRetentionPeriod(retentionConfig.maxAge);
    } catch (error) {
      return (error as Error | string).toString();
    }

    // Enforce minimum retention period
    const minRetention = retentionConfig.minRetention || DEFAULT_MIN_RETENTION;
    let minRetentionMs: number;
    try {
      minRetentionMs = parseRetentionPeriod(minRetention);
    } catch (error) {
      // If minRetention format is invalid, fall back to default
      if (config.getDebugMode()) {
        runLogger.warn(`Failed to parse minRetention: ${error}`);
      }
      minRetentionMs = parseRetentionPeriod(DEFAULT_MIN_RETENTION);
    }

    if (maxAgeMs < minRetentionMs) {
      return `maxAge cannot be less than minRetention (${minRetention})`;
    }
  }

  // maxCount is still accepted because this settings object is shared with
  // count-limited cleanup for non-transcript targets. Transcript JSONL cleanup
  // ignores maxCount and deletes only by maxAge.
  if (retentionConfig.maxCount !== undefined) {
    if (retentionConfig.maxCount < MIN_MAX_COUNT) {
      return `maxCount must be at least ${MIN_MAX_COUNT}`;
    }
  }

  // At least one retention method must be specified
  if (!retentionConfig.maxAge && retentionConfig.maxCount === undefined) {
    return 'Either maxAge or maxCount must be specified';
  }

  return null;
}

/**
 * Result of tool output cleanup operation
 */
export interface ToolOutputCleanupResult {
  disabled: boolean;
  scanned: number;
  deleted: number;
  failed: number;
}

/**
 * Cleans up tool output files based on age and count limits.
 * Uses the same retention settings as session cleanup.
 */
export async function cleanupToolOutputFiles(
  settings: Settings,
  debugMode: boolean = false,
  projectTempDir?: string,
): Promise<ToolOutputCleanupResult> {
  const result: ToolOutputCleanupResult = {
    disabled: false,
    scanned: 0,
    deleted: 0,
    failed: 0,
  };

  try {
    // Early exit if cleanup is disabled
    if (!settings.general?.sessionRetention?.enabled) {
      return { ...result, disabled: true };
    }

    const retentionConfig = settings.general.sessionRetention;
    let tempDir = projectTempDir;
    if (!tempDir) {
      const storage = new Storage(process.cwd());
      await storage.initialize();
      tempDir = storage.getProjectTempDir();
    }
    const toolOutputDir = path.join(tempDir, TOOL_OUTPUTS_DIR);

    // Check if directory exists
    try {
      await fs.access(toolOutputDir);
    } catch (error) {
      if (isNotFound(error)) {
        return result;
      }
      runLogger.warn(
        `Failed to inspect tool output directory: ${error instanceof Error ? error.message : String(error)}`,
      );
      result.failed++;
      return result;
    }

    // Get all entries in the tool-outputs directory
    const entries = await fs.readdir(toolOutputDir, { withFileTypes: true });
    result.scanned = entries.length;

    if (entries.length === 0) {
      return result;
    }

    const files = entries.filter((e) => e.isFile());

    // Get file stats for age-based cleanup (parallel for better performance)
    const fileStatsResults = await Promise.all(
      files.map(async (file) => {
        try {
          const filePath = path.join(toolOutputDir, file.name);
          const stat = await fs.stat(filePath);
          return { name: file.name, mtime: stat.mtime };
        } catch (error) {
          if (!isNotFound(error)) {
            result.failed++;
          }
          runLogger.debug(
            `Failed to stat file ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
          return null;
        }
      }),
    );
    const fileStats = fileStatsResults.filter(
      (f): f is { name: string; mtime: Date } => f !== null,
    );

    // Sort by mtime (oldest first)
    fileStats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

    const now = new Date();
    const filesToDelete: string[] = [];

    // Age-based cleanup: delete files older than maxAge
    if (retentionConfig.maxAge) {
      try {
        const maxAgeMs = parseRetentionPeriod(retentionConfig.maxAge);
        const cutoffDate = new Date(now.getTime() - maxAgeMs);

        for (const file of fileStats) {
          if (file.mtime < cutoffDate) {
            filesToDelete.push(file.name);
          }
        }
      } catch (error) {
        runLogger.debug(
          `Invalid maxAge format, skipping age-based cleanup: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    // Count-based cleanup: after age-based cleanup, if we still have more files
    // than maxCount, delete the oldest ones to bring the count down.
    // This ensures we keep at most maxCount files, preferring newer ones.
    if (retentionConfig.maxCount !== undefined) {
      // Filter out files already marked for deletion by age-based cleanup
      const remainingFiles = fileStats.filter(
        (f) => !filesToDelete.includes(f.name),
      );
      if (remainingFiles.length > retentionConfig.maxCount) {
        // Calculate how many excess files need to be deleted
        const excessCount = remainingFiles.length - retentionConfig.maxCount;
        // remainingFiles is already sorted oldest first, so delete from the start
        for (let i = 0; i < excessCount; i++) {
          filesToDelete.push(remainingFiles[i].name);
        }
      }
    }

    // For now, continue to cleanup individual files in the root tool-outputs dir
    // but also scan and cleanup expired session subdirectories.
    const subdirs = entries.filter(
      (e) => e.isDirectory() && e.name.startsWith('session-'),
    );
    for (const subdir of subdirs) {
      try {
        // Security: Validate that the subdirectory name is a safe filename part
        // and doesn't attempt path traversal.
        if (subdir.name !== sanitizeFilenamePart(subdir.name)) {
          runLogger.debug(
            `Skipping unsafe tool-output subdirectory: ${subdir.name}`,
          );
          continue;
        }

        const subdirPath = path.join(toolOutputDir, subdir.name);
        const stat = await fs.stat(subdirPath);

        let shouldDelete = false;
        if (retentionConfig.maxAge) {
          const maxAgeMs = parseRetentionPeriod(retentionConfig.maxAge);
          const cutoffDate = new Date(now.getTime() - maxAgeMs);
          if (stat.mtime < cutoffDate) {
            shouldDelete = true;
          }
        }

        if (shouldDelete) {
          await fs.rm(subdirPath, { recursive: true, force: true });
          result.deleted++; // Count as one "unit" of deletion for stats
        }
      } catch (error) {
        if (!isNotFound(error)) {
          result.failed++;
        }
        runLogger.debug(`Failed to cleanup subdir ${subdir.name}: ${error}`);
      }
    }

    // Delete the files
    for (const fileName of filesToDelete) {
      try {
        const filePath = path.join(toolOutputDir, fileName);
        await fs.unlink(filePath);
        result.deleted++;
      } catch (error) {
        if (!isNotFound(error)) {
          runLogger.debug(
            `Failed to delete file ${fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
          result.failed++;
        }
      }
    }

    if (debugMode && result.deleted > 0) {
      runLogger.debug(
        `Tool output cleanup: deleted ${result.deleted}, failed ${result.failed}`,
      );
    }
  } catch (error) {
    // Global error handler - don't let cleanup failures break startup
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    runLogger.warn(`Tool output cleanup failed: ${errorMessage}`);
    result.failed++;
  }

  return result;
}

const WEB_FETCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WEB_FETCH_SOURCE_NAME =
  /^webfetch-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.md$/i;

/** Source-only expiry, independent of session retention; startup owns throttling/locking. */
export async function cleanupWebFetchSources(
  configRoot = Storage.getGlobalConfigDir(),
  now = Date.now(),
): Promise<ToolOutputCleanupResult> {
  const result: ToolOutputCleanupResult = {
    disabled: false,
    scanned: 0,
    deleted: 0,
    failed: 0,
  };
  const failure = (error: unknown) => {
    if (isNotFound(error)) return;
    result.failed++;
    runLogger.debug('[WebFetch] source cleanup failed', error);
  };
  // Fixed depth: tmp / project / tool-outputs / session-* / webfetch-UUID.md.
  // Stream metadata only, without following child symlinks or reading page bodies.
  const scan = async (dir: string, depth: number): Promise<void> => {
    try {
      if (!(await fs.lstat(dir)).isDirectory()) return;
      for await (const entry of await fs.opendir(dir)) {
        const entryPath = path.join(dir, entry.name);
        if (depth < 3) {
          if (!entry.isDirectory()) continue;
          if (depth === 1 && entry.name !== TOOL_OUTPUTS_DIR) continue;
          if (
            depth === 2 &&
            (!entry.name.startsWith('session-') ||
              entry.name !== sanitizeFilenamePart(entry.name))
          )
            continue;
          await scan(entryPath, depth + 1);
        } else if (entry.isFile() && WEB_FETCH_SOURCE_NAME.test(entry.name)) {
          result.scanned++;
          try {
            const stat = await fs.lstat(entryPath);
            if (stat.isFile() && stat.mtimeMs < now - WEB_FETCH_RETENTION_MS) {
              await fs.unlink(entryPath);
              result.deleted++;
            }
          } catch (error) {
            failure(error);
          }
        }
      }
    } catch (error) {
      failure(error);
    }
  };
  try {
    // Only the configured root may itself resolve through a symlink.
    await scan(path.join(await fs.realpath(configRoot), 'tmp'), 0);
  } catch (error) {
    failure(error);
  }
  return result;
}
