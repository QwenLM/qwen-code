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

const LEASE_PREFIX = 'qwen-review-lease-';

interface ReviewWorktreeLease {
  sessionId: string;
  promptId: string;
  target: string;
  repositoryRoot: string;
  worktreePath: string;
  branch: string;
}

function leaseDirectory(repositoryRoot: string): string {
  return join(repositoryRoot, '.qwen', 'tmp');
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
  } catch {
    return null;
  }
}

function removeLeaseWorktree(lease: ReviewWorktreeLease): boolean {
  const prMatch = /^pr-(\d+)$/.exec(lease.target);
  if (!prMatch || lease.branch !== `qwen-review/pr-${prMatch[1]}`) return false;

  const repositoryRoot = resolve(lease.repositoryRoot);
  const worktreePath = resolve(lease.worktreePath);
  const reviewTmpRoot = resolve(repositoryRoot, '.qwen', 'tmp');
  const worktreeRelative = relative(reviewTmpRoot, worktreePath);
  if (
    worktreeRelative === '' ||
    worktreeRelative.startsWith('..') ||
    isAbsolute(worktreeRelative)
  ) {
    return false;
  }

  try {
    execFileSync(
      'git',
      ['-C', repositoryRoot, 'worktree', 'remove', worktreePath, '--force'],
      { stdio: 'ignore' },
    );
  } catch {
    rmSync(worktreePath, { recursive: true, force: true });
    try {
      execFileSync('git', ['-C', repositoryRoot, 'worktree', 'prune'], {
        stdio: 'ignore',
      });
    } catch {
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
      { stdio: 'ignore' },
    );
  } catch (error) {
    if ((error as { status?: unknown }).status !== 1) return false;
    branchExists = false;
  }
  if (branchExists) {
    try {
      execFileSync(
        'git',
        ['-C', repositoryRoot, 'branch', '-D', lease.branch],
        {
          stdio: 'ignore',
        },
      );
    } catch {
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
  } catch {
    return;
  }
}
