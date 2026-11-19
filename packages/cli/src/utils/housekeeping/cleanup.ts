/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { opendir, readdir, stat, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Storage,
  FILE_HISTORY_DIR,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';

const DEBUG_LOG_FILE_SUFFIX = '.txt';

const debugLogger = createDebugLogger('HOUSEKEEPING');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
// Prevent oversized hand-edited settings from producing an Invalid Date.
const MIN_DATE_MS = -8_640_000_000_000_000;
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

// Deliberately does not extend CleanupOptions: removeEmptyRoot is never
// honored here — the debug root must survive the sweep, because
// debugLogger memoizes its ensure-dir step per path and would silently
// drop the rest of the session's debug output after an rmdir.
export interface DebugLogCleanupOptions {
  cutoffDate: Date;
  excludeSessionIds?: ReadonlySet<string>;
  isValidSessionId: (value: string) => boolean;
}

export interface OpenAILogCleanupOptions {
  cutoffDate: Date;
  /** Resolved OpenAI log directory (see resolveOpenAILogDir in core). */
  logDir: string;
  signal?: AbortSignal;
}

export interface OpenAILogCleanupResult extends CleanupResult {
  completed: boolean;
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
  return new Date(Math.max(Date.now() - periodMs, MIN_DATE_MS));
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

// Match only filenames emitted by OpenAILogger. Custom log directories may
// contain unrelated `openai-*.json` files, so deletion is deliberately
// stricter than the reader-side discovery predicate.
const OPENAI_LOG_FILE_PATTERN =
  /^openai-(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}(?:-[a-zA-Z0-9._](?:[a-zA-Z0-9._-]*[a-zA-Z0-9._])?)?\.json$/;

// OpenAI API logs are flat files in a single dir (default
// `<cwd>/logs/openai/`, or a custom `openAILoggingDir`), so this sweeps
// files rather than session subdirs. The root dir is never removed: the
// default location lives inside the user's project checkout.
export async function cleanupOldOpenAILogs(
  opts: OpenAILogCleanupOptions,
): Promise<OpenAILogCleanupResult> {
  const result: OpenAILogCleanupResult = {
    removed: 0,
    errors: 0,
    completed: true,
  };

  if (opts.signal?.aborted) {
    result.completed = false;
    return result;
  }

  let dir;
  try {
    dir = await opendir(opts.logDir);
  } catch (e) {
    if (isENOENT(e)) return result;
    debugLogger.error('opendir failed', e);
    throw e;
  }

  const cutoffDay = opts.cutoffDate.toISOString().slice(0, 10);
  let batch: Array<Promise<void>> = [];

  for await (const entry of dir) {
    if (opts.signal?.aborted) {
      result.completed = false;
      break;
    }

    const filenameDate = entry.isFile()
      ? OPENAI_LOG_FILE_PATTERN.exec(entry.name)?.[1]
      : undefined;
    if (!filenameDate) continue;

    const filePath = join(opts.logDir, entry.name);
    batch.push(
      (async () => {
        try {
          let shouldRemove: boolean;
          if (filenameDate !== cutoffDay) {
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
          if (isENOENT(err)) return;
          result.errors++;
          debugLogger.error(`failed to sweep ${filePath}`, err);
        }
      })(),
    );
    if (batch.length === SWEEP_CONCURRENCY) {
      await Promise.all(batch);
      batch = [];
    }
  }
  await Promise.all(batch);
  return result;
}

function isENOENT(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT';
}

// Session debug logs live as flat `<sessionId>.txt` files in the shared debug
// dir. Validating the stem skips unrelated files, the `latest` symlink, and
// the independently rotated `daemon/` subdir.
export async function cleanupOldDebugLogs(
  opts: DebugLogCleanupOptions,
): Promise<CleanupResult> {
  const result: CleanupResult = { removed: 0, errors: 0 };
  const root = Storage.getGlobalDebugDir();
  const excludes = opts.excludeSessionIds ?? new Set<string>();

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (isENOENT(e)) return result;
    debugLogger.error('readdir failed', e);
    return result;
  }

  const logFiles = entries.flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(DEBUG_LOG_FILE_SUFFIX)) {
      return [];
    }
    const sessionId = entry.name.slice(0, -DEBUG_LOG_FILE_SUFFIX.length);
    if (!opts.isValidSessionId(sessionId) || excludes.has(sessionId)) {
      return [];
    }
    return [join(root, entry.name)];
  });

  for (let i = 0; i < logFiles.length; i += SWEEP_CONCURRENCY) {
    const batch = logFiles.slice(i, i + SWEEP_CONCURRENCY);
    await Promise.all(
      batch.map(async (filePath) => {
        try {
          const s = await stat(filePath);
          if (s.mtime < opts.cutoffDate) {
            await unlink(filePath);
            result.removed++;
          }
        } catch (err) {
          if (isENOENT(err)) return;
          result.errors++;
          debugLogger.error(`failed to sweep ${filePath}`, err);
        }
      }),
    );
  }

  return result;
}
