/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createDebugLogger } from './debugLogger.js';

const logger = createDebugLogger('PROJECT_ROOT');

/**
 * Walk up from `startDir` looking for the nearest ancestor that contains a
 * `.git` entry, and return that ancestor's path. Returns `null` if no
 * ancestor up to the filesystem root has `.git`.
 *
 * `.git` is a directory in a normal clone but a regular file (containing
 * `gitdir: <path>`) in git worktrees and submodules. Both shapes mark a
 * repo root — this helper accepts either, so callers don't silently break
 * for worktree / submodule users.
 *
 * Symlinks are intentionally not chased: `lstat` reports them as
 * `isSymbolicLink()`, which is neither a directory nor a regular file, so
 * the walk continues past them. That preserves the behavior the previous
 * private copies in `memoryDiscovery.ts` and `memoryImportProcessor.ts`
 * had.
 */
export async function findProjectRoot(
  startDir: string,
): Promise<string | null> {
  let currentDir = path.resolve(startDir);
  while (true) {
    const gitPath = path.join(currentDir, '.git');
    try {
      const stats = await fs.lstat(gitPath);
      if (stats.isDirectory() || stats.isFile()) {
        return currentDir;
      }
    } catch (error: unknown) {
      // ENOENT is the expected case while walking up — don't log it.
      // Tests often mock fs in ways that throw non-ENOENT errors; stay
      // quiet there too.
      const isENOENT =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === 'ENOENT';

      const isTestEnv =
        process.env['NODE_ENV'] === 'test' || process.env['VITEST'];

      if (!isENOENT && !isTestEnv) {
        if (typeof error === 'object' && error !== null && 'code' in error) {
          const fsError = error as { code: string; message: string };
          logger.warn(
            `Error checking for .git at ${gitPath}: ${fsError.message}`,
          );
        } else {
          logger.warn(
            `Non-standard error checking for .git at ${gitPath}: ${String(
              error,
            )}`,
          );
        }
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}
