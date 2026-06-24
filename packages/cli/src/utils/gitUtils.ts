/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as childProcess from 'node:child_process';
import { ProxyAgent } from 'undici';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('GIT');

interface GitCommandOptions {
  cwd?: string;
}

async function runGit(
  args: string[],
  opts: GitCommandOptions = {},
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    childProcess.execFile(
      'git',
      args,
      {
        encoding: 'utf-8',
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(String(stdout ?? '').trim());
      },
    );
  });
}

export const isGitHubRepositoryAsync = async (
  opts: GitCommandOptions = {},
): Promise<boolean> => {
  try {
    const remotes = await runGit(['remote', '-v'], opts);

    return remotes.split('\n').some((line) => {
      const remoteUrl = line.trim().split(/\s+/)[1];
      return remoteUrl ? isGitHubRemoteUrl(remoteUrl) : false;
    });
  } catch (_error) {
    debugLogger.debug(`Failed to get git remote:`, _error);
    return false;
  }
};

function isGitHubRemoteUrl(remoteUrl: string): boolean {
  if (remoteUrl.startsWith('git@github.com:')) {
    return true;
  }
  if (remoteUrl.startsWith('git@')) {
    return false;
  }

  try {
    return new URL(remoteUrl).hostname === 'github.com';
  } catch {
    return false;
  }
}

export const getGitRepoRootAsync = async (
  opts: GitCommandOptions = {},
): Promise<string> => {
  const gitRepoRoot = await runGit(['rev-parse', '--show-toplevel'], opts);

  if (!gitRepoRoot) {
    throw new Error(`Git repo returned empty value`);
  }

  return gitRepoRoot;
};

/**
 * getLatestGitHubRelease returns the release tag as a string.
 * @returns string of the release tag (e.g. "v1.2.3").
 */
export const getLatestGitHubRelease = async (
  proxy?: string,
): Promise<string> => {
  try {
    const controller = new AbortController();

    const endpoint = `https://api.github.com/repos/QwenLM/qwen-code-action/releases/latest`;

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      dispatcher: proxy ? new ProxyAgent(proxy) : undefined,
      signal: AbortSignal.any([AbortSignal.timeout(30_000), controller.signal]),
    } as RequestInit);

    if (!response.ok) {
      throw new Error(
        `Invalid response code: ${response.status} - ${response.statusText}`,
      );
    }

    const releaseTag = (await response.json()).tag_name;
    if (!releaseTag) {
      throw new Error(`Response did not include tag_name field`);
    }
    return releaseTag;
  } catch (_error) {
    debugLogger.debug(
      `Failed to determine latest qwen-code-action release:`,
      _error,
    );
    throw new Error(
      `Unable to determine the latest qwen-code-action release on GitHub.`,
    );
  }
};

export async function getGitHubRepoInfoAsync(
  opts: GitCommandOptions = {},
): Promise<{
  owner: string;
  repo: string;
}> {
  return parseGitHubRepoInfo(
    await runGit(['remote', 'get-url', 'origin'], opts),
  );
}

function parseGitHubRepoInfo(remoteUrl: string): {
  owner: string;
  repo: string;
} {
  // Handle SCP-style SSH URLs (git@github.com:owner/repo.git)
  let urlToParse = remoteUrl;
  if (remoteUrl.startsWith('git@github.com:')) {
    urlToParse = remoteUrl.replace('git@github.com:', '');
  } else if (remoteUrl.startsWith('git@')) {
    // SSH URL for a different provider (GitLab, Bitbucket, etc.)
    throw new Error(
      `Owner & repo could not be extracted from remote URL: ${remoteUrl}`,
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlToParse, 'https://github.com');
  } catch {
    throw new Error(
      `Owner & repo could not be extracted from remote URL: ${remoteUrl}`,
    );
  }

  if (parsedUrl.hostname !== 'github.com') {
    throw new Error(
      `Owner & repo could not be extracted from remote URL: ${remoteUrl}`,
    );
  }

  const parts = parsedUrl.pathname.split('/').filter((part) => part !== '');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Owner & repo could not be extracted from remote URL: ${remoteUrl}`,
    );
  }

  return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
}
