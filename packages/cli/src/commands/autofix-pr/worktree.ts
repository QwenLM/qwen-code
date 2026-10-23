/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The checks every helper that writes from the autofix worktree makes first.

import { existsSync, realpathSync } from 'node:fs';
import { gitOpt, gitProbe } from '../review/lib/git.js';

/**
 * Throws unless `worktreePath` is a git worktree of its own. Inside a
 * directory that is not one, git finds the enclosing clone and would act on
 * that instead.
 */
export function requireWorktree(worktreePath: string, prNumber: number): void {
  if (!existsSync(worktreePath)) {
    throw new Error(
      `${worktreePath} does not exist; run \`qwen autofix-pr prepare ${prNumber} --repo <owner>/<repo>\` to recreate it.`,
    );
  }
  const top = gitOpt('-C', worktreePath, 'rev-parse', '--show-toplevel');
  if (top === null || realpathSync(top) !== realpathSync(worktreePath)) {
    throw new Error(`${worktreePath} is not a git worktree.`);
  }
}

/**
 * Whether the worktree has anything uncommitted, untracked files included
 * whatever `status.showUntrackedFiles` says.
 */
export function hasUncommittedChanges(worktreePath: string): boolean {
  const status = gitOpt(
    '-C',
    worktreePath,
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--ignore-submodules=none',
  );
  if (status === null) throw new Error(`git cannot read ${worktreePath}`);
  return status !== '';
}

/**
 * Whether `ancestor` is an ancestor of (or equal to) `descendant`, asked in
 * the worktree. Exit 1 is git's "no"; anything else means it could not tell.
 */
export function isAncestor(
  worktreePath: string,
  ancestor: string,
  descendant: string,
): boolean {
  const { status } = gitProbe(
    '-C',
    worktreePath,
    'merge-base',
    '--is-ancestor',
    ancestor,
    descendant,
  );
  if (status === 0) return true;
  if (status === 1) return false;
  throw new Error(
    `git cannot compare ${ancestor.slice(0, 12)} with ${descendant.slice(0, 12)} in ${worktreePath}`,
  );
}
