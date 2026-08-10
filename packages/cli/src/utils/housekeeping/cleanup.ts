/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir, stat, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Storage,
  FILE_HISTORY_DIR,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('HOUSEKEEPING');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
// Stays well below typical fd ulimits (256 on macOS, 1024 on Linux) even
// for users with thousands of session dirs accumulated before this PR.
const SWEEP_CONCURRENCY = 20;

export interface CleanupResult {
  removed: number;
  errors: number;
}

export interface CleanupOptions {
  cutoffDate: Date;
  excludeSessionIds?: ReadonlySet<string>;
  removeEmptyRoot?: boolean;
}

export interface SubagentCleanupOptions extends CleanupOptions {
  /** Project-scoped subagents root: `<projectDir>/subagents/`. */
  subagentsRoot: string;
}

export interface OpenAILogCleanupOptions {
  cutoffDate: Date;
  /** Resolved OpenAI log directory (see resolveOpenAILogDir in core). */
  logDir: string;
}

// cleanupPeriodDays = 0 means "minimum retention", not "delete everything
// including the currently-active session". Clamp to 1 hour so an active
// session that wrote a snapshot in the last few minutes is always safe.
//
// Negative values would yield a future cutoff (Date.now() - negative =
// future) and sweep ALL dirs, including the currently-active session.
// The settings schema declares `type: 'number'` without a `minimum`, so
// defend here: any non-positive input falls back to the same 1-hour
// minimum-retention as the documented `0` value.
export function getCutoffDate(cleanupPeriodDays: number): Date {
  const periodMs =
    cleanupPeriodDays > 0 ? cleanupPeriodDays * MS_PER_DAY : MS_PER_HOUR;
  return new Date(Date.now() - periodMs);
}

// Shared session-dir sweeper: removes immediate child dirs of `root` whose
// mtime is older than the cutoff, skipping excluded session ids. Both
// file-history backups and subagent transcripts use the `<root>/<sessionId>/`
// layout, so the same age-based sweep serves both.
async function sweepOldSessionDirs(
  root: string,
  opts: CleanupOptions,
): Promise<CleanupResult> {
  const result: CleanupResult = { removed: 0, errors: 0 };
  const excludes = opts.excludeSessionIds ?? new Set<string>();

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (isENOENT(e)) return result;
    debugLogger.error('readdir failed', e);
    return result;
  }

  const sessionDirs = entries
    .filter((e) => e.isDirectory() && !excludes.has(e.name))
    .map((e) => join(root, e.name));

  // Bounded concurrency: fd ulimit-safe for users with thousands of dirs.
  for (let i = 0; i < sessionDirs.length; i += SWEEP_CONCURRENCY) {
    const batch = sessionDirs.slice(i, i + SWEEP_CONCURRENCY);
    await Promise.all(
      batch.map(async (dir) => {
        try {
          const s = await stat(dir);
          if (s.mtime < opts.cutoffDate) {
            await rm(dir, { recursive: true, force: true });
            result.removed++;
          }
        } catch (err) {
          result.errors++;
          debugLogger.error(`failed to sweep ${dir}`, err);
        }
      }),
    );
  }

  // Sweep empty roots only for Qwen-owned global storage. Project-local roots
  // such as <projectDir>/subagents/ should remain stable for file watchers.
  if (opts.removeEmptyRoot !== false) {
    await rmdir(root).catch(() => {});
  }
  return result;
}

export async function cleanupOldFileHistoryBackups(
  opts: CleanupOptions,
): Promise<CleanupResult> {
  return sweepOldSessionDirs(
    join(Storage.getGlobalQwenDir(), FILE_HISTORY_DIR),
    opts,
  );
}

// Background subagent transcripts live per-project under
// `<projectDir>/subagents/<sessionId>/` — same session-dir layout as
// file-history, but the root is project-scoped (passed in by the caller).
export async function cleanupOldSubagentTranscripts(
  opts: SubagentCleanupOptions,
): Promise<CleanupResult> {
  return sweepOldSessionDirs(opts.subagentsRoot, {
    ...opts,
    removeEmptyRoot: false,
  });
}

// Matches the filenames OpenAILogger writes:
// `openai-<ISO timestamp>[_<diagnostic suffix>].json` — same predicate the
// reader side uses (see packages/cli/src/utils/sessionPaths.ts).
const OPENAI_LOG_FILE_PATTERN = /^openai-.*\.json$/;
// Fast path: the UTC date embedded in the filename avoids one stat() per
// file, which matters for users with hundreds of thousands of accumulated
// logs. Only the boundary day (filename date == cutoff date) still needs an
// mtime check; unparseable names fall back to mtime as well.
const OPENAI_LOG_DATE_PATTERN = /^openai-(\d{4}-\d{2}-\d{2})/;

// OpenAI API logs are flat files in a single dir (default
// `<cwd>/logs/openai/`, or a custom `openAILoggingDir`), so this sweeps
// files rather than session subdirs. The root dir is never removed: the
// default location lives inside the user's project checkout.
export async function cleanupOldOpenAILogs(
  opts: OpenAILogCleanupOptions,
): Promise<CleanupResult> {
  const result: CleanupResult = { removed: 0, errors: 0 };

  let entries;
  try {
    entries = await readdir(opts.logDir, { withFileTypes: true });
  } catch (e) {
    if (isENOENT(e)) return result;
    debugLogger.error('readdir failed', e);
    return result;
  }

  const files = entries
    .filter((e) => e.isFile() && OPENAI_LOG_FILE_PATTERN.test(e.name))
    .map((e) => ({
      filePath: join(opts.logDir, e.name),
      filenameDate: OPENAI_LOG_DATE_PATTERN.exec(e.name)?.[1],
    }));

  const cutoffDay = opts.cutoffDate.toISOString().slice(0, 10);

  for (let i = 0; i < files.length; i += SWEEP_CONCURRENCY) {
    const batch = files.slice(i, i + SWEEP_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ filePath, filenameDate }) => {
        try {
          let shouldRemove: boolean;
          if (filenameDate && filenameDate !== cutoffDay) {
            shouldRemove = filenameDate < cutoffDay;
          } else {
            const s = await stat(filePath);
            shouldRemove = s.mtime < opts.cutoffDate;
          }
          if (shouldRemove) {
            await unlink(filePath);
            result.removed++;
          }
        } catch (err) {
          result.errors++;
          debugLogger.error(`failed to sweep ${filePath}`, err);
        }
      }),
    );
  }
  return result;
}

function isENOENT(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT';
}
