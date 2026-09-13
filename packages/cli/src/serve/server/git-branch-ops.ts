/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NO_EXEC_CONFIG } from '@qwen-code/qwen-code-core';

const execFileAsync = promisify(execFile);

// Hard timeout for branch git operations. `git checkout -b` takes the
// repository lock; without a bound, a stuck lock or slow hook would hang the
// request and leave the workspace permanently reserved in
// `inFlightBranchWorkspaces`. Mirrors GitWorktreeService's 30s bound.
const GIT_BRANCH_TIMEOUT_MS = 30_000;

export async function branchExists(
  cwd: string,
  name: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      [...NO_EXEC_CONFIG, 'rev-parse', '--verify', `refs/heads/${name}`],
      { cwd, timeout: GIT_BRANCH_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

export async function isDirtyTree(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync(
    'git',
    [
      ...NO_EXEC_CONFIG,
      '--no-optional-locks',
      'status',
      '--porcelain',
      '--untracked-files=no',
    ],
    {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: GIT_BRANCH_TIMEOUT_MS,
    },
  );
  return stdout.trim().length > 0;
}

export async function getHeadCommit(cwd: string): Promise<string | undefined> {
  return execFileAsync('git', [...NO_EXEC_CONFIG, 'rev-parse', 'HEAD'], {
    cwd,
    timeout: GIT_BRANCH_TIMEOUT_MS,
  })
    .then(({ stdout }) => stdout.trim())
    .catch(() => undefined);
}

// A checkout runs the repository's own `post-checkout` hook whatever config it
// is given — `core.hooksPath` is deliberately not emptied, because qwen installs
// it in every worktree it creates — so the guard below narrows these two calls
// rather than sealing them.
export async function createBranch(cwd: string, name: string): Promise<void> {
  await execFileAsync('git', [...NO_EXEC_CONFIG, 'checkout', '-b', name], {
    cwd,
    timeout: GIT_BRANCH_TIMEOUT_MS,
  });
}

export async function checkoutRef(cwd: string, ref: string): Promise<void> {
  await execFileAsync('git', [...NO_EXEC_CONFIG, 'checkout', ref], {
    cwd,
    timeout: GIT_BRANCH_TIMEOUT_MS,
  });
}

export async function deleteBranch(cwd: string, name: string): Promise<void> {
  await execFileAsync('git', [...NO_EXEC_CONFIG, 'branch', '-D', name], {
    cwd,
    timeout: GIT_BRANCH_TIMEOUT_MS,
  });
}
