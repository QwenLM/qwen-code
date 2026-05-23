/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Checks if a directory is within a git repository
 * @param directory The directory to check
 * @returns true if the directory is in a git repository, false otherwise
 */
export function isGitRepository(directory: string): boolean {
  try {
    let currentDir = path.resolve(directory);

    while (true) {
      const gitDir = path.join(currentDir, '.git');

      // Check if .git exists (either as directory or file for worktrees)
      if (fs.existsSync(gitDir)) {
        return true;
      }

      const parentDir = path.dirname(currentDir);

      // If we've reached the root directory, stop searching
      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }

    return false;
  } catch (_error) {
    // If any filesystem error occurs, assume not a git repo
    return false;
  }
}

/**
 * Finds the root directory of a git repository
 * @param directory Starting directory to search from
 * @returns The git repository root path, or null if not in a git repository
 */
export function findGitRoot(directory: string): string | null {
  try {
    let currentDir = path.resolve(directory);

    while (true) {
      const gitDir = path.join(currentDir, '.git');

      if (fs.existsSync(gitDir)) {
        return currentDir;
      }

      const parentDir = path.dirname(currentDir);

      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }

    return null;
  } catch (_error) {
    return null;
  }
}

/**
 * Gets the current git branch, if in a git repository.
 */
export const getGitBranch = (cwd: string): string | undefined => {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Gets the git repository full name (owner/repo), if in a git repository.
 * Tries to get the name from the remote URL first, then falls back to the directory name.
 */
export const getGitRepoName = (cwd: string): string | undefined => {
  try {
    // Try to get the repository name from the remote URL
    const remoteUrl = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (remoteUrl) {
      // Extract owner/repo from various URL formats:
      // - https://github.com/owner/repo.git -> owner/repo
      // - git@github.com:owner/repo.git -> owner/repo
      // - https://gitlab.com/owner/repo -> owner/repo
      // - https://github.com/owner/repo/extra -> owner/repo (ignore extra path)

      // Handle SSH format: git@host.com:owner/repo.git
      let normalizedUrl = remoteUrl;
      if (remoteUrl.startsWith('git@')) {
        normalizedUrl = remoteUrl.replace(/^git@[^:]+:/, 'https://host.com/');
      }

      try {
        const url = new URL(normalizedUrl);
        // Remove .git suffix and split path
        const pathParts = url.pathname
          .replace(/\.git$/, '')
          .split('/')
          .filter(Boolean);
        if (pathParts.length >= 2) {
          // Return owner/repo format
          return `${pathParts[0]}/${pathParts[1]}`;
        }
      } catch {
        // URL parsing failed, try regex fallback
        const match = remoteUrl.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
        if (match && match[1] && match[2]) {
          return `${match[1]}/${match[2]}`;
        }
      }
    }
  } catch {
    // Fall back to directory name if remote URL is not available
  }

  // Fallback: use the directory name of the git root
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    return path.basename(gitRoot);
  }

  return undefined;
};
