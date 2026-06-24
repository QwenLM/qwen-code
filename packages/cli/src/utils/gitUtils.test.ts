/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, expect, it, afterEach, beforeEach } from 'vitest';
import * as child_process from 'node:child_process';
import {
  isGitHubRepositoryAsync,
  getGitRepoRootAsync,
  getLatestGitHubRelease,
  getGitHubRepoInfoAsync,
} from './gitUtils.js';

vi.mock('node:child_process');

function mockExecFileStdout(stdout: string): void {
  vi.mocked(child_process.execFile).mockImplementation(((
    _cmd,
    _args,
    _opts,
    cb,
  ) => {
    (cb as (err: Error | null, stdout: string, stderr: string) => void)(
      null,
      stdout,
      '',
    );
    return {} as ReturnType<typeof child_process.execFile>;
  }) as typeof child_process.execFile);
}

function mockExecFileError(error: Error): void {
  vi.mocked(child_process.execFile).mockImplementation(((
    _cmd,
    _args,
    _opts,
    cb,
  ) => {
    (cb as (err: Error, stdout: string, stderr: string) => void)(error, '', '');
    return {} as ReturnType<typeof child_process.execFile>;
  }) as typeof child_process.execFile);
}

describe('isGitHubRepositoryAsync', async () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false if the git command fails', async () => {
    mockExecFileError(new Error('oops'));

    await expect(isGitHubRepositoryAsync()).resolves.toBe(false);
  });

  it.each([
    [
      'non-GitHub remote',
      `origin  https://gitlab.com/owner/repo.git (fetch)
origin  https://gitlab.com/owner/repo.git (push)`,
    ],
    [
      'github.com lookalike host',
      `origin  https://github.com.evil/owner/repo.git (fetch)
origin  https://github.com.evil/owner/repo.git (push)`,
    ],
    [
      'github.com only in path',
      `origin  https://gitlab.com/owner/github.com-mirror.git (fetch)
origin  https://gitlab.com/owner/github.com-mirror.git (push)`,
    ],
    [
      'GitHub SSH lookalike host',
      `origin  git@github.com.evil:owner/repo.git (fetch)
origin  git@github.com.evil:owner/repo.git (push)`,
    ],
  ])('returns false for %s', async (_name, remotes) => {
    mockExecFileStdout(remotes);

    await expect(isGitHubRepositoryAsync()).resolves.toBe(false);
  });

  it.each([
    [
      'HTTPS GitHub remote',
      `origin  https://github.com/sethvargo/gemini-cli (fetch)
origin  https://github.com/sethvargo/gemini-cli (push)`,
    ],
    [
      'GitHub SSH remote',
      `origin  git@github.com:owner/repo.git (fetch)
origin  git@github.com:owner/repo.git (push)`,
    ],
    [
      'GitHub SSH URL remote',
      `origin  ssh://git@github.com/owner/repo.git (fetch)
origin  ssh://git@github.com/owner/repo.git (push)`,
    ],
    [
      'GitHub SSH URL remote with explicit port',
      `origin  ssh://git@github.com:22/owner/repo.git (fetch)
origin  ssh://git@github.com:22/owner/repo.git (push)`,
    ],
  ])('returns true for %s', async (_name, remotes) => {
    mockExecFileStdout(remotes);

    await expect(isGitHubRepositoryAsync()).resolves.toBe(true);
  });

  it('returns true for GitHub remotes without blocking execSync', async () => {
    mockExecFileStdout('origin  https://github.com/owner/repo.git (fetch)\n');

    await expect(isGitHubRepositoryAsync()).resolves.toBe(true);
    expect(child_process.execSync).not.toHaveBeenCalled();
  });
});

describe('getGitHubRepoInfoAsync', async () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws an error if github repo info cannot be determined', async () => {
    mockExecFileError(new Error('oops'));

    await expect(getGitHubRepoInfoAsync()).rejects.toThrowError(/oops/);
  });

  it.each([
    ['empty remote', ''],
    ['non-GitHub SSH URL', 'git@gitlab.com:owner/repo.git'],
    ['non-GitHub HTTPS URL', 'https://gitlab.com/owner/repo.git'],
  ])('throws if owner/repo cannot be determined for %s', async (_name, url) => {
    mockExecFileStdout(url);

    await expect(getGitHubRepoInfoAsync()).rejects.toThrowError(
      /Owner & repo could not be extracted from remote URL/,
    );
  });

  it.each([
    ['plain HTTPS URL', 'https://github.com/owner/repo.git'],
    [
      'classic PAT token',
      'https://ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx@github.com/owner/repo.git',
    ],
    [
      'fine-grained PAT token',
      'https://github_pat_xxxxxxxxxxxxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx@github.com/owner/repo.git',
    ],
    [
      'username:password credentials',
      'https://username:password@github.com/owner/repo.git',
    ],
    [
      'OAuth token credentials',
      'https://oauth2:gho_xxxxxxxxxxxx@github.com/owner/repo.git',
    ],
    [
      'GitHub Actions token credentials',
      'https://x-access-token:ghs_xxxxxxxxxxxx@github.com/owner/repo.git',
    ],
    ['uppercase host', 'https://GITHUB.COM/owner/repo.git'],
    ['mixed case host', 'https://GitHub.Com/owner/repo.git'],
    ['SCP-style SSH URL', 'git@github.com:owner/repo.git'],
    ['SSH URL with explicit port', 'ssh://git@github.com:22/owner/repo.git'],
    ['URL without .git suffix', 'https://github.com/owner/repo'],
  ])('returns owner and repo for %s', async (_name, url) => {
    mockExecFileStdout(url);

    await expect(getGitHubRepoInfoAsync()).resolves.toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('handles repo names containing .git substring', async () => {
    mockExecFileStdout('https://github.com/owner/my.git.repo.git');

    await expect(getGitHubRepoInfoAsync()).resolves.toEqual({
      owner: 'owner',
      repo: 'my.git.repo',
    });
  });

  it('returns the owner and repo without blocking execSync', async () => {
    mockExecFileStdout('git@github.com:owner/repo.git\n');

    await expect(getGitHubRepoInfoAsync()).resolves.toEqual({
      owner: 'owner',
      repo: 'repo',
    });
    expect(child_process.execSync).not.toHaveBeenCalled();
  });
});

describe('getGitRepoRootAsync', async () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws an error if git root cannot be determined', async () => {
    mockExecFileError(new Error('oops'));

    await expect(getGitRepoRootAsync()).rejects.toThrowError(/oops/);
  });

  it('throws an error if git root is empty', async () => {
    mockExecFileStdout('');

    await expect(getGitRepoRootAsync()).rejects.toThrowError(
      /Git repo returned empty value/,
    );
  });

  it('returns the root without blocking execSync', async () => {
    mockExecFileStdout('/path/to/git/repo\n');

    await expect(getGitRepoRootAsync()).resolves.toBe('/path/to/git/repo');
    expect(child_process.execSync).not.toHaveBeenCalled();
  });
});

describe('getLatestRelease', async () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws an error if the fetch fails', async () => {
    global.fetch = vi.fn(() => Promise.reject('nope'));
    await expect(getLatestGitHubRelease()).rejects.toThrowError(
      /Unable to determine the latest/,
    );
  });

  it('throws an error if the fetch does not return a json body', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ foo: 'bar' }),
      } as Response),
    );
    await expect(getLatestGitHubRelease()).rejects.toThrowError(
      /Unable to determine the latest/,
    );
  });

  it('returns the release version', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v1.2.3' }),
      } as Response),
    );
    await expect(getLatestGitHubRelease()).resolves.toBe('v1.2.3');
  });
});
