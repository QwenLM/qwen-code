// Copyright 2026 Qwen Team
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import {
  LEASE_PREFIX,
  REVIEW_TMP_DIR,
  reviewBranch,
} from '../commands/review/lib/paths.js';

const GIT_TIMEOUT_MS = 120_000;
const debugLogger = createDebugLogger('REVIEW_WORKTREE_LEASE');

function gitOptions(timeout: number) {
  return {
    stdio: 'ignore' as const,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  };
}

function validTarget(target: string): boolean {
  return /^pr-\d+$/.test(target);
}

export interface ReviewWorktreeLease {
  sessionId: string;
  promptId: string;
  target: string;
  repositoryRoot: string;
  worktreePath: string;
  branch: string;
}

function leaseDirectory(repositoryRoot: string): string {
  return join(repositoryRoot, REVIEW_TMP_DIR);
}

function leasePath(repositoryRoot: string, target: string): string {
  return join(leaseDirectory(repositoryRoot), `${LEASE_PREFIX}${target}.json`);
}

/** Absolute path of the lease file recording who holds a review target. */
export function reviewLeasePath(
  repositoryRoot: string,
  target: string,
): string {
  return leasePath(resolve(repositoryRoot), target);
}

export function clearReviewWorktreeLease(
  repositoryRoot: string,
  target: string,
): void {
  if (!validTarget(target)) return;
  rmSync(leasePath(resolve(repositoryRoot), target), { force: true });
}

export function createReviewWorktreeLease(params: {
  sessionId: string | undefined;
  promptId: string | undefined;
  target: string;
  repositoryRoot: string;
  worktreePath: string;
  branch: string;
}): void {
  if (!params.sessionId || !params.promptId || !validTarget(params.target)) {
    return;
  }

  const repositoryRoot = resolve(params.repositoryRoot);
  const lease: ReviewWorktreeLease = {
    sessionId: params.sessionId,
    promptId: params.promptId,
    target: params.target,
    repositoryRoot,
    worktreePath: resolve(repositoryRoot, params.worktreePath),
    branch: params.branch,
  };
  mkdirSync(leaseDirectory(repositoryRoot), { recursive: true });
  writeFileSync(
    leasePath(repositoryRoot, params.target),
    `${JSON.stringify(lease, null, 2)}\n`,
    'utf8',
  );
}

function readLease(path: string): ReviewWorktreeLease | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ReviewWorktreeLease;
    if (
      typeof value.sessionId !== 'string' ||
      typeof value.promptId !== 'string' ||
      typeof value.target !== 'string' ||
      typeof value.repositoryRoot !== 'string' ||
      typeof value.worktreePath !== 'string' ||
      typeof value.branch !== 'string'
    ) {
      return null;
    }
    return value;
  } catch (error) {
    debugLogger.debug(`Failed to read review lease ${path}:`, error);
    return null;
  }
}

/** The lease currently registered for a review target, or null. */
export function readReviewWorktreeLease(
  repositoryRoot: string,
  target: string,
): ReviewWorktreeLease | null {
  if (!validTarget(target)) return null;
  return readLease(reviewLeasePath(repositoryRoot, target));
}

/**
 * Whether a lease blocks THIS process from taking the target over.
 *
 * The review worktree path is fixed per PR number, so two reviews of the same
 * PR run on top of each other: whichever runs `fetch-pr`'s stale-clean or
 * `cleanup` next removes the other's worktree, branch, and side files mid-run
 * (#9205). The lease doubles as the lock against that — holders compare by
 * SESSION, not prompt: one session reviews a PR across several prompts
 * (rounds, drift restarts), and a later prompt of the same session must be
 * able to re-take what its own earlier prompt leased. A process with no
 * session id cannot prove ownership of anything, so any existing lease blocks
 * it — a bare-terminal `cleanup` must not delete a live session's state.
 */
export function reviewLeaseHeldByAnotherSession(
  lease: ReviewWorktreeLease | null,
): lease is ReviewWorktreeLease {
  if (!lease) return false;
  const sessionId = process.env['QWEN_CODE_SESSION_ID']?.trim();
  return !sessionId || lease.sessionId !== sessionId;
}

function removeLeaseWorktree(
  lease: ReviewWorktreeLease,
  gitTimeout: number,
): boolean {
  const prMatch = /^pr-(\d+)$/.exec(lease.target);
  if (!prMatch || lease.branch !== reviewBranch(prMatch[1])) {
    debugLogger.debug(`Rejected invalid review lease ${lease.target}`);
    return false;
  }

  const repositoryRoot = resolve(lease.repositoryRoot);
  const worktreePath = resolve(lease.worktreePath);
  const reviewTmpRoot = resolve(repositoryRoot, REVIEW_TMP_DIR);
  const worktreeRelative = relative(reviewTmpRoot, worktreePath);
  if (
    worktreeRelative === '' ||
    worktreeRelative.startsWith('..') ||
    isAbsolute(worktreeRelative)
  ) {
    debugLogger.debug(
      `Rejected review lease outside ${REVIEW_TMP_DIR}: ${worktreePath}`,
    );
    return false;
  }

  try {
    execFileSync(
      'git',
      ['-C', repositoryRoot, 'worktree', 'remove', worktreePath, '--force'],
      gitOptions(gitTimeout),
    );
  } catch (error) {
    debugLogger.debug(
      `Git failed to remove review worktree ${lease.target}:`,
      error,
    );
    try {
      rmSync(worktreePath, { recursive: true, force: true });
      execFileSync(
        'git',
        ['-C', repositoryRoot, 'worktree', 'prune'],
        gitOptions(gitTimeout),
      );
    } catch (fallbackError) {
      debugLogger.debug(
        `Fallback failed to remove review worktree ${lease.target}:`,
        fallbackError,
      );
      return false;
    }
  }

  let branchExists = true;
  try {
    execFileSync(
      'git',
      [
        '-C',
        repositoryRoot,
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${lease.branch}`,
      ],
      gitOptions(gitTimeout),
    );
  } catch (error) {
    if ((error as { status?: unknown }).status !== 1) {
      debugLogger.debug(
        `Failed to inspect review branch ${lease.branch}:`,
        error,
      );
      return false;
    }
    branchExists = false;
  }
  if (branchExists) {
    try {
      execFileSync(
        'git',
        ['-C', repositoryRoot, 'branch', '-D', lease.branch],
        gitOptions(gitTimeout),
      );
    } catch (error) {
      debugLogger.debug(
        `Failed to delete review branch ${lease.branch}:`,
        error,
      );
      return false;
    }
  }
  return !existsSync(worktreePath);
}

export function cleanupReviewWorktreeLeases(params: {
  sessionId: string;
  promptId: string;
  repositoryRoot: string;
  gitTimeout?: number;
}): void {
  try {
    const repositoryRoot = resolve(params.repositoryRoot);
    const directory = leaseDirectory(repositoryRoot);
    if (!existsSync(directory)) return;

    for (const entry of readdirSync(directory)) {
      if (!entry.startsWith(LEASE_PREFIX) || !entry.endsWith('.json')) continue;
      const path = join(directory, basename(entry));
      const lease = readLease(path);
      if (
        !lease ||
        lease.sessionId !== params.sessionId ||
        lease.promptId !== params.promptId ||
        resolve(lease.repositoryRoot) !== repositoryRoot
      ) {
        continue;
      }
      if (removeLeaseWorktree(lease, params.gitTimeout ?? GIT_TIMEOUT_MS)) {
        rmSync(path, { force: true });
      }
    }
  } catch (error) {
    debugLogger.debug('Failed to clean up review worktree leases:', error);
  }
}
