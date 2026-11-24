/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitEnv, NO_EXEC_CONFIG } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';

const execFileAsync = promisify(execFile);
const debugLogger = createDebugLogger('GIT_BRANCH_OPS');

// Hard timeout for branch git operations. `git checkout -b` takes the
// repository lock; without a bound, a stuck lock or slow hook would hang the
// request and leave the workspace permanently reserved in
// `inFlightBranchWorkspaces`. Mirrors GitWorktreeService's 30s bound.
const GIT_BRANCH_TIMEOUT_MS = 30_000;

// The unborn/fault probe in getHeadCommit is diagnostic: a git that just
// timed out will time out again, so the probe gets a small bound of its
// own instead of re-arming the full budget and doubling the worst case.
const HEAD_FAULT_PROBE_TIMEOUT_MS = 5_000;

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

/**
 * Whether `ancestor` is an ancestor of `descendant` (git merge-base
 * --is-ancestor). False on any git error — callers treat that as "not
 * reconcilable" and refuse, fail-closed.
 */
export async function isCommitAncestor(
  ancestor: string,
  descendant: string,
  cwd: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      [...NO_EXEC_CONFIG, 'merge-base', '--is-ancestor', ancestor, descendant],
      { cwd, timeout: GIT_BRANCH_TIMEOUT_MS, env: gitEnv() },
    );
    return true;
  } catch {
    return false;
  }
}

/** Three-valued ancestry, for guards where "unknown" must not pass as "no". */
export type CommitAncestry = 'ancestor' | 'not-ancestor' | 'unanswerable';

/**
 * Like {@link isCommitAncestor} but distinguishes an answered "not an
 * ancestor" from a probe that could not answer. `merge-base --is-ancestor`
 * exits 0 when `ancestor` is an ancestor of `descendant`, 1 when it is not,
 * and 128 when either object is absent/unreadable (e.g. a pruned base). A
 * boolean collapse maps both 1 and 128 to false, which a "is it behind?"
 * guard would misread as "not behind" and promote on an unanswerable base
 * (R11-14). Callers that must fail closed on an unreadable object use this.
 */
export async function probeCommitAncestry(
  ancestor: string,
  descendant: string,
  cwd: string,
): Promise<CommitAncestry> {
  try {
    await execFileAsync(
      'git',
      [...NO_EXEC_CONFIG, 'merge-base', '--is-ancestor', ancestor, descendant],
      { cwd, timeout: GIT_BRANCH_TIMEOUT_MS, env: gitEnv() },
    );
    return 'ancestor';
  } catch (error) {
    if ((error as { code?: number }).code === 1) return 'not-ancestor';
    return 'unanswerable';
  }
}

export async function getHeadCommit(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [...NO_EXEC_CONFIG, 'rev-parse', 'HEAD'],
      {
        cwd,
        timeout: GIT_BRANCH_TIMEOUT_MS,
        env: gitEnv(),
      },
    );
    return stdout.trim();
  } catch (error) {
    // Callers map undefined to "no commits yet" (an unborn HEAD). That is
    // only true when --verify exits 1; a timeout, an unreadable .git, or a
    // non-repository is an environment fault and must leave a log record
    // instead of silently claiming an empty repository.
    try {
      await execFileAsync(
        'git',
        [...NO_EXEC_CONFIG, 'rev-parse', '--verify', '--quiet', 'HEAD'],
        { cwd, timeout: HEAD_FAULT_PROBE_TIMEOUT_MS, env: gitEnv() },
      );
      debugLogger.warn(
        `getHeadCommit: rev-parse HEAD failed in ${cwd} but --verify succeeded: ${error}`,
      );
    } catch (probeError) {
      if ((probeError as { code?: number }).code !== 1) {
        debugLogger.warn(
          `getHeadCommit: git fault reading HEAD in ${cwd}: ${error}`,
        );
      }
    }
    return undefined;
  }
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
