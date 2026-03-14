/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import {
  createDebugLogger,
  GitProviderFactory,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('GIT');

/**
 * Checks if a directory is within a supported git repository (e.g., GitHub, GitLab).
 * @returns true if the directory is in a supported git repository, false otherwise
 */
export const isSupportedGitRepository = (): boolean => {
  try {
    const remotes = (
      execSync('git remote -v', {
        encoding: 'utf-8',
      }) || ''
    ).trim();

    return remotes.includes('github.com') || remotes.includes('gitlab.com');
  } catch (_error) {
    // If any filesystem error occurs, assume not a git repo
    debugLogger.debug(`Failed to get git remote:`, _error);
    return false;
  }
};

/**
 * Checks if a directory is within a git repository hosted on GitHub.
 * @returns true if the directory is in a git repository with a github.com remote, false otherwise
 */
export const isGitHubRepository = (): boolean => {
  try {
    const remotes = (
      execSync('git remote -v', {
        encoding: 'utf-8',
      }) || ''
    ).trim();

    return remotes.includes('github.com');
  } catch (_error) {
    // If any filesystem error occurs, assume not a git repo
    debugLogger.debug(`Failed to get git remote:`, _error);
    return false;
  }
};

/**
 * getGitRepoRoot returns the root directory of the git repository.
 * @returns the path to the root of the git repo.
 * @throws error if the exec command fails.
 */
export const getGitRepoRoot = (): string => {
  const gitRepoRoot = (
    execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
    }) || ''
  ).trim();

  if (!gitRepoRoot) {
    throw new Error(`Git repo returned empty value`);
  }

  return gitRepoRoot;
};

/**
 * getLatestActionRelease returns the release tag for qwen-code-action.
 * @returns string of the release tag (e.g. "v1.2.3").
 */
export const getLatestActionRelease = async (
  proxy?: string,
): Promise<string> => {
  const provider = GitProviderFactory.getProvider('github.com');
  return provider.getLatestRelease('QwenLM', 'qwen-code-action', proxy);
};

/**
 * getGitHubRepoInfo returns the owner and repository for a GitHub repo.
 * @returns the owner and repository of the github repo.
 * @throws error if the exec command fails.
 */
export function getGitHubRepoInfo(): { owner: string; repo: string } {
  const remoteUrl = execSync('git remote get-url origin', {
    encoding: 'utf-8',
  }).trim();

  const provider = GitProviderFactory.getProvider(remoteUrl);
  return provider.getRepoInfo(remoteUrl);
}
