/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GeneralCache } from './general-cache.js';

// Cache for git repository checks to avoid repeated filesystem traversals
const gitRepoCache = new GeneralCache<boolean | string | null>(30000); // 30 second TTL

/**
 * Checks if a directory is within a git repository
 * @param directory The directory to check
 * @returns true if the directory is in a git repository, false otherwise
 */
export function isGitRepository(directory: string): boolean {
  const resolvedDir = path.resolve(directory);
  const cacheKey = `isGitRepo:${resolvedDir}`;

  // Check if result is already cached
  const cached = gitRepoCache.get(cacheKey);
  if (cached !== undefined) {
    return cached as boolean;
  }

  try {
    let currentDir = resolvedDir;

    while (true) {
      const gitDir = path.join(currentDir, '.git');

      // Check if .git exists (either as directory or file for worktrees)
      if (fs.existsSync(gitDir)) {
        // Cache the result for this directory and all parent directories
        gitRepoCache.set(cacheKey, true);
        return true;
      }

      const parentDir = path.dirname(currentDir);

      // If we've reached the root directory, stop searching
      if (parentDir === currentDir) {
        // Cache the result for this directory
        gitRepoCache.set(cacheKey, false);
        break;
      }

      currentDir = parentDir;
    }

    return false;
  } catch (_error) {
    // If any filesystem error occurs, assume not a git repo
    // Cache this result as well
    gitRepoCache.set(cacheKey, false);
    return false;
  }
}

/**
 * Finds the root directory of a git repository
 * @param directory Starting directory to search from
 * @returns The git repository root path, or null if not in a git repository
 */
export function findGitRoot(directory: string): string | null {
  const resolvedDir = path.resolve(directory);
  const cacheKey = `gitRoot:${resolvedDir}`;

  // Check if result is already cached
  const cached = gitRepoCache.get(cacheKey);
  if (cached !== undefined) {
    return cached as string | null;
  }

  try {
    let currentDir = resolvedDir;

    while (true) {
      const gitDir = path.join(currentDir, '.git');

      if (fs.existsSync(gitDir)) {
        // Cache the result for this directory
        gitRepoCache.set(cacheKey, currentDir);
        return currentDir;
      }

      const parentDir = path.dirname(currentDir);

      if (parentDir === currentDir) {
        // Cache the result as null since no git root was found
        gitRepoCache.set(cacheKey, null);
        return null;
      }

      currentDir = parentDir;
    }
  } catch (_error) {
    // Cache the error result as null
    gitRepoCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Clear the git repository cache, useful for when directory structures change
 */
export function clearGitCache(): void {
  // Only clear git-related cache entries
  for (const key of gitRepoCache['cache'].keys()) {
    if (key.startsWith('isGitRepo:') || key.startsWith('gitRoot:')) {
      gitRepoCache['cache'].delete(key);
    }
  }
}
