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
import { REVIEW_TMP_DIR, reviewBranch } from '../commands/review/lib/paths.js';

const LEASE_PREFIX = 'qwen-review-lease-';
const GIT_TIMEOUT_MS = 120_000;
const debugLogger = createDebugLogger('REVIEW_WORKTREE_LEASE');

function gitOptions() {
  return {
    stdio: 'ignore' as const,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  };
}

interface ReviewWorktreeLease {
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

export function clearReviewWorktreeLease(
  repositoryRoot: string,
  target: string,
): void {
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
  if (!params.sessionId || !params.promptId) return;

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

function removeLeaseWorktree(lease: ReviewWorktreeLease): boolean {
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
      gitOptions(),
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
        gitOptions(),
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
      gitOptions(),
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
        gitOptions(),
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
      if (removeLeaseWorktree(lease)) {
        rmSync(path, { force: true });
      }
    }
  } catch (error) {
    debugLogger.debug('Failed to clean up review worktree leases:', error);
  }
}
